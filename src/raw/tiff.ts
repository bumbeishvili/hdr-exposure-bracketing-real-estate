// Minimal TIFF/IFD reader. ARW is a TIFF container: IFD0 holds the preview
// JPEG and points to the raw SubIFD, the Exif IFD and Sony's SR2 private block.

/** Byte size of one value of each TIFF field type. */
const TYPE_SIZE: Readonly<Record<number, number>> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  13: 4, // IFD
};

export interface IfdEntry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** Position of the value bytes within the reader's view. */
  readonly pos: number;
}

export interface Ifd {
  /** File offset the IFD was read from. */
  readonly offset: number;
  /** Entry count declared by the IFD (unreadable entries are not in `entries`). */
  readonly count: number;
  readonly entries: ReadonlyMap<number, IfdEntry>;
  /** File offset of the next IFD in the chain, or 0. */
  readonly next: number;
}

export class TiffError extends Error {
  name = 'TiffError';
}

export class TiffReader {
  readonly view: DataView;
  readonly littleEndian: boolean;
  /**
   * Added to file offsets to get positions in `view`. Zero for a whole file;
   * minus the block's file offset for a block cut out of a file (SR2SubIFD).
   */
  readonly base: number;

  constructor(view: DataView, littleEndian: boolean, base = 0) {
    this.view = view;
    this.littleEndian = littleEndian;
    this.base = base;
  }

  /** Validates the TIFF header and returns a reader plus the IFD0 offset. */
  static open(bytes: Uint8Array): { reader: TiffReader; firstIfd: number } {
    if (bytes.byteLength < 8) throw new TiffError('File is too small to be a TIFF');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const order = view.getUint16(0, false);
    if (order !== 0x4949 && order !== 0x4d4d) throw new TiffError('Not a TIFF file (no II/MM byte-order mark)');
    const le = order === 0x4949;
    if (view.getUint16(2, le) !== 42) throw new TiffError('Not a TIFF file (bad magic number)');
    return { reader: new TiffReader(view, le), firstIfd: view.getUint32(4, le) };
  }

  u16(pos: number): number {
    return this.view.getUint16(pos, this.littleEndian);
  }

  u32(pos: number): number {
    return this.view.getUint32(pos, this.littleEndian);
  }

  readIfd(offset: number): Ifd {
    const start = offset + this.base;
    if (start < 0 || start + 2 > this.view.byteLength) throw new TiffError(`IFD offset ${offset} is outside the file`);
    const n = this.u16(start);
    const end = start + 2 + n * 12;
    if (end + 4 > this.view.byteLength) throw new TiffError(`IFD at offset ${offset} runs past the end of the file`);

    const entries = new Map<number, IfdEntry>();
    for (let i = 0; i < n; i++) {
      const p = start + 2 + i * 12;
      const tag = this.u16(p);
      const type = this.u16(p + 2);
      const count = this.u32(p + 4);
      const size = (TYPE_SIZE[type] ?? 0) * count;
      if (size === 0) continue; // unknown type or empty value
      const pos = size <= 4 ? p + 8 : this.u32(p + 8) + this.base;
      if (pos < 0 || pos + size > this.view.byteLength) continue; // dangling pointer
      if (!entries.has(tag)) entries.set(tag, { tag, type, count, pos });
    }
    return { offset, count: n, entries, next: this.u32(end) };
  }

  /** Value `i` of an entry as a number (rationals are divided out). */
  value(e: IfdEntry, i = 0): number {
    const v = this.view;
    const le = this.littleEndian;
    switch (e.type) {
      case 1:
      case 7:
        return v.getUint8(e.pos + i);
      case 6:
        return v.getInt8(e.pos + i);
      case 3:
        return v.getUint16(e.pos + 2 * i, le);
      case 8:
        return v.getInt16(e.pos + 2 * i, le);
      case 4:
      case 13:
        return v.getUint32(e.pos + 4 * i, le);
      case 9:
        return v.getInt32(e.pos + 4 * i, le);
      case 5:
      case 10: {
        const [num, den] = this.rational(e, i);
        return den === 0 ? NaN : num / den;
      }
      case 11:
        return v.getFloat32(e.pos + 4 * i, le);
      case 12:
        return v.getFloat64(e.pos + 8 * i, le);
      default:
        return NaN;
    }
  }

  values(e: IfdEntry): number[] {
    const out = new Array<number>(e.count);
    for (let i = 0; i < e.count; i++) out[i] = this.value(e, i);
    return out;
  }

  /** Numerator and denominator of a RATIONAL or SRATIONAL value. */
  rational(e: IfdEntry, i = 0): [number, number] {
    const p = e.pos + 8 * i;
    if (e.type === 10) return [this.view.getInt32(p, this.littleEndian), this.view.getInt32(p + 4, this.littleEndian)];
    return [this.u32(p), this.u32(p + 4)];
  }

  string(e: IfdEntry): string {
    let s = '';
    for (let i = 0; i < e.count; i++) {
      const c = this.view.getUint8(e.pos + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  bytes(e: IfdEntry): Uint8Array {
    const size = (TYPE_SIZE[e.type] ?? 0) * e.count;
    return new Uint8Array(this.view.buffer, this.view.byteOffset + e.pos, size);
  }
}
