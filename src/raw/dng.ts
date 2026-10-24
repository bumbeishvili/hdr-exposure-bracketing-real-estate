// Writes the merged raw data as a DNG 1.4 file: a 16-bit floating-point CFA
// image in sensor geometry, scaled so 1.0 is the base frame's white level and
// the highlights the darker frames recovered sit above it. Lightroom and Camera
// Raw open it like a raw file with several stops of extra headroom (as they do
// their own HDR merges). Colour comes from the camera profile's matrices and
// white balance from AsShotNeutral; IFD0 holds an sRGB preview of the finished
// look, with the raw image in a SubIFD.

import type { CameraProfile, Matrix3 } from '../color/dcp.ts';
import { IfdBuilder, toRational, UNDEFINED } from './tiff-writer.ts';

export interface DngInput {
  width: number;
  height: number;
  /** CFA samples, black-subtracted; written divided by `white`. */
  data: Float32Array;
  white: number;
  /** CFA colour (0 R, 1 G, 2 B) at index (y & 1) * 2 + (x & 1). */
  cfaColors: readonly number[];
  make: string;
  model: string;
  /** Camera Raw looks its own profiles up by this ("Sony ILCE-7CM2"). */
  uniqueCameraModel: string;
  orientation: number;
  profile: Pick<CameraProfile, 'illuminant1' | 'illuminant2' | 'colorMatrix1' | 'colorMatrix2' | 'forwardMatrix1' | 'forwardMatrix2'>;
  /** Camera RGB of a neutral under the chosen white balance. */
  asShotNeutral: readonly [number, number, number];
  /** 8-bit sRGB, interleaved. */
  preview: { width: number; height: number; rgb: Uint8Array };
  exif: { exposureTime: readonly [number, number] | null; fNumber: number; iso: number; focalLength: number; dateTimeOriginal: string; lensModel: string };
  software: string;
  originalRawFileName: string;
}

const matrix = (m: Matrix3): number[] => [...m];

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** IEEE half-precision bits of a non-negative float (round half up; overflow to the largest finite value). */
export function toHalf(x: number): number {
  if (!(x > 0)) return 0;
  f32[0] = x;
  const b = u32[0];
  const e = ((b >>> 23) & 0xff) - 112; // rebias 127 → 15
  if (e >= 31) return 0x7bff;
  let m = b & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return 0;
    m |= 0x800000;
    const shift = 14 - e;
    return (m >>> shift) + ((m >>> (shift - 1)) & 1);
  }
  const h = ((e << 10) | (m >>> 13)) + ((m >>> 12) & 1); // a carry moves into the exponent, as it should
  return h > 0x7bff ? 0x7bff : h;
}

export function writeDng(input: DngInput): Blob {
  const { width: W, height: H, preview, profile, exif } = input;

  const raw = new IfdBuilder()
    .long(254, 0)
    .long(256, W)
    .long(257, H)
    .short(258, 16)
    .short(259, 1)
    .short(262, 32803)
    .long(273, 0)
    .short(277, 1)
    .long(278, H)
    .long(279, W * H * 2)
    .short(284, 1)
    .short(339, 3)
    .short(33421, 2, 2)
    .bytes(33422, input.cfaColors.slice(0, 4))
    .bytes(50710, [0, 1, 2])
    .short(50711, 1)
    // Floating-point data is 0…1 at white; say so, as readers that ignore the float default assume 65535.
    .long(50717, 1);

  const exifIfd = new IfdBuilder().bytes(36864, [...'0231'].map((c) => c.charCodeAt(0)), UNDEFINED);
  if (exif.exposureTime) exifIfd.rational(33434, exif.exposureTime);
  if (exif.fNumber > 0) exifIfd.rational(33437, toRational(exif.fNumber));
  if (exif.iso > 0) exifIfd.short(34855, Math.min(65535, Math.round(exif.iso)));
  if (exif.dateTimeOriginal) exifIfd.ascii(36867, exif.dateTimeOriginal);
  if (exif.focalLength > 0) exifIfd.rational(37386, toRational(exif.focalLength));
  if (exif.lensModel) exifIfd.ascii(42036, exif.lensModel);

  const ifd0 = new IfdBuilder()
    .long(254, 1)
    .long(256, preview.width)
    .long(257, preview.height)
    .short(258, 8, 8, 8)
    .short(259, 1)
    .short(262, 2)
    .ascii(271, input.make)
    .ascii(272, input.model)
    .long(273, 0)
    .short(274, input.orientation || 1)
    .short(277, 3)
    .long(278, preview.height)
    .long(279, preview.width * preview.height * 3)
    .short(284, 1)
    .ascii(305, input.software)
    .long(330, 0)
    .long(34665, 0)
    .bytes(50706, [1, 4, 0, 0])
    .bytes(50707, [1, 4, 0, 0])
    .ascii(50708, input.uniqueCameraModel)
    .srational(50721, ...matrix(profile.colorMatrix1))
    .rational(50728, ...input.asShotNeutral.map(toRational))
    .short(50778, profile.illuminant1)
    .ascii(50827, input.originalRawFileName)
    .long(50970, 2); // preview colour space: sRGB
  if (exif.dateTimeOriginal) ifd0.ascii(306, exif.dateTimeOriginal);
  if (profile.colorMatrix2) ifd0.srational(50722, ...matrix(profile.colorMatrix2)).short(50779, profile.illuminant2);
  if (profile.forwardMatrix1) ifd0.srational(50964, ...matrix(profile.forwardMatrix1));
  if (profile.forwardMatrix2) ifd0.srational(50965, ...matrix(profile.forwardMatrix2));

  // Layout: header, IFD0, Exif IFD, raw IFD, preview pixels, raw pixels. Offsets are fixed-size LONGs, so sizes are known first.
  const at0 = 8;
  const atExif = at0 + ifd0.size();
  const atRaw = atExif + exifIfd.size();
  const atPreview = atRaw + raw.size();
  const atData = atPreview + preview.rgb.length + (preview.rgb.length & 1);
  ifd0.long(273, atPreview).long(330, atRaw).long(34665, atExif);
  raw.long(273, atData);

  const head = new ArrayBuffer(atPreview);
  const view = new DataView(head);
  view.setUint16(0, 0x4949, false);
  view.setUint16(2, 42, true);
  view.setUint32(4, at0, true);
  ifd0.write(view, at0);
  exifIfd.write(view, atExif);
  raw.write(view, atRaw);

  const pixels = new Uint16Array(W * H);
  const inv = 1 / input.white;
  for (let i = 0; i < pixels.length; i++) pixels[i] = toHalf(input.data[i] * inv);
  const pad = new Uint8Array(preview.rgb.length & 1);
  return new Blob([head, preview.rgb as Uint8Array<ArrayBuffer>, pad, pixels], { type: 'image/x-adobe-dng' });
}
