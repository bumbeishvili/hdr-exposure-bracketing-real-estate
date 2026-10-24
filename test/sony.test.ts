import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sonyDecrypt } from '../src/raw/sony.ts';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const fromHex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'));

// Expected outputs were produced by ExifTool 12.65's Image::ExifTool::Sony::Decrypt.
test('keystream for key 0x44332211 matches ExifTool', () => {
  const out = sonyDecrypt(new Uint8Array(64), 0x44332211);
  assert.equal(
    hex(out),
    '54c2c4d649c478bc34ae2f8e25d80504c0d9d6b0d838fb71e8eff27dfbc1fcea' +
      '506c499a47f20f37710777cf7867e7ba42d67caa7f2bd11a67a216ca0e986d40',
  );
});

test('decrypting data with key 0x12345678 matches ExifTool', () => {
  const out = sonyDecrypt(fromHex('00112233445566778899aabbccddeeff0123456789abcdef'), 0x12345678);
  assert.equal(hex(out), '14d4cb88e667ba0a19a023f56c2f26500adb848d8c2be44a');
});

test('the cipher is its own inverse and leaves trailing bytes alone', () => {
  const data = new Uint8Array(1031).map((_, i) => (i * 37 + 11) & 0xff);
  const once = sonyDecrypt(data, 0xdeadbeef);
  assert.notDeepEqual(once.subarray(0, 1028), data.subarray(0, 1028));
  assert.deepEqual(once.subarray(1028), data.subarray(1028));
  assert.deepEqual(sonyDecrypt(once, 0xdeadbeef), data);
});
