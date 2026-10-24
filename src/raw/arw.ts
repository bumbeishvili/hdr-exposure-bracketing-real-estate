// Sony ARW reader. Phase 1 decodes Uncompressed RAW (14-bit samples stored in
// 16-bit little-endian words); lossless (tiled LJ92) and lossy cRAW are rejected.

import { TiffReader, type Ifd } from './tiff.ts';
import { SONY_RAW_FILE_TYPES, SONY_RELEASE_MODES, sonyDecrypt } from './sony.ts';

const TAG = {
  ImageWidth: 0x0100,
  ImageLength: 0x0101,
  BitsPerSample: 0x0102,
  Compression: 0x0103,
  Photometric: 0x0106,
  Make: 0x010f,
  Model: 0x0110,
  StripOffsets: 0x0111,
  Orientation: 0x0112,
  StripByteCounts: 0x0117,
  Software: 0x0131,
  TileOffsets: 0x0144,
  SubIFDs: 0x014a,
  CFARepeatPatternDim: 0x828d,
  CFAPattern2: 0x828e,
  ExifIFD: 0x8769,
  WhiteLevel: 0xc61d,
  DefaultCropOrigin: 0xc61f,
  DefaultCropSize: 0xc620,
  DNGPrivateData: 0xc634,
  // Exif IFD
  ExposureTime: 0x829a,
  FNumber: 0x829d,
  ISO: 0x8827,
  DateTimeOriginal: 0x9003,
  ExposureCompensation: 0x9204,
  FocalLength: 0x920a,
  MakerNote: 0x927c,
  SubSecTimeOriginal: 0x9291,
  ExposureMode: 0xa402,
  LensModel: 0xa434,
  // Sony raw IFD
  SonyRawFileType: 0x7000,
  SonyBlackLevel: 0x7310,
  SonyWbRggb: 0x7313,
  SonyCropTopLeft: 0x74c7,
  SonyCropSize: 0x74c8,
  // Sony MakerNote
  ReleaseMode: 0xb049,
  SequenceNumber: 0xb04a,
  // SR2Private / SR2SubIFD
  Sr2SubIfdOffset: 0x7200,
  Sr2SubIfdLength: 0x7201,
  Sr2SubIfdKey: 0x7221,
  Sr2BlackLevelOld: 0x7300,
  Sr2WbGrbg: 0x7303,
  Sr2WhiteLevel: 0x787f,
} as const;

const PHOTOMETRIC_CFA = 32803;
const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CfaPattern {
  /** Repeat size; 2×2 for Bayer. */
  width: number;
  height: number;
  /** Colour of each pattern position, row-major: 0 = R, 1 = G, 2 = B. */
  colors: number[];
  /** For example "RGGB". */
  name: string;
}

export interface ExposureInfo {
  /** Seconds. */
  exposureTime: number;
  /** Exposure time as stored: [numerator, denominator]. */
  exposureTimeRational: [number, number];
  fNumber: number;
  iso: number;
  /** EV; for auto-bracket frames this is the bracket offset. */
  exposureCompensation: number;
  /** "YYYY:MM:DD HH:MM:SS". */
  dateTimeOriginal: string;
  subSecTimeOriginal: string;
  /** Millimetres. */
  focalLength: number;
  lensModel: string;
  /** Exif ExposureMode: 0 auto, 1 manual, 2 auto bracket. */
  exposureMode: number;
}

export interface Sr2Block {
  /** File offset and byte length of the encrypted SR2SubIFD. */
  offset: number;
  length: number;
  key: number;
  /** Numeric tags of the decrypted SR2SubIFD. */
  tags: ReadonlyMap<number, number[]>;
}

/** Where a level or gain was read from. */
export type ValueSource = 'raw IFD' | 'SR2' | 'default';

export interface RawFrame {
  fileName: string;
  make: string;
  model: string;
  software: string;
  orientation: number;
  width: number;
  height: number;
  bitsPerSample: number;
  compression: number;
  rawFileType: string;
  /** CFA samples, row-major, `width * height`. May be a view into the input buffer. */
  cfa: Uint16Array;
  cfaPattern: CfaPattern;
  /** Black level per CFA pattern position (row-major over the 2×2 repeat). */
  blackLevel: number[];
  /** Hard clip: the largest code the camera writes (WhiteLevel in the raw IFD). */
  whiteLevel: number;
  /** Sony's R, G, B white level from the SR2 block (SR2SubIFD 0x787f), if present. */
  sr2WhiteLevel: number[] | null;
  /** Active image area within the stored raw. */
  crop: Rect;
  /** As-shot white balance gains R, G, G, B (green = 1024). Metadata only. */
  asShotWb: number[] | null;
  sources: { blackLevel: ValueSource; whiteLevel: ValueSource; asShotWb: ValueSource | null };
  exposure: ExposureInfo;
  /** Position in the camera's bracket sequence (1-based), from the MakerNote. */
  sequenceNumber: number | null;
  releaseMode: string | null;
  sr2: Sr2Block | null;
}

export class ArwError extends Error {
  name = 'ArwError';
}

export class UnsupportedRawError extends ArwError {
  name = 'UnsupportedRawError';
}

/**
 * Reads an ARW file. The returned `cfa` may be a view into `input`, so the
 * buffer must stay attached (not transferred) while the frame is in use.
 */
export function readArw(input: ArrayBuffer | Uint8Array, fileName = ''): RawFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { reader: r, firstIfd } = TiffReader.open(bytes);
  const ifd0 = r.readIfd(firstIfd);

  const make = text(r, ifd0, TAG.Make);
  if (!/^sony/i.test(make)) throw new ArwError(`Not a Sony ARW file (camera make is "${make || 'missing'}")`);

  const raw = findRawIfd(r, ifd0);
  const width = num(r, raw, TAG.ImageWidth);
  const height = num(r, raw, TAG.ImageLength);
  const bitsPerSample = num(r, raw, TAG.BitsPerSample);
  const compression = num(r, raw, TAG.Compression);
  const rawTypeCode = num(r, raw, TAG.SonyRawFileType, -1);
  const rawFileType = SONY_RAW_FILE_TYPES[rawTypeCode] ?? `Unknown raw type ${rawTypeCode}`;
  if (compression !== 1 || raw.entries.has(TAG.TileOffsets)) {
    throw new UnsupportedRawError(`${rawFileType} (compression ${compression}) is not supported yet. Shoot RAW file type "Uncompressed".`);
  }
  if (!(width > 0 && height > 0 && bitsPerSample > 0 && bitsPerSample <= 16)) {
    throw new ArwError(`Unexpected raw geometry ${width}×${height} at ${bitsPerSample} bits`);
  }

  const sr2 = readSr2(r, bytes, ifd0);
  const sr2Tag = (tag: number): number[] => (sr2?.tags.get(tag) ?? []);

  let blackLevel = nums(r, raw, TAG.SonyBlackLevel);
  let blackSource: ValueSource = 'raw IFD';
  if (blackLevel.length !== 4) {
    blackLevel = sr2Tag(TAG.SonyBlackLevel).length === 4 ? sr2Tag(TAG.SonyBlackLevel) : sr2Tag(TAG.Sr2BlackLevelOld);
    blackSource = 'SR2';
  }
  if (blackLevel.length !== 4) throw new ArwError('No black level found in the raw IFD or the SR2 block');

  const sr2White = sr2Tag(TAG.Sr2WhiteLevel);
  let whiteLevel = num(r, raw, TAG.WhiteLevel);
  let whiteSource: ValueSource = 'raw IFD';
  if (!(whiteLevel > 0)) {
    whiteLevel = sr2White.length ? Math.max(...sr2White) : (1 << bitsPerSample) - 1;
    whiteSource = sr2White.length ? 'SR2' : 'default';
  }

  let asShotWb: number[] | null = nums(r, raw, TAG.SonyWbRggb);
  let wbSource: ValueSource | null = 'raw IFD';
  if (asShotWb.length !== 4) {
    const grbg = sr2Tag(TAG.Sr2WbGrbg);
    asShotWb = sr2Tag(TAG.SonyWbRggb).length === 4 ? sr2Tag(TAG.SonyWbRggb) : grbg.length === 4 ? [grbg[1], grbg[0], grbg[3], grbg[2]] : null;
    wbSource = asShotWb ? 'SR2' : null;
  }

  const exifOffset = num(r, ifd0, TAG.ExifIFD, 0);
  const exif = exifOffset ? tryIfd(r, exifOffset) : null;
  const makerNote = readSonyMakerNote(r, exif);

  return {
    fileName,
    make,
    model: text(r, ifd0, TAG.Model),
    software: text(r, ifd0, TAG.Software),
    orientation: num(r, ifd0, TAG.Orientation, 1),
    width,
    height,
    bitsPerSample,
    compression,
    rawFileType,
    cfa: readSamples(bytes, r, raw, width, height),
    cfaPattern: readCfaPattern(r, raw),
    blackLevel,
    whiteLevel,
    sr2WhiteLevel: sr2White.length ? sr2White : null,
    crop: readCrop(r, raw, width, height),
    asShotWb,
    sources: { blackLevel: blackSource, whiteLevel: whiteSource, asShotWb: wbSource },
    exposure: readExposure(r, exif),
    ...makerNote,
    sr2,
  };
}

/** Index of a pixel's CFA pattern position (row-major over the 2×2 repeat). */
export function cfaIndex(x: number, y: number): number {
  return ((y & 1) << 1) | (x & 1);
}

function num(r: TiffReader, ifd: Ifd, tag: number, fallback = NaN): number {
  const e = ifd.entries.get(tag);
  return e ? r.value(e) : fallback;
}

function nums(r: TiffReader, ifd: Ifd, tag: number): number[] {
  const e = ifd.entries.get(tag);
  return e ? r.values(e) : [];
}

function text(r: TiffReader, ifd: Ifd, tag: number): string {
  const e = ifd.entries.get(tag);
  return e ? r.string(e) : '';
}

function tryIfd(r: TiffReader, offset: number): Ifd | null {
  try {
    return r.readIfd(offset);
  } catch {
    return null;
  }
}

/** Breadth-first search of IFD0's chain and SubIFDs for the largest CFA image. */
function findRawIfd(r: TiffReader, ifd0: Ifd): Ifd {
  const seen = new Set<number>([ifd0.offset]);
  const queue: Array<{ ifd: Ifd; depth: number }> = [{ ifd: ifd0, depth: 0 }];
  let best: Ifd | undefined;
  let bestPixels = 0;
  for (let item = queue.shift(); item; item = queue.shift()) {
    const { ifd, depth } = item;
    if (num(r, ifd, TAG.Photometric) === PHOTOMETRIC_CFA) {
      const pixels = num(r, ifd, TAG.ImageWidth, 0) * num(r, ifd, TAG.ImageLength, 0);
      if (pixels > bestPixels) {
        best = ifd;
        bestPixels = pixels;
      }
    }
    if (depth >= 3) continue;
    for (const offset of [...nums(r, ifd, TAG.SubIFDs), ifd.next]) {
      if (!offset || seen.has(offset)) continue;
      seen.add(offset);
      const next = tryIfd(r, offset);
      if (next) queue.push({ ifd: next, depth: depth + 1 });
    }
  }
  if (!best) throw new ArwError('No CFA raw image found in the file');
  return best;
}

function readSamples(bytes: Uint8Array, r: TiffReader, raw: Ifd, width: number, height: number): Uint16Array {
  const offsets = nums(r, raw, TAG.StripOffsets);
  const counts = nums(r, raw, TAG.StripByteCounts);
  if (!offsets.length || offsets.length !== counts.length) throw new ArwError('Raw IFD has no usable strip offsets');
  const samples = width * height;
  const total = counts.reduce((a, b) => a + b, 0);
  if (total < samples * 2) {
    throw new UnsupportedRawError(`Raw data is ${total} bytes; ${width}×${height} samples in 16-bit words need ${samples * 2}`);
  }
  for (let s = 0; s < offsets.length; s++) {
    if (offsets[s] + counts[s] > bytes.byteLength) throw new ArwError('Raw data runs past the end of the file (truncated copy?)');
  }

  // One aligned little-endian strip: use it in place instead of copying 66 MB.
  if (offsets.length === 1 && r.littleEndian === HOST_LITTLE_ENDIAN && (bytes.byteOffset + offsets[0]) % 2 === 0) {
    return new Uint16Array(bytes.buffer, bytes.byteOffset + offsets[0], samples);
  }
  const out = new Uint16Array(samples);
  let o = 0;
  for (let s = 0; s < offsets.length && o < samples; s++) {
    const n = Math.min(counts[s] >>> 1, samples - o);
    for (let i = 0; i < n; i++) out[o++] = r.u16(offsets[s] + 2 * i);
  }
  return out;
}

function readCfaPattern(r: TiffReader, raw: Ifd): CfaPattern {
  const [rows = 2, cols = 2] = nums(r, raw, TAG.CFARepeatPatternDim);
  const colors = nums(r, raw, TAG.CFAPattern2);
  if (rows !== 2 || cols !== 2) throw new UnsupportedRawError(`Only 2×2 Bayer CFAs are supported (found ${cols}×${rows})`);
  if (colors.length !== 4 || colors.some((c) => c < 0 || c > 2)) throw new ArwError(`Unexpected CFA pattern [${colors.join(', ')}]`);
  return { width: cols, height: rows, colors, name: colors.map((c) => 'RGB'[c]).join('') };
}

function readCrop(r: TiffReader, raw: Ifd, width: number, height: number): Rect {
  let origin = nums(r, raw, TAG.DefaultCropOrigin);
  let size = nums(r, raw, TAG.DefaultCropSize);
  if (origin.length !== 2 || size.length !== 2) {
    origin = nums(r, raw, TAG.SonyCropTopLeft);
    size = nums(r, raw, TAG.SonyCropSize);
  }
  if (origin.length !== 2 || size.length !== 2) return { left: 0, top: 0, width, height };
  const left = Math.min(origin[0], width);
  const top = Math.min(origin[1], height);
  return { left, top, width: Math.min(size[0], width - left), height: Math.min(size[1], height - top) };
}

function readExposure(r: TiffReader, exif: Ifd | null): ExposureInfo {
  const get = (tag: number): number => (exif ? num(r, exif, tag) : NaN);
  const getText = (tag: number): string => (exif ? text(r, exif, tag) : '');
  const t = exif?.entries.get(TAG.ExposureTime);
  const exposureTimeRational: [number, number] = t ? r.rational(t) : [NaN, 1];
  return {
    exposureTime: exposureTimeRational[0] / exposureTimeRational[1],
    exposureTimeRational,
    fNumber: get(TAG.FNumber),
    iso: get(TAG.ISO),
    exposureCompensation: get(TAG.ExposureCompensation),
    dateTimeOriginal: getText(TAG.DateTimeOriginal),
    subSecTimeOriginal: getText(TAG.SubSecTimeOriginal),
    focalLength: get(TAG.FocalLength),
    lensModel: getText(TAG.LensModel),
    exposureMode: get(TAG.ExposureMode),
  };
}

/** Bracket position and release mode from the (unencrypted) Sony MakerNote IFD. */
function readSonyMakerNote(r: TiffReader, exif: Ifd | null): { sequenceNumber: number | null; releaseMode: string | null } {
  const none = { sequenceNumber: null, releaseMode: null };
  const e = exif?.entries.get(TAG.MakerNote);
  if (!e) return none;
  const head = String.fromCharCode(...r.bytes(e).subarray(0, 9));
  // Older bodies prefix the IFD with "SONY DSC \0\0\0"; MakerNoteSony5 starts with the IFD itself.
  const ifdPos = head === 'SONY DSC ' || head === 'SONY CAM ' ? e.pos + 12 : e.pos;
  const notes = tryIfd(r, ifdPos - r.base);
  if (!notes) return none;
  const seq = num(r, notes, TAG.SequenceNumber);
  const mode = num(r, notes, TAG.ReleaseMode);
  return {
    sequenceNumber: Number.isFinite(seq) && seq !== 65535 ? seq : null,
    releaseMode: Number.isFinite(mode) && mode !== 65535 ? (SONY_RELEASE_MODES[mode] ?? `Unknown (${mode})`) : null,
  };
}

/** Locates, decrypts and parses the SR2SubIFD referenced from IFD0's DNGPrivateData. */
function readSr2(r: TiffReader, bytes: Uint8Array, ifd0: Ifd): Sr2Block | null {
  const pointer = ifd0.entries.get(TAG.DNGPrivateData);
  if (!pointer || pointer.count < 4) return null;
  const priv = tryIfd(r, r.u32(pointer.pos));
  if (!priv) return null;
  const offset = num(r, priv, TAG.Sr2SubIfdOffset, 0);
  const length = num(r, priv, TAG.Sr2SubIfdLength, 0);
  // The key is stored as undef[4]; it is read as one 32-bit word in file byte order.
  const keyEntry = priv.entries.get(TAG.Sr2SubIfdKey);
  const key = keyEntry && keyEntry.count >= 4 && (keyEntry.type === 1 || keyEntry.type === 7) ? r.u32(keyEntry.pos) : keyEntry ? r.value(keyEntry) : 0;
  if (!offset || !length || offset + length > bytes.byteLength) return null;

  const plain = sonyDecrypt(bytes.subarray(offset, offset + length), key);
  // Offsets inside the SR2SubIFD are file offsets, so the reader's base is -offset.
  const sr = new TiffReader(new DataView(plain.buffer, plain.byteOffset, plain.byteLength), r.littleEndian, -offset);
  const sub = tryIfd(sr, offset);
  if (!sub) throw new ArwError('SR2 block did not decrypt to a valid IFD');
  const tags = new Map<number, number[]>();
  for (const [tag, entry] of sub.entries) {
    if (entry.type !== 2 && entry.type !== 7 && entry.count <= 256) tags.set(tag, sr.values(entry));
  }
  return { offset, length, key, tags };
}
