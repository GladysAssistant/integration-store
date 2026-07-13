export { createSolidPng } from '../../scripts/lib/createSolidPng.js';

/**
 * Build a minimal-but-well-formed JPEG header (SOI + APP0 + SOF0 + EOI)
 * declaring the given dimensions — enough for magic-byte detection and
 * dimension parsing, without needing a real encoder in tests.
 * @param {number} width - Declared width.
 * @param {number} height - Declared height.
 * @returns {Buffer} Fake JPEG bytes.
 */
export function makeFakeJpeg(width, height) {
  const soi = Buffer.from([0xff, 0xd8]);

  const app0 = Buffer.alloc(18);
  app0[0] = 0xff;
  app0[1] = 0xe0;
  app0.writeUInt16BE(16, 2);
  app0.write('JFIF\0', 4, 'latin1');

  const sof0 = Buffer.alloc(19);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(17, 2);
  sof0[4] = 8; // precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 3; // component count

  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sof0, eoi]);
}
