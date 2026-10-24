// Renders a range of full-resolution output rows (detail.ts) for the pipeline
// worker, which splits an export across several of these.

import { binSource, demosaicSource, renderRows, type CfaRows, type DetailJob } from '../look/detail.ts';

export interface RenderChunk {
  id: number;
  job: DetailJob;
  /** The CFA rows this chunk reads (a slice of the merged image). */
  cfa: CfaRows;
  /** 'rcd': full resolution, demosaiced; 'bin': half resolution, one pixel per Bayer quad. */
  source: 'rcd' | 'bin';
  /** White balance for demosaicing (camera RGB multipliers). */
  wb: [number, number, number];
  v0: number;
  v1: number;
}

export type RenderReply = { id: number; type: 'rows'; rows: number } | { id: number; type: 'done'; rgba: Uint8ClampedArray } | { id: number; type: 'error'; message: string };

const scope = self as unknown as Worker;
const post = (reply: RenderReply, transfer: Transferable[] = []): void => scope.postMessage(reply, transfer);

scope.onmessage = (e: MessageEvent<RenderChunk>) => {
  const { id, job, cfa, source, wb, v0, v1 } = e.data;
  try {
    const rows = source === 'rcd' ? demosaicSource(cfa, wb) : binSource(cfa);
    const rgba = renderRows(job, rows, v0, v1, (n) => post({ id, type: 'rows', rows: n }));
    post({ id, type: 'done', rgba }, [rgba.buffer]);
  } catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
