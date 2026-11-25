// AES IGE mode as used by MTProto 2.0 (two-block IV).
// c_i = E_k(p_i XOR c_{i-1}) XOR p_{i-1}
// Reference: https://www.links.org/files/openssl-ige.pdf , https://github.com/gotd/ige
import crypto from 'node:crypto';

export function xor(a, b) {
  if (a.length !== b.length) throw new RangeError('xor: length mismatch');
  const out = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function blockCipher(key, decrypt) {
  const size = key.length * 8;
  if (![128, 192, 256].includes(size)) throw new RangeError('IGE key must be 16/24/32 bytes');
  const c = decrypt
    ? crypto.createDecipheriv(`aes-${size}-ecb`, key, null)
    : crypto.createCipheriv(`aes-${size}-ecb`, key, null);
  c.setAutoPadding(false);
  return c;
}

/**
 * IGE transform. iv = 32 bytes: iv[0:16] = c_0, iv[16:32] = p_0.
 */
export function igeTransform(key, iv, data, decrypt = false) {
  if (iv.length !== 32) throw new RangeError('IGE iv must be 32 bytes');
  if (data.length % 16 !== 0) throw new RangeError('IGE data must be a multiple of 16');

  const block = blockCipher(key, decrypt);
  let c = Buffer.from(iv.subarray(0, 16)); // previous ciphertext
  let m = Buffer.from(iv.subarray(16, 32)); // previous plaintext
  const out = Buffer.allocUnsafe(data.length);

  for (let off = 0; off < data.length; off += 16) {
    const input = data.subarray(off, off + 16);
    const transformed = Buffer.from(block.update(xor(input, decrypt ? m : c)));
    const result = xor(transformed, decrypt ? c : m);
    result.copy(out, off);
    if (decrypt) {
      c = Buffer.from(input); // this ciphertext becomes the previous ciphertext
      m = Buffer.from(result); // decoded plaintext
    } else {
      c = Buffer.from(result); // this ciphertext
      m = Buffer.from(input); // this plaintext
    }
  }
  return out;
}

export function igeEncrypt(key, iv, data) {
  return igeTransform(key, iv, data, false);
}

export function igeDecrypt(key, iv, data) {
  return igeTransform(key, iv, data, true);
}
