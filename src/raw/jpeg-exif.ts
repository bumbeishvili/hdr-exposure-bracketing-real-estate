// Exif for exported JPEGs. Browsers' JPEG encoders write none, so the camera,
// lens and exposure of the base frame are added here, with ColorSpace = sRGB
// so viewers that do not assume sRGB for untagged files still read the colours
// right.

import { IfdBuilder, tiffStream, toRational, UNDEFINED } from './tiff-writer.ts';

export interface ExifInfo {
  make: string;
  model: string;
  software: string;
  width: number;
  height: number;
  /** "YYYY:MM:DD HH:MM:SS" */
  dateTimeOriginal: string;
  exposureTime: readonly [number, number] | null;
  fNumber: number;
  iso: number;
  focalLength: number;
  lensModel: string;
}

/** The IFDs an Exif block holds; offsets to the Exif IFD are filled in by `tiffStream`'s layout. */
function exifIfds(info: ExifInfo): IfdBuilder[] {
  const exif = new IfdBuilder()
    .bytes(36864, [...'0231'].map((c) => c.charCodeAt(0)), UNDEFINED)
    .short(40961, 1)
    .long(40962, info.width)
    .long(40963, info.height);
  if (info.exposureTime) exif.rational(33434, info.exposureTime);
  if (info.fNumber > 0) exif.rational(33437, toRational(info.fNumber));
  if (info.iso > 0) exif.short(34855, Math.min(65535, Math.round(info.iso)));
  if (info.dateTimeOriginal) exif.ascii(36867, info.dateTimeOriginal);
  if (info.focalLength > 0) exif.rational(37386, toRational(info.focalLength));
  if (info.lensModel) exif.ascii(42036, info.lensModel);
  const ifd0 = new IfdBuilder().ascii(271, info.make).ascii(272, info.model).short(274, 1).ascii(305, info.software).long(34665, 0);
  if (info.dateTimeOriginal) ifd0.ascii(306, info.dateTimeOriginal);
  return [ifd0, exif];
}

/** The APP1 Exif segment, marker included. */
export function exifSegment(info: ExifInfo): Uint8Array {
  const ifds = exifIfds(info);
  // Lay out once to learn where the Exif IFD lands, point IFD0 at it, lay out again.
  ifds[0].long(34665, tiffStream(ifds).offsets[1]);
  const tiff = tiffStream(ifds).bytes;
  const segment = new Uint8Array(10 + tiff.length);
  segment.set([0xff, 0xe1, (8 + tiff.length) >> 8, (8 + tiff.length) & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  segment.set(tiff, 10);
  return segment;
}

/** The JPEG with an APP segment inserted after SOI and any JFIF APP0. */
export async function insertSegment(jpeg: Blob, segment: Uint8Array): Promise<Blob> {
  const head = new Uint8Array(await jpeg.slice(0, 6).arrayBuffer());
  if (head[0] !== 0xff || head[1] !== 0xd8) throw new Error('The encoder did not produce a JPEG');
  const at = head[2] === 0xff && head[3] === 0xe0 ? 4 + ((head[4] << 8) | head[5]) : 2;
  return new Blob([jpeg.slice(0, at), segment as Uint8Array<ArrayBuffer>, jpeg.slice(at)], { type: 'image/jpeg' });
}
