// Which frames of a selection belong to one bracket. A folder from a shoot holds
// several brackets, and merging frames of different scenes gives nonsense. The
// frames are taken in the order they were shot (capture time, then file order),
// and a new bracket starts where the camera's shot counter starts again (Sony
// numbers the shots of a bracket 1, 2, 3…), where more time passed since the
// previous frame ended than a bracket takes between shots, or where the image
// size changes.

import type { RawFrame } from '../raw/arw.ts';

/** Seconds between the end of one frame and the start of the next, at most, within a bracket. */
const GAP = 3;

/** Capture time in seconds (DateTimeOriginal and SubSecTimeOriginal), NaN when the file has none. */
export function captureTime(frame: RawFrame): number {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(frame.exposure.dateTimeOriginal);
  if (!m) return NaN;
  const [, y, mo, d, hh, mm, ss] = m.map(Number);
  const sub = /^\d+$/.test(frame.exposure.subSecTimeOriginal) ? Number(`0.${frame.exposure.subSecTimeOriginal}`) : 0;
  return Date.UTC(y, mo - 1, d, hh, mm, ss) / 1000 + sub;
}

/** The brackets among `frames`: lists of their indices, in the order shot. */
export function splitBrackets(frames: RawFrame[]): number[][] {
  const order = frames.map((_, i) => i);
  const time = frames.map(captureTime);
  // In the order shot when every file says when; else in file order.
  if (time.every((t) => t === t)) order.sort((a, b) => time[a] - time[b] || a - b);
  const groups: number[][] = [];
  for (const i of order) {
    const group = groups[groups.length - 1];
    const prev = group ? frames[group[group.length - 1]] : null;
    const f = frames[i];
    const restart = prev !== null && f.sequenceNumber !== null && prev.sequenceNumber !== null && f.sequenceNumber <= prev.sequenceNumber;
    const pause = prev !== null && time[i] - captureTime(prev) > prev.exposure.exposureTime + GAP;
    const size = prev !== null && (f.width !== prev.width || f.height !== prev.height);
    if (!group || restart || pause || size) groups.push([i]);
    else group.push(i);
  }
  return groups;
}
