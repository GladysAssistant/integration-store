import { readFileSync } from 'node:fs';

import { expect } from 'chai';

import { buildIndex } from '../src/buildIndex.js';
import { COVER_HEIGHT, COVER_WIDTH } from '../src/constants.js';
import { createSolidPng, makeFakeJpeg } from './helpers/images.js';

const NOW = '2026-07-13T08:00:00.000Z';
const STORE_BASE_URL = 'https://gladysassistant.github.io/integration-store';

const validManifest = JSON.parse(readFileSync(new URL('./fixtures/valid-manifest.json', import.meta.url), 'utf8'));

/**
 * Build a repository entry as returned by searchRepositoriesByTopic.
 * @param {string} owner - Owner login.
 * @param {string} repo - Repository name.
 * @returns {object} Repository entry.
 */
function repository(owner, repo) {
  return {
    storeSlug: `${owner}/${repo}`,
    owner,
    repo,
    repoUrl: `https://github.com/${owner}/${repo}`,
    defaultBranch: 'main',
    stars: 12,
    pushedAt: '2026-07-10T12:00:00.000Z',
    ownerAvatarUrl: `https://avatars.githubusercontent.com/${owner}`,
  };
}

/**
 * Build a manifest variant from the reference fixture.
 * @param {object} overrides - Fields to override.
 * @returns {object} Manifest.
 */
function manifest(overrides = {}) {
  return { ...structuredClone(validManifest), ...overrides };
}

/**
 * Fake manifest fetcher backed by a map of slug → result.
 * @param {object} responses - Map of "owner/repo" → fetchManifestFile result.
 * @returns {Function} fetchManifestFile-compatible function.
 */
function fakeManifestFetcher(responses) {
  return async ({ owner, repo }) => responses[`${owner}/${repo}`];
}

/**
 * Fake cover downloader backed by a map of URL → result.
 * @param {object} responses - Map of URL → downloadCover result.
 * @returns {Function} downloadCover-compatible function.
 */
function fakeCoverDownloader(responses = {}) {
  return async ({ url }) => responses[url] ?? { status: 'error', reason: 'download failed (HTTP 404)' };
}

describe('buildIndex', () => {
  it('should index a valid integration with its re-hosted cover', async () => {
    const goodManifest = manifest({ cover_image: 'https://example.com/cover.jpg' });
    const { index, rejected, coverFiles } = await buildIndex({
      repositories: [repository('john', 'gladys-open-meteo-demo')],
      fetchManifestFile: fakeManifestFetcher({
        'john/gladys-open-meteo-demo': { status: 'ok', raw: JSON.stringify(goodManifest) },
      }),
      downloadCover: fakeCoverDownloader({
        'https://example.com/cover.jpg': { status: 'ok', data: makeFakeJpeg(COVER_WIDTH, COVER_HEIGHT) },
      }),
      storeBaseUrl: STORE_BASE_URL,
      now: NOW,
    });

    expect(index).to.deep.equal({
      index_format: 1,
      generated_at: NOW,
      integrations: [
        {
          store_slug: 'john/gladys-open-meteo-demo',
          repo_url: 'https://github.com/john/gladys-open-meteo-demo',
          manifest: goodManifest,
          cover_url: `${STORE_BASE_URL}/covers/john--gladys-open-meteo-demo.jpg`,
          github: {
            stars: 12,
            pushed_at: '2026-07-10T12:00:00.000Z',
            owner_avatar_url: 'https://avatars.githubusercontent.com/john',
          },
        },
      ],
    });
    expect(rejected).to.deep.equal([]);
    expect(coverFiles.map((f) => f.fileName)).to.deep.equal(['john--gladys-open-meteo-demo.jpg']);
  });

  it('should keep the png extension of a png cover', async () => {
    const goodManifest = manifest({ cover_image: 'https://example.com/cover.png' });
    const { coverFiles, index } = await buildIndex({
      repositories: [repository('john', 'demo')],
      fetchManifestFile: fakeManifestFetcher({ 'john/demo': { status: 'ok', raw: JSON.stringify(goodManifest) } }),
      downloadCover: fakeCoverDownloader({
        'https://example.com/cover.png': { status: 'ok', data: createSolidPng(COVER_WIDTH, COVER_HEIGHT, [1, 2, 3]) },
      }),
      storeBaseUrl: STORE_BASE_URL,
      now: NOW,
    });
    expect(coverFiles.map((f) => f.fileName)).to.deep.equal(['john--demo.png']);
    expect(index.integrations[0].cover_url).to.equal(`${STORE_BASE_URL}/covers/john--demo.png`);
  });

  it('should index with a placeholder and a warning when the cover is missing', async () => {
    const noCover = manifest();
    delete noCover.cover_image;
    const { index, rejected, coverFiles } = await buildIndex({
      repositories: [repository('bob', 'no-cover')],
      fetchManifestFile: fakeManifestFetcher({ 'bob/no-cover': { status: 'ok', raw: JSON.stringify(noCover) } }),
      downloadCover: fakeCoverDownloader(),
      storeBaseUrl: STORE_BASE_URL,
      now: NOW,
    });
    expect(index.integrations).to.have.lengthOf(1);
    expect(index.integrations[0].cover_url).to.equal(`${STORE_BASE_URL}/covers/placeholder.png`);
    expect(rejected).to.deep.equal([
      {
        store_slug: 'bob/no-cover',
        level: 'warning',
        reason: 'cover_image: missing — placeholder used',
        checked_at: NOW,
      },
    ]);
    expect(coverFiles).to.deep.equal([]);
  });

  it('should index with a placeholder and a warning when the cover is invalid', async () => {
    const badCover = manifest({ cover_image: 'https://example.com/big.jpg' });
    const { index, rejected } = await buildIndex({
      repositories: [repository('carol', 'bad-cover')],
      fetchManifestFile: fakeManifestFetcher({ 'carol/bad-cover': { status: 'ok', raw: JSON.stringify(badCover) } }),
      downloadCover: fakeCoverDownloader({
        'https://example.com/big.jpg': { status: 'ok', data: createSolidPng(1200, 800, [0, 0, 0]) },
      }),
      storeBaseUrl: STORE_BASE_URL,
      now: NOW,
    });
    expect(index.integrations[0].cover_url).to.equal(`${STORE_BASE_URL}/covers/placeholder.png`);
    expect(rejected).to.deep.equal([
      {
        store_slug: 'carol/bad-cover',
        level: 'warning',
        reason: 'cover_image: expected 800x534, got 1200x800 — placeholder used',
        checked_at: NOW,
      },
    ]);
  });

  it('should index with a placeholder and a warning when the cover download fails', async () => {
    const badCover = manifest({ cover_image: 'https://example.com/gone.jpg' });
    const { rejected } = await buildIndex({
      repositories: [repository('carol', 'gone-cover')],
      fetchManifestFile: fakeManifestFetcher({ 'carol/gone-cover': { status: 'ok', raw: JSON.stringify(badCover) } }),
      downloadCover: fakeCoverDownloader(),
      storeBaseUrl: STORE_BASE_URL,
      now: NOW,
    });
    expect(rejected).to.deep.equal([
      {
        store_slug: 'carol/gone-cover',
        level: 'warning',
        reason: 'cover_image: download failed (HTTP 404) — placeholder used',
        checked_at: NOW,
      },
    ]);
  });

  it('should reject a repository without manifest file', async () => {
    const { index, rejected } = await buildIndex({
      repositories: [repository('eve', 'no-manifest')],
      fetchManifestFile: fakeManifestFetcher({ 'eve/no-manifest': { status: 'not_found' } }),
      downloadCover: fakeCoverDownloader(),
      storeBaseUrl: STORE_BASE_URL,
      now: NOW,
    });
    expect(index.integrations).to.deep.equal([]);
    expect(rejected).to.deep.equal([
      {
        store_slug: 'eve/no-manifest',
        level: 'error',
        reason: 'gladys-assistant-integration.json: file not found at the root of the default branch',
        checked_at: NOW,
      },
    ]);
  });

  it('should reject a manifest that fails to download', async () => {
    const { rejected } = await buildIndex({
      repositories: [repository('heidi', 'flaky')],
      fetchManifestFile: fakeManifestFetcher({
        'heidi/flaky': { status: 'error', reason: 'download failed (HTTP 500)' },
      }),
      downloadCover: fakeCoverDownloader(),
      storeBaseUrl: STORE_BASE_URL,
      now: NOW,
    });
    expect(rejected).to.deep.equal([
      {
        store_slug: 'heidi/flaky',
        level: 'error',
        reason: 'gladys-assistant-integration.json: download failed (HTTP 500)',
        checked_at: NOW,
      },
    ]);
  });

  it('should reject a manifest with invalid JSON', async () => {
    const { rejected } = await buildIndex({
      repositories: [repository('frank', 'broken-json')],
      fetchManifestFile: fakeManifestFetcher({ 'frank/broken-json': { status: 'ok', raw: '{ not json' } }),
      downloadCover: fakeCoverDownloader(),
      storeBaseUrl: STORE_BASE_URL,
      now: NOW,
    });
    expect(rejected).to.deep.equal([
      {
        store_slug: 'frank/broken-json',
        level: 'error',
        reason: 'gladys-assistant-integration.json: invalid JSON',
        checked_at: NOW,
      },
    ]);
  });

  it('should reject an invalid manifest with the validation reasons', async () => {
    const badManifest = manifest({ version: '1.2' });
    const { rejected } = await buildIndex({
      repositories: [repository('dave', 'bad-semver')],
      fetchManifestFile: fakeManifestFetcher({ 'dave/bad-semver': { status: 'ok', raw: JSON.stringify(badManifest) } }),
      downloadCover: fakeCoverDownloader(),
      storeBaseUrl: STORE_BASE_URL,
      now: NOW,
    });
    expect(rejected).to.deep.equal([
      {
        store_slug: 'dave/bad-semver',
        level: 'error',
        reason: 'manifest.version: must be valid semver',
        checked_at: NOW,
      },
    ]);
  });

  it('should produce a deterministic output sorted by store_slug regardless of input order', async () => {
    const manifestA = manifest();
    delete manifestA.cover_image;
    const repositories = [repository('zoe', 'z-repo'), repository('adam', 'a-repo')];
    const fetchers = {
      fetchManifestFile: fakeManifestFetcher({
        'zoe/z-repo': { status: 'ok', raw: JSON.stringify(manifestA) },
        'adam/a-repo': { status: 'ok', raw: JSON.stringify(manifestA) },
      }),
      downloadCover: fakeCoverDownloader(),
      storeBaseUrl: STORE_BASE_URL,
      now: NOW,
    };
    const first = await buildIndex({ repositories, ...fetchers });
    const second = await buildIndex({ repositories: [...repositories].reverse(), ...fetchers });
    expect(first.index.integrations.map((i) => i.store_slug)).to.deep.equal(['adam/a-repo', 'zoe/z-repo']);
    expect(second.index).to.deep.equal(first.index);
    expect(second.rejected).to.deep.equal(first.rejected);
  });
});
