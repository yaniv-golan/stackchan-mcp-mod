/*
 * Minimal PNG encoder for camera frames.
 *
 * The CoreS3's GC0308 sensor cannot produce JPEG, so frames arrive as RGB565 and an MCP image result
 * needs a real image format. The host firmware bundles no deflate module (and a MOD cannot add native
 * code), so the zlib stream here uses stored (uncompressed) deflate blocks: valid PNG, no compression.
 * Expect ~58 KB for a 160x120 RGB frame and ~20 KB for the same frame in grayscale.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const STORED_BLOCK_MAX = 0xffff

let crcTable

function crc32Table() {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  return crcTable
}

function crc32(bytes, start, end) {
  const table = crc32Table()
  let c = 0xffffffff
  for (let i = start; i < end; i += 1) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function adler32(bytes, start, end) {
  let a = 1
  let b = 0
  for (let i = start; i < end; i += 1) {
    a = (a + bytes[i]) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

/** Expands RGB565 to PNG scanlines: one filter byte (0 = none) per row, then the pixel bytes. */
function rgb565ToScanlines(source, width, height, mode, bigEndian) {
  const channels = mode === 'rgb' ? 3 : 1
  const rowLength = 1 + width * channels
  const scanlines = new Uint8Array(rowLength * height)
  let out = 0
  let read = 0
  for (let y = 0; y < height; y += 1) {
    scanlines[out] = 0
    out += 1
    for (let x = 0; x < width; x += 1) {
      const low = source[read]
      const high = source[read + 1]
      read += 2
      const value = bigEndian ? (low << 8) | high : (high << 8) | low
      // 5/6/5 bits expanded to 8 by repeating the high bits.
      const r5 = (value >> 11) & 0x1f
      const g6 = (value >> 5) & 0x3f
      const b5 = value & 0x1f
      const r = (r5 << 3) | (r5 >> 2)
      const g = (g6 << 2) | (g6 >> 4)
      const b = (b5 << 3) | (b5 >> 2)
      if (mode === 'gray') {
        // Rec. 601 luma, integer arithmetic.
        scanlines[out] = (r * 77 + g * 150 + b * 29) >> 8
        out += 1
      } else if (mode === 'palette') {
        // 3-3-2 color index: one byte per pixel, a third the size of truecolor.
        scanlines[out] = ((r & 0xe0) | ((g & 0xe0) >> 3) | (b >> 6)) & 0xff
        out += 1
      } else {
        scanlines[out] = r
        scanlines[out + 1] = g
        scanlines[out + 2] = b
        out += 3
      }
    }
  }
  return scanlines
}

/** The fixed 3-3-2 palette matching the indices written above. */
function paletteBytes() {
  const palette = new Uint8Array(256 * 3)
  for (let i = 0; i < 256; i += 1) {
    const r3 = (i >> 5) & 0x07
    const g3 = (i >> 2) & 0x07
    const b2 = i & 0x03
    palette[i * 3] = Math.round((r3 * 255) / 7)
    palette[i * 3 + 1] = Math.round((g3 * 255) / 7)
    palette[i * 3 + 2] = Math.round((b2 * 255) / 3)
  }
  return palette
}

function storedDeflateLength(dataLength) {
  const blocks = Math.max(1, Math.ceil(dataLength / STORED_BLOCK_MAX))
  return 2 + blocks * 5 + dataLength + 4 // zlib header + block headers + data + adler32
}

function writeStoredDeflate(out, offset, data) {
  out[offset] = 0x78 // zlib: deflate, 32K window
  out[offset + 1] = 0x01 // no preset dictionary, fastest compression level
  let at = offset + 2
  let position = 0
  const total = data.length
  do {
    const size = Math.min(STORED_BLOCK_MAX, total - position)
    const last = position + size >= total
    out[at] = last ? 1 : 0
    out[at + 1] = size & 0xff
    out[at + 2] = (size >> 8) & 0xff
    out[at + 3] = ~size & 0xff
    out[at + 4] = (~size >> 8) & 0xff
    at += 5
    out.set(data.subarray(position, position + size), at)
    at += size
    position += size
  } while (position < total)
  const checksum = adler32(data, 0, total)
  out[at] = (checksum >>> 24) & 0xff
  out[at + 1] = (checksum >>> 16) & 0xff
  out[at + 2] = (checksum >>> 8) & 0xff
  out[at + 3] = checksum & 0xff
  return at + 4
}

function writeChunk(out, offset, type, dataLength, fill) {
  const length = dataLength
  out[offset] = (length >>> 24) & 0xff
  out[offset + 1] = (length >>> 16) & 0xff
  out[offset + 2] = (length >>> 8) & 0xff
  out[offset + 3] = length & 0xff
  const typeAt = offset + 4
  for (let i = 0; i < 4; i += 1) out[typeAt + i] = type.charCodeAt(i)
  if (fill) fill(typeAt + 4)
  const crc = crc32(out, typeAt, typeAt + 4 + length)
  const crcAt = typeAt + 4 + length
  out[crcAt] = (crc >>> 24) & 0xff
  out[crcAt + 1] = (crc >>> 16) & 0xff
  out[crcAt + 2] = (crc >>> 8) & 0xff
  out[crcAt + 3] = crc & 0xff
  return crcAt + 4
}

/** Bytes the encoder will produce for a frame, so a caller can refuse an oversized capture up front. */
export function estimatePNGSize(width, height, mode) {
  const channels = mode === 'rgb' ? 3 : 1
  const scanlineBytes = height * (1 + width * channels)
  const paletteChunk = mode === 'palette' ? 12 + 768 : 0
  return SIGNATURE.length + (12 + 13) + paletteChunk + (12 + storedDeflateLength(scanlineBytes)) + 12
}

/**
 * Encodes an RGB565 buffer as a PNG.
 *
 * @param buffer ArrayBuffer or typed array holding width*height*2 bytes
 * @param options width, height, mode ('gray' | 'palette' | 'rgb'), bigEndian (true for rgb565be)
 * @returns Uint8Array holding the PNG file
 */
export function encodeRGB565AsPNG(buffer, options) {
  const { width, height, mode = 'gray', bigEndian = false } = options
  if (!(width > 0 && height > 0)) throw new Error('width and height are required')
  if (mode !== 'gray' && mode !== 'palette' && mode !== 'rgb') throw new Error(`unknown mode ${mode}`)
  const source = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const expected = width * height * 2
  if (source.length < expected) throw new Error(`frame is ${source.length} bytes, expected ${expected}`)

  const scanlines = rgb565ToScanlines(source, width, height, mode, bigEndian)
  const palette = mode === 'palette' ? paletteBytes() : undefined
  const idatLength = storedDeflateLength(scanlines.length)
  const total = estimatePNGSize(width, height, mode)
  const out = new Uint8Array(total)
  out.set(SIGNATURE, 0)
  let offset = SIGNATURE.length

  offset = writeChunk(out, offset, 'IHDR', 13, (at) => {
    out[at] = (width >>> 24) & 0xff
    out[at + 1] = (width >>> 16) & 0xff
    out[at + 2] = (width >>> 8) & 0xff
    out[at + 3] = width & 0xff
    out[at + 4] = (height >>> 24) & 0xff
    out[at + 5] = (height >>> 16) & 0xff
    out[at + 6] = (height >>> 8) & 0xff
    out[at + 7] = height & 0xff
    out[at + 8] = 8 // bit depth
    out[at + 9] = mode === 'gray' ? 0 : mode === 'palette' ? 3 : 2 // grayscale, indexed or truecolor
    out[at + 10] = 0 // deflate
    out[at + 11] = 0 // adaptive filtering
    out[at + 12] = 0 // no interlace
  })
  if (palette) {
    offset = writeChunk(out, offset, 'PLTE', palette.length, (at) => {
      out.set(palette, at)
    })
  }
  offset = writeChunk(out, offset, 'IDAT', idatLength, (at) => {
    writeStoredDeflate(out, at, scanlines)
  })
  offset = writeChunk(out, offset, 'IEND', 0)
  if (offset !== total) throw new Error(`png encoder wrote ${offset} of ${total} bytes`)
  return out
}

export default encodeRGB565AsPNG
