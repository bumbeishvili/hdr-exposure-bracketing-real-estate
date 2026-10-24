// Minimal TIFF/IFD writer for the files this app produces: the DNG export and
// the Exif block of exported JPEGs. Little-endian; values longer than four
// bytes go after the entry table.

export const BYTE = 1;
export const ASCII = 2;
export const SHORT = 3;
export const LONG = 4;
export const RATIONAL = 5;
export const UNDEFINED = 7;
export const SRATIONAL = 10;

interface Field {
  type: number;
  count: number;
  bytes: Uint8Array;
}

/** One IFD under construction; values are little-endian bytes. */
export class IfdBuilder {
  readonly fields = new Map<number, Field>();

  private put(tag: number, type: number, count: number, fill: (v: DataView) => void, size: number): void {
    const bytes = new Uint8Array(size);
    fill(new DataView(bytes.buffer));
    this.fields.set(tag, { type, count, bytes });
  }

  bytes(tag: number, values: readonly number[], type = BYTE): this {
    this.put(tag, type, values.length, (v) => values.forEach((x, i) => v.setUint8(i, x)), values.length);
    return this;
  }

  ascii(tag: number, text: string): this {
    const chars = [...text].map((c) => (c.charCodeAt(0) < 128 ? c.charCodeAt(0) : 63));
    return this.bytes(tag, [...chars, 0], ASCII);
  }

  short(tag: number, ...values: number[]): this {
    this.put(tag, SHORT, values.length, (v) => values.forEach((x, i) => v.setUint16(2 * i, x, true)), 2 * values.length);
    return this;
  }

  long(tag: number, ...values: number[]): this {
    this.put(tag, LONG, values.length, (v) => values.forEach((x, i) => v.setUint32(4 * i, x, true)), 4 * values.length);
    return this;
  }

  rational(tag: number, ...pairs: Array<readonly [number, number]>): this {
    this.put(tag, RATIONAL, pairs.length, (v) => pairs.forEach(([n, d], i) => (v.setUint32(8 * i, n, true), v.setUint32(8 * i + 4, d, true))), 8 * pairs.length);
    return this;
  }

  srational(tag: number, ...values: number[]): this {
    this.put(tag, SRATIONAL, values.length, (v) => values.forEach((x, i) => (v.setInt32(8 * i, Math.round(x * 1e6), true), v.setInt32(8 * i + 4, 1e6, true))), 8 * values.length);
    return this;
  }

  /** Bytes the IFD takes: entry table plus out-of-line values (each padded to even length). */
  size(): number {
    let n = 2 + 12 * this.fields.size + 4;
    for (const f of this.fields.values()) if (f.bytes.length > 4) n += f.bytes.length + (f.bytes.length & 1);
    return n;
  }

  write(view: DataView, offset: number): void {
    const tags = [...this.fields.keys()].sort((a, b) => a - b);
    view.setUint16(offset, tags.length, true);
    let data = offset + 2 + 12 * tags.length + 4;
    tags.forEach((tag, i) => {
      const f = this.fields.get(tag)!;
      const at = offset + 2 + 12 * i;
      view.setUint16(at, tag, true);
      view.setUint16(at + 2, f.type, true);
      view.setUint32(at + 4, f.count, true);
      if (f.bytes.length <= 4) f.bytes.forEach((b, k) => view.setUint8(at + 8 + k, b));
      else {
        view.setUint32(at + 8, data, true);
        f.bytes.forEach((b, k) => view.setUint8(data + k, b));
        data += f.bytes.length + (f.bytes.length & 1);
      }
    });
    view.setUint32(offset + 2 + 12 * tags.length, 0, true); // no next IFD
  }
}

/** An unsigned RATIONAL close to x (micro-units). */
export const toRational = (x: number): [number, number] => [Math.round(x * 1e6), 1e6];

/** A little-endian TIFF stream of IFDs laid out one after another, the first being IFD0. */
export function tiffStream(ifds: IfdBuilder[], tail = 0): { bytes: Uint8Array; offsets: number[]; end: number } {
  const offsets: number[] = [];
  let at = 8;
  for (const ifd of ifds) {
    offsets.push(at);
    at += ifd.size();
  }
  const bytes = new Uint8Array(at + tail);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x4949, false);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  ifds.forEach((ifd, i) => ifd.write(view, offsets[i]));
  return { bytes, offsets, end: at };
}
