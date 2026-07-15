import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c;
}

/**
 * CRC-32 as required by the PNG specification.
 * @param {Buffer} data - Bytes to checksum.
 * @returns {number} Unsigned 32-bit CRC.
 */
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Encode a PNG chunk (length + type + data + CRC).
 * @param {string} type - 4-letter chunk type.
 * @param {Buffer} data - Chunk payload.
 * @returns {Buffer} Encoded chunk.
 */
function chunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Create a solid-color RGB PNG, dependency-free (used to generate the store
 * placeholder cover and image fixtures in tests).
 * @param {number} width - Width in pixels.
 * @param {number} height - Height in pixels.
 * @param {[number, number, number]} rgb - Fill color.
 * @returns {Buffer} PNG file content.
 */
export function createSolidPng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type: truecolor RGB
  // compression, filter and interlace methods stay 0

  // Each scanline: 1 filter byte (0 = none) then width * RGB.
  const scanline = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    scanline[1 + x * 3] = r;
    scanline[2 + x * 3] = g;
    scanline[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => scanline));

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
