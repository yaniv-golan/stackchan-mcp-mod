/*
 * Base64 straight into a caller-supplied byte buffer.
 *
 * Uint8Array.prototype.toBase64() would do this in one call, but it returns a JS string that then has
 * to be embedded in a JSON string and converted to an ArrayBuffer to be sent — three large copies alive
 * at once. On a 160x120 color photo that was enough to starve the display driver. Writing the base64
 * bytes directly into the response buffer keeps only the source and the response in memory.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64Length(byteLength) {
  return 4 * Math.ceil(byteLength / 3)
}

/** Writes base64 for `bytes` into `out` at `offset`; returns the offset just past the last byte written. */
export function writeBase64(out, offset, bytes) {
  const codes = new Uint8Array(64)
  for (let i = 0; i < 64; i += 1) codes[i] = ALPHABET.charCodeAt(i)
  const pad = '='.charCodeAt(0)
  const length = bytes.length
  let at = offset
  let i = 0
  while (i + 2 < length) {
    const value = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out[at] = codes[(value >> 18) & 0x3f]
    out[at + 1] = codes[(value >> 12) & 0x3f]
    out[at + 2] = codes[(value >> 6) & 0x3f]
    out[at + 3] = codes[value & 0x3f]
    at += 4
    i += 3
  }
  const remaining = length - i
  if (remaining === 1) {
    const value = bytes[i] << 16
    out[at] = codes[(value >> 18) & 0x3f]
    out[at + 1] = codes[(value >> 12) & 0x3f]
    out[at + 2] = pad
    out[at + 3] = pad
    at += 4
  } else if (remaining === 2) {
    const value = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out[at] = codes[(value >> 18) & 0x3f]
    out[at + 1] = codes[(value >> 12) & 0x3f]
    out[at + 2] = codes[(value >> 6) & 0x3f]
    out[at + 3] = pad
    at += 4
  }
  return at
}
