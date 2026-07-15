import { readFileSync } from 'node:fs';

import { expect } from 'chai';

import { COVER_HEIGHT, COVER_MAX_BYTES, COVER_WIDTH } from '../src/constants.js';
import { validateCover } from '../src/validateCover.js';
import { createSolidPng, makeFakeJpeg } from './helpers/images.js';

describe('validateCover', () => {
  it('should accept a valid 800x534 PNG', () => {
    expect(validateCover(createSolidPng(COVER_WIDTH, COVER_HEIGHT, [10, 20, 30]))).to.deep.equal({
      ok: true,
      type: 'png',
    });
  });

  it('should accept a valid 800x534 JPEG', () => {
    expect(validateCover(makeFakeJpeg(COVER_WIDTH, COVER_HEIGHT))).to.deep.equal({ ok: true, type: 'jpg' });
  });

  it('should accept the committed placeholder cover', () => {
    const placeholder = readFileSync(new URL('../assets/placeholder-cover.png', import.meta.url));
    expect(validateCover(placeholder)).to.deep.equal({ ok: true, type: 'png' });
    expect(placeholder.length).to.be.at.most(COVER_MAX_BYTES);
  });

  it('should reject a file over 150 KB before anything else', () => {
    expect(validateCover(Buffer.alloc(160 * 1024))).to.deep.equal({
      ok: false,
      reason: 'expected ≤ 150 KB, got 160 KB',
    });
  });

  it('should reject a non-image file', () => {
    expect(validateCover(Buffer.from('<html>not an image</html>'))).to.deep.equal({
      ok: false,
      reason: 'must be a JPEG or PNG image',
    });
  });

  it('should reject a GIF (magic bytes, not extension, decide)', () => {
    expect(validateCover(Buffer.from('GIF89a...'))).to.deep.equal({
      ok: false,
      reason: 'must be a JPEG or PNG image',
    });
  });

  it('should reject an image with wrong dimensions', () => {
    expect(validateCover(createSolidPng(1200, 800, [0, 0, 0]))).to.deep.equal({
      ok: false,
      reason: 'expected 800x534, got 1200x800',
    });
  });

  it('should reject a truncated image whose dimensions cannot be read', () => {
    const truncatedJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(validateCover(truncatedJpeg)).to.deep.equal({ ok: false, reason: 'could not read image dimensions' });
  });
});
