// Phase 1 check: the reader agrees with exiftool on every sample frame.
// Fixtures come from `npm run fixtures:exif`; frames whose ARW is absent are skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readArw, UnsupportedRawError } from '../src/raw/arw.ts';
import { SONY_RELEASE_MODES } from '../src/raw/sony.ts';

const SAMPLES = new URL('../app-samples/', import.meta.url);
const FIXTURES = new URL('./fixtures/exiftool/', import.meta.url);

type Fixture = Record<string, string | number>;

const list = (v: string | number): number[] => String(v).split(' ').map(Number);

for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort()) {
  const fx = (JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as Fixture[])[0];
  const file = String(fx['System:FileName']);
  const path = new URL(file, SAMPLES);
  const present = existsSync(path);

  test(`${file}: matches exiftool`, { skip: present ? false : `${file} not in app-samples/` }, () => {
    const frame = readArw(readFileSync(path), file);

    assert.equal(frame.make, fx['IFD0:Make']);
    assert.equal(frame.model, fx['IFD0:Model']);
    assert.equal(frame.software, fx['IFD0:Software']);
    assert.equal(frame.orientation, fx['IFD0:Orientation']);

    assert.equal(frame.width, fx['SubIFD:ImageWidth']);
    assert.equal(frame.height, fx['SubIFD:ImageHeight']);
    assert.equal(frame.bitsPerSample, fx['SubIFD:BitsPerSample']);
    assert.equal(frame.compression, fx['SubIFD:Compression']);
    assert.equal(frame.cfa.length, frame.width * frame.height);

    assert.deepEqual([frame.cfaPattern.height, frame.cfaPattern.width], list(fx['SubIFD:CFARepeatPatternDim']));
    assert.deepEqual(frame.cfaPattern.colors, list(fx['SubIFD:CFAPattern2']));

    assert.deepEqual(frame.blackLevel, list(fx['SubIFD:BlackLevel']));
    assert.equal(frame.whiteLevel, fx['SubIFD:WhiteLevel']);
    assert.deepEqual(frame.asShotWb, list(fx['SubIFD:WB_RGGBLevels']));
    assert.deepEqual([frame.crop.left, frame.crop.top], list(fx['SubIFD:DefaultCropOrigin']));
    assert.deepEqual([frame.crop.width, frame.crop.height], list(fx['SubIFD:DefaultCropSize']));

    const sr2 = frame.sr2;
    assert.ok(sr2, 'SR2 block decoded');
    assert.equal(sr2.offset, fx['SR2:SR2SubIFDOffset']);
    assert.equal(sr2.length, fx['SR2:SR2SubIFDLength']);
    assert.equal(sr2.key, fx['SR2:SR2SubIFDKey']);
    assert.deepEqual(sr2.tags.get(0x7310), list(fx['SR2SubIFD:BlackLevel']));
    assert.deepEqual(sr2.tags.get(0x7313), list(fx['SR2SubIFD:WB_RGGBLevels']));
    assert.deepEqual(sr2.tags.get(0x7312), list(fx['SR2SubIFD:WB_RGGBLevelsAuto']));
    assert.deepEqual(sr2.tags.get(0x7800), list(fx['SR2SubIFD:ColorMatrix']));
    assert.deepEqual(frame.sr2WhiteLevel, list(fx['SR2SubIFD:WhiteLevel']));

    const ex = frame.exposure;
    assert.ok(Math.abs(ex.exposureTime - Number(fx['ExifIFD:ExposureTime'])) < 1e-9, `exposure ${ex.exposureTime}`);
    assert.equal(ex.fNumber, fx['ExifIFD:FNumber']);
    assert.equal(ex.iso, fx['ExifIFD:ISO']);
    assert.equal(ex.exposureCompensation, fx['ExifIFD:ExposureCompensation']);
    assert.equal(ex.dateTimeOriginal, fx['ExifIFD:DateTimeOriginal']);
    assert.equal(ex.subSecTimeOriginal, String(fx['ExifIFD:SubSecTimeOriginal']));
    assert.equal(ex.focalLength, fx['ExifIFD:FocalLength']);
    assert.equal(ex.lensModel, fx['ExifIFD:LensModel']);
    assert.equal(ex.exposureMode, fx['ExifIFD:ExposureMode']);
    assert.equal(frame.sequenceNumber, fx['Sony:SequenceNumber']);
    assert.equal(frame.releaseMode, SONY_RELEASE_MODES[Number(fx['Sony:ReleaseMode'])]);
  });

  test(`${file}: samples are 14-bit and the CFA view starts at the strip`, { skip: present ? false : 'sample missing' }, () => {
    const bytes = readFileSync(path);
    const frame = readArw(bytes, file);
    let max = 0;
    for (let i = 0; i < frame.cfa.length; i++) if (frame.cfa[i] > max) max = frame.cfa[i];
    assert.ok(max <= frame.whiteLevel, `max code ${max} exceeds white level ${frame.whiteLevel}`);
    const strip = Number(fx['SubIFD:StripOffsets']);
    assert.equal(frame.cfa[0], bytes.readUInt16LE(strip));
    assert.equal(frame.cfa[frame.cfa.length - 1], bytes.readUInt16LE(strip + 2 * (frame.cfa.length - 1)));
  });
}

test('rejects files that are not Sony ARW', () => {
  const tiff = new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.throws(() => readArw(tiff), /Not a Sony ARW/);
  assert.throws(() => readArw(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /Not a TIFF/);
});

test('rejects compressed raw with a clear message', () => {
  const path = new URL('DSC03495_1.ARW', SAMPLES);
  if (!existsSync(path)) return;
  // Patch the raw IFD's Compression value (SHORT, inline) from 1 to 7 (lossless JPEG).
  const bytes = new Uint8Array(readFileSync(path));
  const frame = readArw(bytes);
  assert.equal(frame.compression, 1);
  const patched = patchRawCompression(bytes, 7);
  assert.throws(() => readArw(patched), (e: unknown) => e instanceof UnsupportedRawError && /Uncompressed/.test(e.message));
});

/** Finds the raw IFD's Compression entry (tag 0x0103 next to 32803 photometric) and rewrites it. */
function patchRawCompression(bytes: Uint8Array, value: number): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer);
  for (let p = 8; p + 12 < 4096 * 64; p += 2) {
    // Entry layout: tag u16, type u16 (3 = SHORT), count u32 (1), value u16
    if (view.getUint16(p, true) === 0x0103 && view.getUint16(p + 2, true) === 3 && view.getUint32(p + 4, true) === 1 && view.getUint16(p + 8, true) === 1) {
      // The raw IFD's PhotometricInterpretation (0x0106 = 32803) follows within a few entries.
      for (let q = p + 12; q < p + 12 * 8; q += 12) {
        if (view.getUint16(q, true) === 0x0106 && view.getUint16(q + 8, true) === 32803) {
          view.setUint16(p + 8, value, true);
          return out;
        }
      }
    }
  }
  throw new Error('raw IFD Compression entry not found');
}
