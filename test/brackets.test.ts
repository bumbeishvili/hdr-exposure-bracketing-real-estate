// A selection split into its brackets: by the camera's shot counter starting
// again, by a pause longer than a bracket takes, and by a change of image size —
// two brackets in one folder are never merged into one picture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RawFrame } from '../src/raw/arw.ts';
import { captureTime, splitBrackets } from '../src/analysis/brackets.ts';

function shot(time: string, sub: string, exposureTime: number, sequenceNumber: number | null, width = 7040): RawFrame {
  return { width, height: 4688, sequenceNumber, exposure: { dateTimeOriginal: time, subSecTimeOriginal: sub, exposureTime } } as unknown as RawFrame;
}

test('captureTime reads the capture time to the subsecond', () => {
  assert.equal(captureTime(shot('2026:10:25 10:22:48', '682', 0.05, 1)) - captureTime(shot('2026:10:25 10:22:47', '182', 0.05, 1)), 1.5);
  assert.ok(Number.isNaN(captureTime(shot('', '', 0.05, 1))));
});

test('splitBrackets separates two brackets of a folder, in the order shot', () => {
  // The user's folder: one bracket from a day earlier and one from today, files listed by name.
  const frames = [
    shot('2026:10:24 13:59:52', '750', 1 / 6, 1),
    shot('2026:10:24 13:59:52', '920', 1 / 25, 2),
    shot('2026:10:24 13:59:53', '702', 0.625, 3),
    shot('2026:10:24 13:59:53', '843', 1 / 100, 4),
    shot('2026:10:24 13:59:56', '544', 2.5, 5),
    shot('2026:10:25 10:22:48', '682', 1 / 20, 1),
    shot('2026:10:25 10:22:48', '825', 1 / 80, 2),
    shot('2026:10:25 10:22:49', '198', 1 / 5, 3),
    shot('2026:10:25 10:22:49', '332', 1 / 320, 4),
    shot('2026:10:25 10:22:50', '309', 0.8, 5),
  ];
  assert.deepEqual(splitBrackets(frames), [
    [0, 1, 2, 3, 4],
    [5, 6, 7, 8, 9],
  ]);
  // Listed out of order, the frames still come in the order shot.
  assert.deepEqual(splitBrackets([frames[7], frames[2], frames[5], frames[0]]), [[3, 1], [2, 0]]);
});

test('splitBrackets starts a new bracket where the counter restarts, after a pause, or at another size', () => {
  // Back to back: the counter restarts though the time runs on.
  assert.deepEqual(splitBrackets([shot('2026:10:25 10:00:00', '0', 0.1, 1), shot('2026:10:25 10:00:00', '500', 0.1, 2), shot('2026:10:25 10:00:01', '0', 0.1, 1), shot('2026:10:25 10:00:01', '500', 0.1, 2)]), [
    [0, 1],
    [2, 3],
  ]);
  // No counter: a pause of a minute.
  assert.deepEqual(splitBrackets([shot('2026:10:25 10:00:00', '0', 0.1, null), shot('2026:10:25 10:00:01', '0', 0.1, null), shot('2026:10:25 10:01:00', '0', 0.1, null)]), [[0, 1], [2]]);
  // A long exposure is no pause: the next shot starts when it ends.
  assert.deepEqual(splitBrackets([shot('2026:10:25 10:00:00', '0', 8, null), shot('2026:10:25 10:00:09', '0', 2, null)]), [[0, 1]]);
  // Another image size (an APS-C crop).
  assert.deepEqual(splitBrackets([shot('2026:10:25 10:00:00', '0', 0.1, 1), shot('2026:10:25 10:00:00', '200', 0.1, 2, 4608)]), [[0], [1]]);
  // Without capture times, file order and the counter.
  assert.deepEqual(splitBrackets([shot('', '', 0.1, 1), shot('', '', 0.1, 2), shot('', '', 0.1, 1)]), [[0, 1], [2]]);
});
