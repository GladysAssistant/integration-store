import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { validateCover } from '../src/validateCover.js';
import { writeOutput } from '../src/writeOutput.js';

describe('writeOutput', () => {
  let outputDir;

  beforeEach(async () => {
    outputDir = await mkdtemp(path.join(os.tmpdir(), 'integration-store-test-'));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it('should write index.json, rejected.json, the schema, the covers and the placeholder', async () => {
    const index = { index_format: 1, generated_at: '2026-07-13T08:00:00.000Z', integrations: [] };
    const rejected = [{ store_slug: 'a/b', level: 'error', reason: 'nope', checked_at: '2026-07-13T08:00:00.000Z' }];
    const coverFiles = [{ fileName: 'john--demo.jpg', data: Buffer.from('jpeg-bytes') }];

    await writeOutput({ outputDir, index, rejected, coverFiles });

    expect(JSON.parse(await readFile(path.join(outputDir, 'index.json'), 'utf8'))).to.deep.equal(index);
    expect(JSON.parse(await readFile(path.join(outputDir, 'rejected.json'), 'utf8'))).to.deep.equal(rejected);

    const publishedSchema = JSON.parse(await readFile(path.join(outputDir, 'manifest.schema.json'), 'utf8'));
    expect(publishedSchema.$id).to.equal('https://gladysassistant.github.io/integration-store/manifest.schema.json');

    const cover = await readFile(path.join(outputDir, 'covers', 'john--demo.jpg'));
    expect(cover.toString()).to.equal('jpeg-bytes');

    const placeholder = await readFile(path.join(outputDir, 'covers', 'placeholder.png'));
    expect(validateCover(placeholder)).to.deep.equal({ ok: true, type: 'png' });
  });

  it('should end the JSON files with a newline', async () => {
    await writeOutput({
      outputDir,
      index: { index_format: 1, generated_at: 'x', integrations: [] },
      rejected: [],
      coverFiles: [],
    });
    const raw = await readFile(path.join(outputDir, 'index.json'), 'utf8');
    expect(raw.endsWith('\n')).to.equal(true);
  });
});
