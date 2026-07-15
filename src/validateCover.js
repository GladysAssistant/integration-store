import { imageSize } from 'image-size';

import { COVER_HEIGHT, COVER_MAX_BYTES, COVER_WIDTH } from './constants.js';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Detect the image type from magic bytes — the declared URL extension or
 * Content-Type is never trusted.
 * @param {Buffer} data - Raw image bytes.
 * @returns {'jpg'|'png'|null} Detected type, or null.
 */
function detectImageType(data) {
  if (data.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return 'jpg';
  }
  if (data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return 'png';
  }
  return null;
}

/**
 * Validate a downloaded cover against the C.1 contract: JPEG or PNG magic
 * bytes, exactly 800x534 pixels, 150 KB max.
 * @param {Buffer} data - Raw image bytes.
 * @returns {{ok: true, type: 'jpg'|'png'}|{ok: false, reason: string}} Validation result.
 */
export function validateCover(data) {
  if (data.length > COVER_MAX_BYTES) {
    return {
      ok: false,
      reason: `expected ≤ ${COVER_MAX_BYTES / 1024} KB, got ${Math.ceil(data.length / 1024)} KB`,
    };
  }
  const type = detectImageType(data);
  if (type === null) {
    return { ok: false, reason: 'must be a JPEG or PNG image' };
  }
  let dimensions;
  try {
    dimensions = imageSize(data);
  } catch {
    return { ok: false, reason: 'could not read image dimensions' };
  }
  if (dimensions.width !== COVER_WIDTH || dimensions.height !== COVER_HEIGHT) {
    return {
      ok: false,
      reason: `expected ${COVER_WIDTH}x${COVER_HEIGHT}, got ${dimensions.width}x${dimensions.height}`,
    };
  }
  return { ok: true, type };
}
