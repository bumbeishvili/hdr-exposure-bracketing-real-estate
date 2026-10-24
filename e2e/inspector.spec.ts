// Drives the inspector with the sample bracket in app-samples/ and checks what a
// user sees against exiftool's reading of the same files. Screenshots land in
// e2e/screenshots/ for visual review.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const samplesDir = fileURLToPath(new URL('../app-samples/', import.meta.url));
const fixturesDir = fileURLToPath(new URL('../test/fixtures/exiftool/', import.meta.url));
const shotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));

const samples = existsSync(samplesDir)
  ? readdirSync(samplesDir)
      .filter((f) => /\.arw$/i.test(f))
      .sort()
  : [];

type Fixture = Record<string, string | number>;
const fixtures = new Map<string, Fixture>(
  readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const fx = (JSON.parse(readFileSync(join(fixturesDir, f), 'utf8')) as Fixture[])[0];
      return [String(fx['System:FileName']), fx];
    }),
);

test.skip(samples.length < 2 || samples.some((f) => !fixtures.has(f)), 'needs a bracket set in app-samples/ with exiftool fixtures');

const shutter = (t: number): string => (t >= 0.3 ? `${Number(t.toFixed(1))} s` : `1/${Math.round(1 / t)} s`);
const parseEv = (text: string): number => Number.parseFloat(text.replace('−', '-'));

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

async function openSamples(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(samples.map((f) => join(samplesDir, f)));
  await expect(page.getByTestId('exposure-table').locator('tbody tr')).toHaveCount(samples.length);
  await expect(page.getByTestId('status')).toContainText('decoded');
}

/** Median luma (0–255) of the viewer canvas, robust to clipped highlights. */
async function medianLuma(canvas: Locator): Promise<number> {
  return canvas.evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const hist = new Array<number>(256).fill(0);
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 7) {
      hist[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
      n++;
    }
    let seen = 0;
    for (let v = 0; v < 256; v++) if ((seen += hist[v]) >= n / 2) return v;
    return 255;
  });
}

test('sorts the bracket by measured exposure and reads levels like exiftool', async ({ page }) => {
  const errors = collectErrors(page);
  mkdirSync(shotsDir, { recursive: true });
  await page.goto('/');
  await expect(page.getByTestId('dropzone')).toBeVisible();
  await page.screenshot({ path: join(shotsDir, '01-empty.png') });

  await openSamples(page);

  const byTime = samples.map((f) => fixtures.get(f)!).sort((a, b) => Number(a['ExifIFD:ExposureTime']) - Number(b['ExifIFD:ExposureTime']));
  const rows = page.getByTestId('exposure-table').locator('tbody tr');
  expect(await rows.locator('[data-col="shutter"]').allTextContents()).toEqual(byTime.map((fx) => shutter(Number(fx['ExifIFD:ExposureTime']))));

  // The camera's bracket offsets are exact; measured EVs must land on them.
  const measured = (await rows.locator('[data-col="measured"]').allTextContents()).map(parseEv);
  const base = byTime.find((fx) => fx['ExifIFD:ExposureCompensation'] === 0)!;
  byTime.forEach((fx, i) => {
    const offset = Number(fx['ExifIFD:ExposureCompensation']) - Number(base['ExifIFD:ExposureCompensation']);
    expect(Math.abs(measured[i] - offset), `${fx['System:FileName']}`).toBeLessThan(0.03);
  });

  await expect(page.getByTestId('inspector-title')).toHaveText(String(base['System:FileName']));
  await expect(page.getByTestId('black-level')).toContainText(String(base['SubIFD:BlackLevel']).split(' ')[0]);
  await expect(page.getByTestId('white-level')).toContainText(String(base['SubIFD:WhiteLevel']));

  const meta = page.getByTestId('metadata-table');
  const cells = async (row: string): Promise<string[]> => meta.locator(`tr[data-row="${row}"] td`).allTextContents();
  const first = fixtures.get(samples[0])!;
  expect(new Set(await cells('CFA'))).toEqual(new Set(['RGGB']));
  expect(new Set(await cells('Bit depth'))).toEqual(new Set([`${first['SubIFD:BitsPerSample']}-bit`]));
  expect(new Set(await cells('Stored size'))).toEqual(new Set([`${first['SubIFD:ImageWidth']} × ${first['SubIFD:ImageHeight']}`]));

  const canvas = page.getByTestId('viewer-canvas');
  expect(await canvas.evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(400);
  expect(await medianLuma(canvas)).toBeGreaterThan(20);

  // Phase 3: the noise model is fitted and shown per CFA channel.
  const noiseRows = page.getByTestId('noise-table').locator('tbody tr');
  await expect(noiseRows).toHaveCount(4);
  const gain = Number(await noiseRows.first().locator('td').first().textContent());
  expect(gain, 'conversion gain in e⁻/DN').toBeGreaterThan(1);
  expect(gain).toBeLessThan(20);

  await page.screenshot({ path: join(shotsDir, '02-loaded.png') });
  await page.screenshot({ path: join(shotsDir, '03-loaded-full.png'), fullPage: true });
  await page.getByTestId('noise-panel').screenshot({ path: join(shotsDir, '06-noise.png') });
  expect(errors).toEqual([]);
});

test('matched mode brings every frame to the base brightness', async ({ page }) => {
  const errors = collectErrors(page);
  await openSamples(page);
  const canvas = page.getByTestId('viewer-canvas');
  const thumbs = page.getByTestId('filmstrip').getByTestId('thumb');
  // The clipping overlay paints blown areas red, which would skew the luma medians.
  await page.keyboard.press('c');
  await expect(page.getByTestId('clip-toggle')).not.toBeChecked();

  const asShot: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    await thumbs.nth(i).click();
    asShot.push(await medianLuma(canvas));
  }
  for (let i = 1; i < asShot.length; i++) expect(asShot[i], 'as shot, brighter frames look brighter').toBeGreaterThanOrEqual(asShot[i - 1]);

  await page.keyboard.press('m');
  await expect(page.getByTestId('mode-matched')).toHaveAttribute('aria-pressed', 'true');
  const matched: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    await thumbs.nth(i).click();
    matched.push(await medianLuma(canvas));
    if (i === 0) await page.screenshot({ path: join(shotsDir, '04-matched-darkest.png') });
  }
  // Frames that are not clipped at the median pixel match within a few code values.
  const unclippedAtMedian = matched.filter((_, i) => asShot[i] < 250);
  const spread = Math.max(...unclippedAtMedian) - Math.min(...unclippedAtMedian);
  expect(spread, `matched medians ${matched.join(', ')}`).toBeLessThanOrEqual(6);
  expect(errors).toEqual([]);
});

test('arrow keys step through frames; histogram has a readout', async ({ page }) => {
  await openSamples(page);
  const title = page.getByTestId('inspector-title');
  const start = await title.textContent();
  await page.keyboard.press('ArrowRight');
  await expect(title).not.toHaveText(start ?? '');
  await page.keyboard.press('ArrowLeft');
  await expect(title).toHaveText(start ?? '');

  const chart = page.getByTestId('inspector').locator('.histogram svg');
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + 20);
  const tip = page.getByTestId('inspector').locator('.histogram .tooltip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('EV');
  await page.screenshot({ path: join(shotsDir, '05-histogram-hover.png'), clip: { x: box.x - 40, y: box.y - 120, width: box.width + 80, height: box.height + 260 } });
});
