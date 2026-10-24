// Runs full-resolution render chunks on a pool of render workers, one chunk
// per idle worker until all are done; inline when nested workers are not
// available.

import { binSource, demosaicSource, renderRows } from '../look/detail.ts';
import type { RenderChunk, RenderReply } from './render.worker.ts';

export interface PoolJob {
  chunk: RenderChunk;
  transfer: Transferable[];
}

/**
 * Renders `count` chunks, built on demand by `make` (so their input slices
 * exist only while in flight), on up to `threads` workers.
 */
export async function renderPool(count: number, threads: number, make: (i: number) => PoolJob, done: (i: number, rgba: Uint8ClampedArray) => void, progress: (rows: number) => void): Promise<void> {
  let workers: Worker[] = [];
  try {
    if (typeof Worker === 'undefined') throw new Error('no nested workers');
    for (let t = 0; t < Math.min(threads, count); t++) workers.push(new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' }));
  } catch {
    workers.forEach((w) => w.terminate());
    workers = [];
  }
  if (!workers.length) {
    for (let i = 0; i < count; i++) {
      const { chunk } = make(i);
      const source = chunk.source === 'rcd' ? demosaicSource(chunk.cfa, chunk.wb) : binSource(chunk.cfa);
      done(i, renderRows(chunk.job, source, chunk.v0, chunk.v1, progress));
    }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let next = 0;
    let finished = 0;
    const stop = (err?: Error): void => {
      workers.forEach((w) => w.terminate());
      if (err) reject(err);
      else resolve();
    };
    const dispatch = (w: Worker): void => {
      if (next >= count) return;
      const { chunk, transfer } = make(next++);
      w.postMessage(chunk, transfer);
    };
    for (const w of workers) {
      w.onmessage = (e: MessageEvent<RenderReply>) => {
        const r = e.data;
        if (r.type === 'rows') progress(r.rows);
        else if (r.type === 'error') stop(new Error(r.message));
        else {
          done(r.id, r.rgba);
          if (++finished === count) stop();
          else dispatch(w);
        }
      };
      w.onerror = (e) => stop(new Error(e.message || 'A render worker failed'));
      dispatch(w);
    }
  });
}
