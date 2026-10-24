// Sony-specific parts of the ARW container.

/** SonyRawFileType (raw IFD tag 0x7000), named as ExifTool prints them. */
export const SONY_RAW_FILE_TYPES: Readonly<Record<number, string>> = {
  0: 'Sony Uncompressed 14-bit RAW',
  1: 'Sony Uncompressed 12-bit RAW',
  2: 'Sony Compressed RAW',
  3: 'Sony Lossless Compressed RAW',
  4: 'Sony Lossless Compressed RAW 2',
};

/** Sony MakerNote ReleaseMode (tag 0xb049), the values a bracket set can carry. */
export const SONY_RELEASE_MODES: Readonly<Record<number, string>> = {
  0: 'Normal',
  2: 'Continuous',
  5: 'Exposure Bracketing',
  6: 'White Balance Bracketing',
  8: 'DRO Bracketing',
};

/**
 * Decrypts (or encrypts: the cipher is a XOR keystream) Sony's SR2SubIFD block.
 * Keystream generator as in dcraw's sony_decrypt and ExifTool's Sony::Decrypt;
 * data is processed as big-endian 32-bit words, trailing bytes are left as-is.
 */
export function sonyDecrypt(src: Uint8Array, key: number): Uint8Array {
  const out = src.slice();
  const pad = new Uint32Array(128);
  let k = key >>> 0;
  for (let i = 0; i < 4; i++) {
    k = (Math.imul(k, 48828125) + 1) >>> 0;
    pad[i] = k;
  }
  pad[3] = (pad[3] << 1) | ((pad[0] ^ pad[2]) >>> 31);
  for (let i = 4; i < 127; i++) {
    pad[i] = ((pad[i - 4] ^ pad[i - 2]) << 1) | ((pad[i - 3] ^ pad[i - 1]) >>> 31);
  }

  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const words = out.byteLength >>> 2;
  for (let i = 127, j = 0; j < words; i++, j++) {
    pad[i & 127] = pad[(i + 1) & 127] ^ pad[(i + 65) & 127];
    view.setUint32(4 * j, view.getUint32(4 * j, false) ^ pad[i & 127], false);
  }
  return out;
}
