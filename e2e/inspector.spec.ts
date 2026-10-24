// Drives the app with the sample bracket in app-samples/: the minimal result
// page and its full-resolution download, then the workspace behind it, checked
// against exiftool's reading of the same files. Screenshots land in
// e2e/screenshots/ for visual review.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TiffReader } from '../src/raw/tiff.ts';

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

/** Opens the samples and switches to the workspace behind the result page. */
async function openSamples(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(samples.map((f) => join(samplesDir, f)));
  await page.getByTestId('advanced-toggle').click();
  await expect(page.getByTestId('exposure-table').locator('tbody tr')).toHaveCount(samples.length);
  await expect(page.getByTestId('status')).toContainText('decoded');
}

/** Pixel size from a JPEG's start-of-frame marker. */
function jpegSize(path: string): { width: number; height: number } {
  const b = readFileSync(path);
  for (let i = 2; i < b.length - 9; ) {
    if (b[i] !== 0xff) throw new Error('bad JPEG marker');
    const marker = b[i + 1];
    const length = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  throw new Error('no SOF marker');
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

test('the result page is just the photo, and downloads it at full resolution', async ({ page }) => {
  const errors = collectErrors(page);
  mkdirSync(shotsDir, { recursive: true });
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(samples.map((f) => join(samplesDir, f)));
  const photo = page.getByTestId('simple-canvas');
  await expect(photo).toHaveAttribute('data-state', 'final', { timeout: 120_000 });
  expect(await medianLuma(photo), 'bright & airy').toBeGreaterThan(140);

  // Nothing but the photo and one button for the workspace: no text, legends or filters.
  await page.mouse.move(4, 4);
  const visible = await page.evaluate(() =>
    [...document.querySelectorAll('button, a, input, select, label, h1, h2, h3, p, table')]
      .filter((e) => e.checkVisibility({ opacityProperty: true }) && e.getBoundingClientRect().width > 0)
      .map((e) => e.getAttribute('data-testid') ?? e.tagName),
  );
  expect(visible).toEqual(['advanced-toggle']);
  expect((await page.evaluate(() => document.body.innerText)).trim()).toBe('');
  await page.screenshot({ path: join(shotsDir, '00-result.png') });

  // Hovering the photo offers the download: the full-resolution JPEG, not a preview.
  await photo.hover();
  await expect(page.getByTestId('download')).toBeVisible();
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByTestId('download').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/-HDR\.jpg$/);
  const path = join(shotsDir, 'export-full.jpg');
  await file.saveAs(path);
  const size = jpegSize(path);
  expect(size.width, 'full sensor resolution, Upright crop at native scale').toBeGreaterThan(6500);
  expect(size.height).toBeGreaterThan(4300);
  expect(Math.abs(size.width / size.height - 1.5)).toBeLessThan(0.01);
  expect(statSync(path).size, 'maximum JPEG quality').toBeGreaterThan(8e6);
  await expect(page.getByTestId('download')).toHaveAttribute('data-exported', `${size.width}x${size.height}`);
  expect(errors).toEqual([]);
});

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

  // The finished look opens first; the base frame's own readout is one click away.
  await expect(page.getByTestId('inspector-title')).toHaveText('Final');
  await page.locator(`[data-testid="thumb"][data-file="${base['System:FileName']}"]`).click();
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
  await thumbs.first().click();
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

test('merges the bracket without seams and shows where each frame contributes', async ({ page }) => {
  const errors = collectErrors(page);
  await openSamples(page);
  await page.getByTestId('thumb-merged').click();
  await expect(page.getByTestId('thumb-merged')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('viewer-canvas')).toHaveAttribute('data-file', 'merged');
  expect(await medianLuma(page.getByTestId('viewer-canvas'))).toBeGreaterThan(20);

  // Phase 4 check: every frame aligned, nothing left clipped, no step at any hand-off.
  await expect(page.getByTestId('alignment-table').locator('tbody tr')).toHaveCount(samples.length);
  await expect(page.getByTestId('kpi-clipped')).toHaveText('0.000%');
  const steps = (await page.getByTestId('seam-table').locator('tbody tr td.strong').allTextContents()).map(parseEv);
  expect(steps.length).toBe(samples.length - 1);
  for (const s of steps) expect(Math.abs(s), `seam step ${s}%`).toBeLessThan(0.5);

  await page.screenshot({ path: join(shotsDir, '07-merged.png') });
  await page.keyboard.press('s');
  await expect(page.getByTestId('source-legend')).toBeVisible();
  await page.getByTestId('viewer-canvas').screenshot({ path: join(shotsDir, '08-merged-sources.png') });
  await page.keyboard.press('s');
  await page.getByTestId('tone-linear').click();
  await page.getByTestId('viewer-canvas').screenshot({ path: join(shotsDir, '09-merged-linear.png') });
  await page.getByTestId('merge-panel').screenshot({ path: join(shotsDir, '10-merge-panel.png') });

  // Deghosting is on and reports what it found; turning it off merges again without it.
  await expect(page.getByTestId('deghost-toggle')).toBeChecked();
  await expect(page.getByTestId('deghost-summary')).toContainText(/Frames disagreed|No moving objects/);
  await page.keyboard.press('g');
  await expect(page.getByTestId('ghost-toggle')).toBeChecked();
  await page.getByTestId('deghost-toggle').uncheck();
  await expect(page.getByTestId('deghost-summary')).toContainText('Off', { timeout: 120_000 });
  await expect(page.getByTestId('thumb-merged')).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

test('100% view demosaics the merged image with RCD on demand', async ({ page }) => {
  const errors = collectErrors(page);
  await openSamples(page);
  await page.getByTestId('thumb-merged').click();
  const canvas = page.getByTestId('viewer-canvas');
  await expect(canvas).toHaveAttribute('data-file', 'merged');
  const box = (await canvas.boundingBox())!;
  // Curtain hem and bed edge: the sharpest part of this frame (focus was set on the left side).
  await page.mouse.click(box.x + box.width * 0.24, box.y + box.height * 0.74);
  await expect(canvas).toHaveAttribute('data-view', 'crop');
  await expect(canvas).toHaveAttribute('data-algorithm', 'rcd');
  expect(await canvas.evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(300);
  expect(await medianLuma(canvas)).toBeGreaterThan(10);
  await canvas.screenshot({ path: join(shotsDir, '11-crop-rcd.png') });

  await page.getByTestId('demosaic-bilinear').click();
  await expect(canvas).toHaveAttribute('data-algorithm', 'bilinear');
  await canvas.screenshot({ path: join(shotsDir, '12-crop-bilinear.png') });

  await page.getByTestId('zoom-fit').click();
  await expect(canvas).toHaveAttribute('data-view', 'fit');
  expect(errors).toEqual([]);
});

test('final look renders a bright real-estate image and exports a JPEG', async ({ page }) => {
  const errors = collectErrors(page);
  await openSamples(page);
  await expect(page.getByTestId('thumb-final')).toHaveAttribute('aria-selected', 'true');
  const canvas = page.getByTestId('viewer-canvas');
  await expect(canvas).toHaveAttribute('data-file', 'final');
  await expect(page.getByTestId('look-status')).toContainText(/(preview|display|sharp) in/);
  // Bright & airy: the median of the rendered frame sits well above mid-grey.
  const median = await medianLuma(canvas);
  expect(median, 'final look median luma').toBeGreaterThan(140);
  await page.screenshot({ path: join(shotsDir, '13-final.png') });

  // Before/after toggles the view.
  await page.keyboard.press('b');
  await expect(canvas).toHaveAttribute('data-file', 'merged');
  await page.screenshot({ path: join(shotsDir, '14-before.png') });
  await page.keyboard.press('b');
  await expect(canvas).toHaveAttribute('data-file', 'final');

  // A brightness change re-renders darker.
  await page.getByTestId('look-brightness').fill('-0.5');
  await expect(page.getByTestId('look-brightness-value')).toHaveText('−0.50');
  await expect.poll(async () => medianLuma(canvas), { timeout: 30_000 }).toBeLessThan(median - 15);
  await page.getByTestId('look-reset').click();

  // Upright finds the camera tilt and is on by default; turning it off changes the frame.
  await expect(page.getByTestId('inspector')).toContainText('camera tilted');
  await expect(page.getByTestId('look-upright')).toBeChecked();
  const straight = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
  await page.getByTestId('look-upright').uncheck();
  await expect.poll(async () => canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL()), { timeout: 30_000 }).not.toBe(straight);
  await page.getByTestId('look-upright').check();

  // Picking a white patch switches the white balance to custom.
  await page.getByTestId('pick-white').click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.88, box.y + box.height * 0.2);
  await expect(page.getByTestId('wb-auto')).toHaveAttribute('aria-pressed', 'false');

  // Lens corrections are on (the files carry Sony's correction data); turning them off changes the crop.
  await expect(page.getByTestId('look-lens')).toBeChecked();
  await expect(page.getByTestId('inspector')).toContainText('vignetting');
  const sizeMenu = page.getByTestId('export-size');
  const withLens = await sizeMenu.locator('option').first().textContent();
  await page.getByTestId('look-lens').uncheck();
  await expect.poll(async () => sizeMenu.locator('option').first().textContent(), { timeout: 30_000 }).not.toBe(withLens);
  await page.getByTestId('look-lens').check();

  // Half-size JPEG export.
  await sizeMenu.selectOption('half');
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByTestId('export-jpeg').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/-HDR\.jpg$/);
  await file.saveAs(join(shotsDir, 'export-half.jpg'));
  await expect(page.getByTestId('export-status')).toContainText('Exported');
  const half = jpegSize(join(shotsDir, 'export-half.jpg'));
  expect(half.width).toBeGreaterThan(3200);
  expect(half.width).toBeLessThan(3600);

  // The float DNG: a valid TIFF with the merged CFA in a SubIFD.
  const dngDownload = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByTestId('export-dng').click();
  const dng = await dngDownload;
  expect(dng.suggestedFilename()).toMatch(/-HDR\.dng$/);
  await dng.saveAs(join(shotsDir, 'export.dng'));
  const { reader, firstIfd } = TiffReader.open(new Uint8Array(readFileSync(join(shotsDir, 'export.dng'))));
  const ifd0 = reader.readIfd(firstIfd);
  expect(reader.values(ifd0.entries.get(50706)!)).toEqual([1, 4, 0, 0]);
  const raw = reader.readIfd(reader.value(ifd0.entries.get(330)!));
  expect(reader.value(raw.entries.get(339)!), 'floating point').toBe(3);
  const [cropWidth, cropHeight] = String(fixtures.get(samples[0])!['SubIFD:DefaultCropSize']).split(' ').map(Number);
  expect([reader.value(raw.entries.get(256)!), reader.value(raw.entries.get(257)!)], 'the camera’s full image area').toEqual([cropWidth, cropHeight]);
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

  await page.getByTestId('filmstrip').getByTestId('thumb').first().click();
  const chart = page.getByTestId('inspector').locator('.histogram svg');
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + 20);
  const tip = page.getByTestId('inspector').locator('.histogram .tooltip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('EV');
  await page.screenshot({ path: join(shotsDir, '05-histogram-hover.png'), clip: { x: box.x - 40, y: box.y - 120, width: box.width + 80, height: box.height + 260 } });
});
