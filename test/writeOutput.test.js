import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { buildLiteIndex } from '../src/buildLiteIndex.js';
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

  it('should write index.json, index-lite.json, rejected.json, the schemas, the covers, the placeholder and the docs', async () => {
    const index = { index_format: 1, generated_at: '2026-07-13T08:00:00.000Z', integrations: [] };
    const rejected = [{ store_slug: 'a/b', level: 'error', reason: 'nope', checked_at: '2026-07-13T08:00:00.000Z' }];
    const coverFiles = [{ fileName: 'john--demo.jpg', data: Buffer.from('jpeg-bytes') }];
    const docsFiles = [
      { fileName: 'john--demo/en.md', data: Buffer.from('# English docs') },
      { fileName: 'john--demo/fr.md', data: Buffer.from('# Doc française') },
    ];

    await writeOutput({ outputDir, index, rejected, coverFiles, docsFiles });

    expect(JSON.parse(await readFile(path.join(outputDir, 'index.json'), 'utf8'))).to.deep.equal(index);
    expect(JSON.parse(await readFile(path.join(outputDir, 'index-lite.json'), 'utf8'))).to.deep.equal(index);
    expect(JSON.parse(await readFile(path.join(outputDir, 'rejected.json'), 'utf8'))).to.deep.equal(rejected);

    const publishedSchema = JSON.parse(await readFile(path.join(outputDir, 'manifest.schema.json'), 'utf8'));
    expect(publishedSchema.$id).to.equal('https://gladysassistant.github.io/integration-store/manifest.schema.json');
    const publishedWidgetSchema = JSON.parse(
      await readFile(path.join(outputDir, 'widget-content.schema.json'), 'utf8'),
    );
    expect(publishedWidgetSchema.$id).to.equal(
      'https://gladysassistant.github.io/integration-store/widget-content.schema.json',
    );

    const cover = await readFile(path.join(outputDir, 'covers', 'john--demo.jpg'));
    expect(cover.toString()).to.equal('jpeg-bytes');

    const placeholder = await readFile(path.join(outputDir, 'covers', 'placeholder.png'));
    expect(validateCover(placeholder)).to.deep.equal({ ok: true, type: 'png' });

    const englishDoc = await readFile(path.join(outputDir, 'docs', 'john--demo', 'en.md'), 'utf8');
    expect(englishDoc).to.equal('# English docs');
    const frenchDoc = await readFile(path.join(outputDir, 'docs', 'john--demo', 'fr.md'), 'utf8');
    expect(frenchDoc).to.equal('# Doc française');
  });

  it('should derive index-lite.json from the index, without the heavy manifest fields', async () => {
    const manifest = {
      manifest_version: 1,
      type: 'device',
      name: 'Demo',
      description: { en: 'Demo', fr: 'Démo' },
      version: '1.0.0',
      docker_image: 'ghcr.io/john/demo:1.0.0',
      gladys_version: '>=4.86.0',
      config_schema: [{ key: 'api_key', type: 'secret', label: { en: 'API key', fr: "Clé d'API" } }],
    };
    const index = {
      index_format: 1,
      generated_at: '2026-07-13T08:00:00.000Z',
      integrations: [{ store_slug: 'john/demo', repo_url: 'https://github.com/john/demo', manifest }],
    };

    await writeOutput({ outputDir, index, rejected: [], coverFiles: [], docsFiles: [] });

    const liteIndex = JSON.parse(await readFile(path.join(outputDir, 'index-lite.json'), 'utf8'));
    expect(liteIndex).to.deep.equal(buildLiteIndex(index));
    expect(liteIndex.integrations[0].manifest).to.not.have.property('config_schema');
    expect(JSON.parse(await readFile(path.join(outputDir, 'index.json'), 'utf8'))).to.deep.equal(index);
  });

  it('should end the JSON files with a newline', async () => {
    await writeOutput({
      outputDir,
      index: { index_format: 1, generated_at: 'x', integrations: [] },
      rejected: [],
      coverFiles: [],
      docsFiles: [],
    });
    for (const fileName of ['index.json', 'index-lite.json', 'rejected.json']) {
      const raw = await readFile(path.join(outputDir, fileName), 'utf8');
      expect(raw.endsWith('\n')).to.equal(true);
    }
  });
});
