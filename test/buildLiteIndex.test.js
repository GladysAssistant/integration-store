import { readFileSync } from 'node:fs';

import { expect } from 'chai';

import { buildLiteIndex } from '../src/buildLiteIndex.js';
import { LITE_INDEX_MANIFEST_FIELDS } from '../src/constants.js';

const validManifest = JSON.parse(readFileSync(new URL('./fixtures/valid-manifest.json', import.meta.url), 'utf8'));
const providerManifest = JSON.parse(
  readFileSync(new URL('./fixtures/provider-manifest.json', import.meta.url), 'utf8'),
);

/**
 * Build an index entry as produced by buildIndex.
 * @param {string} storeSlug - "owner/repo".
 * @param {object} manifest - Validated manifest.
 * @returns {object} Index entry.
 */
function entry(storeSlug, manifest) {
  const fileName = storeSlug.replace('/', '--');
  return {
    store_slug: storeSlug,
    repo_url: `https://github.com/${storeSlug}`,
    entry_url: `https://store.example/integrations/${fileName}.json`,
    manifest,
    cover_url: `https://store.example/covers/${fileName}.jpg`,
    docs: { en: `https://store.example/docs/${fileName}/en.md`, fr: `https://store.example/docs/${fileName}/fr.md` },
    github: { stars: 12, pushed_at: '2026-07-10T12:00:00.000Z', owner_avatar_url: 'https://avatars.example/john' },
    categories: ['environment'],
    first_seen_at: '2026-01-05T09:00:00.000Z',
  };
}

describe('buildLiteIndex', () => {
  const index = {
    index_format: 1,
    generated_at: '2026-07-13T08:00:00.000Z',
    integrations: [entry('john/gladys-demo', validManifest), entry('jane/gladys-provider', providerManifest)],
  };

  it('should keep the document, the entries and their order, with each manifest reduced to the catalog fields', () => {
    expect(buildLiteIndex(index)).to.deep.equal({
      index_format: 1,
      generated_at: '2026-07-13T08:00:00.000Z',
      integrations: [
        {
          ...entry('john/gladys-demo', validManifest),
          manifest: {
            manifest_version: 1,
            type: 'device',
            name: validManifest.name,
            description: validManifest.description,
            version: validManifest.version,
            docker_image: validManifest.docker_image,
            gladys_version: validManifest.gladys_version,
            transports: validManifest.transports,
          },
        },
        {
          ...entry('jane/gladys-provider', providerManifest),
          // No `transports` in this manifest: an absent field stays absent.
          manifest: {
            manifest_version: 1,
            type: 'provider',
            name: providerManifest.name,
            description: providerManifest.description,
            version: providerManifest.version,
            docker_image: providerManifest.docker_image,
            gladys_version: providerManifest.gladys_version,
          },
        },
      ],
    });
  });

  it('should drop the install-time contracts of the manifest', () => {
    const [demo, provider] = buildLiteIndex(index).integrations;
    for (const field of ['config_schema', 'actions', 'containers', 'webhooks', 'cover_image', 'categories']) {
      expect(demo.manifest).to.not.have.property(field);
    }
    for (const field of ['widgets', 'scene_triggers', 'scene_actions']) {
      expect(provider.manifest).to.not.have.property(field);
    }
  });

  it('should be a strict subset of the index', () => {
    const liteIndex = buildLiteIndex(index);
    liteIndex.integrations.forEach((liteEntry, i) => {
      for (const [field, value] of Object.entries(liteEntry.manifest)) {
        expect(LITE_INDEX_MANIFEST_FIELDS).to.include(field);
        expect(value).to.deep.equal(index.integrations[i].manifest[field]);
      }
    });
  });

  it('should leave the index untouched', () => {
    const snapshot = structuredClone(index);
    buildLiteIndex(index);
    expect(index).to.deep.equal(snapshot);
  });
});
