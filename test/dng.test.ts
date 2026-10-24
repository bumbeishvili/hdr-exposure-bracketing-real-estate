// Phase 6 check: the DNG writer's output read back with the app's own TIFF
// reader — DNG tags, CFA layout, half-float samples within half precision of
// the merged data — and the Exif block of exported JPEGs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TiffReader, type Ifd } from '../src/raw/tiff.ts';
import { toHalf, writeDng, type DngInput } from '../src/raw/dng.ts';
import { exifSegment, insertSegment } from '../src/raw/jpeg-exif.ts';
import type { Matrix3 } from '../src/color/dcp.ts';

/** Half-precision bits → number. */
function fromHalf(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  return e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15);
}

test('half floats round to nearest and saturate', () => {
  assert.equal(toHalf(1), 0x3c00);
  assert.equal(toHalf(0.5), 0x3800);
  assert.equal(toHalf(2), 0x4000);
  assert.equal(toHalf(65504), 0x7bff);
  assert.equal(toHalf(1e9), 0x7bff);
  assert.equal(toHalf(2 ** -24), 1);
  assert.equal(toHalf(2 ** -14), 0x400);
  assert.equal(toHalf(0), 0);
  assert.equal(toHalf(-3), 0);
  assert.equal(toHalf(NaN), 0);
  for (const x of [1e-5, 3.3e-4, 0.0123, 0.4567, 1.2345, 6.2, 123.4, 4000.5]) {
    const back = fromHalf(toHalf(x));
    assert.ok(Math.abs(back - x) <= x * 2 ** -11 + 2 ** -25, `${x} → ${back}`);
  }
});

const CM1: Matrix3 = [0.8784, -0.4791, 0.1177, -0.3468, 1.0693, 0.3213, 0.0009, 0.0507, 0.7395];
const CM2: Matrix3 = [0.746, -0.2365, -0.0588, -0.5687, 1.3442, 0.2474, -0.0624, 0.1156, 0.6584];

function input(): DngInput {
  const width = 64;
  const height = 48;
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = ((i * 7919) % 1000) * 30; // up to ~2× the white level
  const rgb = new Uint8Array(8 * 6 * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 37) & 255;
  return {
    width,
    height,
    data,
    white: 15871,
    cfaColors: [0, 1, 1, 2],
    make: 'SONY',
    model: 'ILCE-7CM2',
    uniqueCameraModel: 'Sony ILCE-7CM2',
    orientation: 1,
    profile: { illuminant1: 17, illuminant2: 21, colorMatrix1: CM1, colorMatrix2: CM2, forwardMatrix1: null, forwardMatrix2: null },
    asShotNeutral: [0.4, 1, 0.65],
    preview: { width: 8, height: 6, rgb },
    exif: { exposureTime: [1, 6], fNumber: 8, iso: 100, focalLength: 35, dateTimeOriginal: '2026:10:24 13:59:52', lensModel: 'FE 35mm F1.4 GM' },
    software: 'test',
    originalRawFileName: 'DSC03495_1.ARW',
  };
}

test('writes a DNG 1.4 with a preview IFD0 and a float CFA SubIFD', async () => {
  const src = input();
  const bytes = new Uint8Array(await writeDng(src).arrayBuffer());
  const { reader, firstIfd } = TiffReader.open(bytes);
  const ifd0 = reader.readIfd(firstIfd);
  const get = (ifd: Ifd, tag: number) => {
    const e = ifd.entries.get(tag);
    assert.ok(e, `tag ${tag}`);
    return e;
  };
  assert.equal(reader.value(get(ifd0, 254)), 1, 'IFD0 is the reduced-resolution preview');
  assert.deepEqual(reader.values(get(ifd0, 50706)), [1, 4, 0, 0]);
  assert.deepEqual(reader.values(get(ifd0, 50707)), [1, 4, 0, 0], 'float data needs a 1.4 reader');
  assert.equal(reader.string(get(ifd0, 50708)), 'Sony ILCE-7CM2');
  reader.values(get(ifd0, 50721)).forEach((v, i) => assert.ok(Math.abs(v - CM1[i]) < 1e-6));
  reader.values(get(ifd0, 50722)).forEach((v, i) => assert.ok(Math.abs(v - CM2[i]) < 1e-6));
  assert.deepEqual(reader.values(get(ifd0, 50728)), [0.4, 1, 0.65]);
  assert.equal(reader.value(get(ifd0, 50778)), 17);
  assert.equal(reader.value(get(ifd0, 50779)), 21);
  assert.equal(reader.string(get(ifd0, 50827)), 'DSC03495_1.ARW');
  const preview = bytes.subarray(reader.value(get(ifd0, 273)), reader.value(get(ifd0, 273)) + reader.value(get(ifd0, 279)));
  assert.deepEqual([...preview], [...src.preview.rgb]);

  const exif = reader.readIfd(reader.value(get(ifd0, 34665)));
  assert.deepEqual(reader.rational(get(exif, 33434)), [1, 6]);
  assert.equal(reader.value(get(exif, 34855)), 100);
  assert.equal(reader.string(get(exif, 42036)), 'FE 35mm F1.4 GM');

  const raw = reader.readIfd(reader.value(get(ifd0, 330)));
  assert.equal(reader.value(get(raw, 254)), 0);
  assert.equal(reader.value(get(raw, 256)), src.width);
  assert.equal(reader.value(get(raw, 257)), src.height);
  assert.equal(reader.value(get(raw, 258)), 16);
  assert.equal(reader.value(get(raw, 262)), 32803, 'CFA');
  assert.equal(reader.value(get(raw, 339)), 3, 'IEEE float');
  assert.equal(reader.value(get(raw, 50717)), 1, 'white is 1.0');
  assert.deepEqual(reader.values(get(raw, 33421)), [2, 2]);
  assert.deepEqual(reader.values(get(raw, 33422)), [0, 1, 1, 2]);
  const at = reader.value(get(raw, 273));
  assert.equal(reader.value(get(raw, 279)), src.width * src.height * 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset + at, src.width * src.height * 2);
  for (let i = 0; i < src.data.length; i += 37) {
    const v = fromHalf(view.getUint16(2 * i, true));
    const want = src.data[i] / src.white;
    assert.ok(Math.abs(v - want) <= want * 2 ** -11 + 2 ** -24, `sample ${i}: ${v} vs ${want}`);
  }
});

test('JPEG Exif: camera, exposure and sRGB, inserted after JFIF', async () => {
  const segment = exifSegment({
    make: 'SONY',
    model: 'ILCE-7CM2',
    software: 'test',
    width: 6780,
    height: 4520,
    dateTimeOriginal: '2026:10:24 13:59:52',
    exposureTime: [1, 6],
    fNumber: 8,
    iso: 100,
    focalLength: 35,
    lensModel: 'FE 35mm F1.4 GM',
  });
  assert.deepEqual([...segment.subarray(0, 2)], [0xff, 0xe1]);
  assert.equal((segment[2] << 8) | segment[3], segment.length - 2);
  assert.equal(String.fromCharCode(...segment.subarray(4, 8)), 'Exif');
  const { reader, firstIfd } = TiffReader.open(segment.subarray(10));
  const ifd0 = reader.readIfd(firstIfd);
  assert.equal(reader.string(ifd0.entries.get(271)!), 'SONY');
  assert.equal(reader.string(ifd0.entries.get(272)!), 'ILCE-7CM2');
  const exif = reader.readIfd(reader.value(ifd0.entries.get(34665)!));
  assert.equal(reader.value(exif.entries.get(40961)!), 1, 'ColorSpace sRGB');
  assert.equal(reader.value(exif.entries.get(40962)!), 6780);
  assert.deepEqual(reader.rational(exif.entries.get(33434)!), [1, 6]);
  assert.equal(reader.value(exif.entries.get(33437)!), 8);
  assert.equal(reader.string(exif.entries.get(42036)!), 'FE 35mm F1.4 GM');

  // SOI, a 16-byte JFIF APP0, EOI.
  const app0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const jpeg = new Blob([new Uint8Array([0xff, 0xd8, ...app0, 0xff, 0xd9])]);
  const out = new Uint8Array(await (await insertSegment(jpeg, segment)).arrayBuffer());
  assert.deepEqual([...out.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...out.subarray(2, 2 + app0.length)], app0);
  assert.deepEqual([...out.subarray(2 + app0.length, 4 + app0.length)], [0xff, 0xe1]);
  assert.deepEqual([...out.subarray(out.length - 2)], [0xff, 0xd9]);
  assert.equal(out.length, 4 + app0.length + segment.length);
});
