// A single frame (no bracket) from raw.pixls.us: an A7C II landscape. It is
// rendered as it is, detected as an exterior (daylight, no walls), and starts
// from the camera's own white balance. Download it into
// app-samples/raw.pixls.us/ILCE-7CM2/ to run this.

import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sample = fileURLToPath(new URL('../app-samples/raw.pixls.us/ILCE-7CM2/DSC02429.ARW', import.meta.url));
const shotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));

test.skip(!existsSync(sample), 'needs app-samples/raw.pixls.us/ILCE-7CM2/DSC02429.ARW');

test('a single exterior frame renders with the camera’s exposure and white balance', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(sample);
  const photo = page.getByTestId('simple-canvas');
  await expect(photo).toHaveAttribute('data-state', 'final', { timeout: 120_000 });
  await page.screenshot({ path: join(shotsDir, 'single-1-result.png') });

  // The full-resolution download matches the photo on screen.
  await photo.hover();
  const download = page.waitForEvent('download', { timeout: 180_000 });
  await page.getByTestId('download').click();
  const path = join(shotsDir, 'single-export.jpg');
  await (await download).saveAs(path);
  const exported = await page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${b64}`)).blob());
    return { width: bitmap.width, height: bitmap.height, median: medianOf(bitmap) };
    function medianOf(src: CanvasImageSource): number {
      const c = new OffscreenCanvas(700, 466);
      const g = c.getContext('2d')!;
      g.drawImage(src, 0, 0, c.width, c.height);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const luma: number[] = [];
      for (let i = 0; i < d.length; i += 4) luma.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
      return luma.sort((a, b) => a - b)[luma.length >> 1];
    }
  }, readFileSync(path).toString('base64'));
  expect(exported.width, 'full sensor resolution').toBeGreaterThan(6900);
  const onScreen = await photo.evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const luma: number[] = [];
    for (let i = 0; i < d.length; i += 4 * 5) luma.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    return luma.sort((a, b) => a - b)[luma.length >> 1];
  });
  expect(Math.abs(exported.median - onScreen), `export median ${exported.median.toFixed(0)} vs screen ${onScreen.toFixed(0)}`).toBeLessThan(6);

  await page.getByTestId('advanced-toggle').click();
  await expect(page.getByTestId('scene-exterior')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('wb-camera')).toHaveAttribute('aria-pressed', 'true');
  // Outdoors there are no windows to pull.
  await expect(page.getByTestId('look-window')).toHaveCount(0);
  await page.screenshot({ path: join(shotsDir, 'single-2-advanced.png') });

  // The scene can be overridden; an interior brings the window pull back.
  await page.getByTestId('scene-interior').click();
  await expect(page.getByTestId('scene-interior')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('look-window')).toHaveCount(1);
  await expect(page.getByTestId('inspector')).toContainText('set by you');
  await page.getByTestId('look-reset').click();
  await expect(page.getByTestId('scene-exterior')).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});
