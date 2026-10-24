// DNG camera profile (.dcp) reader. A DCP is a TIFF with magic 0x4352 whose
// IFD0 carries the DNG colour tags: matrices per calibration illuminant, an
// optional hue/saturation map per illuminant, a look table and a tone curve.

import { TiffReader, type Ifd } from '../raw/tiff.ts';

export type Matrix3 = [number, number, number, number, number, number, number, number, number];

export interface HueSatTable {
  hueDivisions: number;
  satDivisions: number;
  valDivisions: number;
  /** (hue shift in degrees, saturation scale, value scale) triplets; saturation fastest, then hue, then value. */
  data: Float32Array;
  /** Value axis encoding: 0 linear, 1 sRGB gamma. */
  encoding: number;
}

export interface CameraProfile {
  name: string;
  cameraModel: string;
  copyright: string;
  /** Exif LightSource codes of the two calibration illuminants. */
  illuminant1: number;
  illuminant2: number;
  /** XYZ → camera, per illuminant. */
  colorMatrix1: Matrix3;
  colorMatrix2: Matrix3 | null;
  /** White-balanced camera → XYZ (D50), per illuminant. */
  forwardMatrix1: Matrix3 | null;
  forwardMatrix2: Matrix3 | null;
  hueSatMap1: HueSatTable | null;
  hueSatMap2: HueSatTable | null;
  lookTable: HueSatTable | null;
  /** (input, output) pairs in [0, 1], if the profile has its own tone curve. */
  toneCurve: Float32Array | null;
  baselineExposureOffset: number;
  /** 0 allow copying, 1 embed if used, 2 embed never, 3 no restrictions. */
  embedPolicy: number;
}

const T = {
  UniqueCameraModel: 50708,
  ColorMatrix1: 50721,
  ColorMatrix2: 50722,
  CalibrationIlluminant1: 50778,
  CalibrationIlluminant2: 50779,
  ProfileName: 50936,
  ProfileHueSatMapDims: 50937,
  ProfileHueSatMapData1: 50938,
  ProfileHueSatMapData2: 50939,
  ProfileToneCurve: 50940,
  ProfileEmbedPolicy: 50941,
  ProfileCopyright: 50942,
  ForwardMatrix1: 50964,
  ForwardMatrix2: 50965,
  ProfileLookTableDims: 50981,
  ProfileLookTableData: 50982,
  ProfileHueSatMapEncoding: 51107,
  ProfileLookTableEncoding: 51108,
  BaselineExposureOffset: 51109,
} as const;

export function readDcp(bytes: Uint8Array): CameraProfile {
  const { reader: r, firstIfd } = TiffReader.open(bytes, [0x4352]);
  const ifd = r.readIfd(firstIfd);
  const colorMatrix1 = matrix(r, ifd, T.ColorMatrix1);
  if (!colorMatrix1) throw new Error('Camera profile has no ColorMatrix1');
  const hsDims = values(r, ifd, T.ProfileHueSatMapDims);
  const hsEncoding = values(r, ifd, T.ProfileHueSatMapEncoding)[0] ?? 0;
  const ltDims = values(r, ifd, T.ProfileLookTableDims);
  const tone = ifd.entries.get(T.ProfileToneCurve);
  return {
    name: text(r, ifd, T.ProfileName),
    cameraModel: text(r, ifd, T.UniqueCameraModel),
    copyright: text(r, ifd, T.ProfileCopyright),
    illuminant1: values(r, ifd, T.CalibrationIlluminant1)[0] ?? 0,
    illuminant2: values(r, ifd, T.CalibrationIlluminant2)[0] ?? 0,
    colorMatrix1,
    colorMatrix2: matrix(r, ifd, T.ColorMatrix2),
    forwardMatrix1: matrix(r, ifd, T.ForwardMatrix1),
    forwardMatrix2: matrix(r, ifd, T.ForwardMatrix2),
    hueSatMap1: table(r, ifd, T.ProfileHueSatMapData1, hsDims, hsEncoding),
    hueSatMap2: table(r, ifd, T.ProfileHueSatMapData2, hsDims, hsEncoding),
    lookTable: table(r, ifd, T.ProfileLookTableData, ltDims, values(r, ifd, T.ProfileLookTableEncoding)[0] ?? 0),
    toneCurve: tone ? Float32Array.from(r.values(tone)) : null,
    baselineExposureOffset: values(r, ifd, T.BaselineExposureOffset)[0] ?? 0,
    embedPolicy: values(r, ifd, T.ProfileEmbedPolicy)[0] ?? 0,
  };
}

function values(r: TiffReader, ifd: Ifd, tag: number): number[] {
  const e = ifd.entries.get(tag);
  return e ? r.values(e) : [];
}

function text(r: TiffReader, ifd: Ifd, tag: number): string {
  const e = ifd.entries.get(tag);
  return e ? r.string(e) : '';
}

function matrix(r: TiffReader, ifd: Ifd, tag: number): Matrix3 | null {
  const v = values(r, ifd, tag);
  return v.length === 9 ? (v as Matrix3) : null;
}

function table(r: TiffReader, ifd: Ifd, tag: number, dims: number[], encoding: number): HueSatTable | null {
  const e = ifd.entries.get(tag);
  if (!e || dims.length !== 3) return null;
  const [hueDivisions, satDivisions, valDivisions] = dims;
  const data = Float32Array.from(r.values(e));
  if (data.length !== hueDivisions * satDivisions * valDivisions * 3) throw new Error('Profile table size does not match its dimensions');
  return { hueDivisions, satDivisions, valDivisions, data, encoding };
}
