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

// Valid documentation content, comfortably above the 300 characters minimum.
const DOC_CONTENT = `# Demo integration\n\n${'Install the integration, configure your credentials and enjoy. '.repeat(6)}`;

/**
 * Fake documentation fetcher backed by a map of "owner/repo/lang" → result;
 * any file not listed in the map is served as a valid documentation page.
 * @param {object} responses - Map of "owner/repo/lang" → fetchDocFile result.
 * @returns {Function} fetchDocFile-compatible function.
 */
function fakeDocFetcher(responses = {}) {
  return async ({ owner, repo, lang }) => responses[`${owner}/${repo}/${lang}`] ?? { status: 'ok', raw: DOC_CONTENT };
}

/**
 * Fake Docker image checker backed by a map of reference → result.
 * @param {object} responses - Map of image reference → checkDockerImage result.
 * @returns {Function} checkDockerImage-compatible function.
 */
function fakeImageChecker(responses = {}) {
  return async ({ reference }) => responses[reference] ?? { status: 'ok' };
}

describe('buildIndex', () => {
  it('should index a valid integration with its re-hosted cover', async () => {
    const goodManifest = manifest({ cover_image: 'https://example.com/cover.jpg' });
    const { index, rejected, coverFiles, docsFiles } = await buildIndex({
      repositories: [repository('john', 'gladys-open-meteo-demo')],
      fetchManifestFile: fakeManifestFetcher({
        'john/gladys-open-meteo-demo': { status: 'ok', raw: JSON.stringify(goodManifest) },
      }),
      checkDockerImage: fakeImageChecker(),
      fetchDocFile: fakeDocFetcher(),
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
          docs: {
            en: `${STORE_BASE_URL}/docs/john--gladys-open-meteo-demo/en.md`,
            fr: `${STORE_BASE_URL}/docs/john--gladys-open-meteo-demo/fr.md`,
          },
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
    expect(docsFiles).to.deep.equal([
      { fileName: 'john--gladys-open-meteo-demo/en.md', data: Buffer.from(DOC_CONTENT, 'utf8') },
      { fileName: 'john--gladys-open-meteo-demo/fr.md', data: Buffer.from(DOC_CONTENT, 'utf8') },
    ]);
  });

  it('should reject an integration whose documentation file is missing', async () => {
    const goodManifest = manifest();
    const { index, rejected, docsFiles } = await buildIndex({
      repositories: [repository('nora', 'no-docs')],
      fetchManifestFile: fakeManifestFetcher({ 'nora/no-docs': { status: 'ok', raw: JSON.stringify(goodManifest) } }),
      checkDockerImage: fakeImageChecker(),
      fetchDocFile: fakeDocFetcher({ 'nora/no-docs/fr': { status: 'not_found' } }),
      downloadCover: fakeCoverDownloader(),
      storeBaseUrl: STORE_BASE_URL,
      now: NOW,
    });
    expect(index.integrations).to.deep.equal([]);
    expect(docsFiles).to.deep.equal([]);
    expect(rejected).to.deep.equal([
      {
        store_slug: 'nora/no-docs',
        level: 'error',
        reason: 'docs/fr.md: file not found — user documentation is mandatory',
        checked_at: NOW,
      },
    ]);
  });

  it('should reject an integration whose documentation is too short', async () => {
    const goodManifest = manifest();
    const { index, rejected } = await buildIndex({
      repositories: [repository('nora', 'thin-docs')],
      fetchManifestFile: fakeManifestFetcher({ 'nora/thin-docs': { status: 'ok', raw: JSON.stringify(goodManifest) } }),
      checkDockerImage: fakeImageChecker(),
      fetchDocFile: fakeDocFetcher({ 'nora/thin-docs/en': { status: 'ok', raw: '  # TODO  ' } }),
      downloadCover: fakeCoverDownloader(),
      storeBaseUrl: STORE_BASE_URL,
      now: NOW,
    });
    expect(index.integrations).to.deep.equal([]);
    expect(rejected).to.deep.equal([
      {
        store_slug: 'nora/thin-docs',
        level: 'error',
        reason: 'docs/en.md: must hold at least 300 characters of user documentation',
        checked_at: NOW,
      },
    ]);
  });

  it('should reject an integration whose documentation fails to download', async () => {
    const goodManifest = manifest();
    const { index, rejected } = await buildIndex({
      repositories: [repository('nora', 'flaky-docs')],
      fetchManifestFile: fakeManifestFetcher({
        'nora/flaky-docs': { status: 'ok', raw: JSON.stringify(goodManifest) },
      }),
      checkDockerImage: fakeImageChecker(),
      fetchDocFile: fakeDocFetcher({ 'nora/flaky-docs/en': { status: 'error', reason: 'download failed (HTTP 500)' } }),
      downloadCover: fakeCoverDownloader(),
      storeBaseUrl: STORE_BASE_URL,
      now: NOW,
    });
    expect(index.integrations).to.deep.equal([]);
    expect(rejected).to.deep.equal([
      {
        store_slug: 'nora/flaky-docs',
        level: 'error',
        reason: 'docs/en.md: download failed (HTTP 500)',
        checked_at: NOW,
      },
    ]);
  });

  it('should keep the png extension of a png cover', async () => {
    const goodManifest = manifest({ cover_image: 'https://example.com/cover.png' });
    const { coverFiles, index } = await buildIndex({
      repositories: [repository('john', 'demo')],
      fetchManifestFile: fakeManifestFetcher({ 'john/demo': { status: 'ok', raw: JSON.stringify(goodManifest) } }),
      checkDockerImage: fakeImageChecker(),
      fetchDocFile: fakeDocFetcher(),
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
      checkDockerImage: fakeImageChecker(),
      fetchDocFile: fakeDocFetcher(),
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
      checkDockerImage: fakeImageChecker(),
      fetchDocFile: fakeDocFetcher(),
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
      checkDockerImage: fakeImageChecker(),
      fetchDocFile: fakeDocFetcher(),
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
      checkDockerImage: fakeImageChecker(),
      fetchDocFile: fakeDocFetcher(),
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
      checkDockerImage: fakeImageChecker(),
      fetchDocFile: fakeDocFetcher(),
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
      checkDockerImage: fakeImageChecker(),
      fetchDocFile: fakeDocFetcher(),
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
      checkDockerImage: fakeImageChecker(),
      fetchDocFile: fakeDocFetcher(),
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

  it('should reject an integration whose Docker image does not exist', async () => {
    const goodManifest = manifest();
    const { index, rejected } = await buildIndex({
      repositories: [repository('mallory', 'ghost-image')],
      fetchManifestFile: fakeManifestFetcher({
        'mallory/ghost-image': { status: 'ok', raw: JSON.stringify(goodManifest) },
      }),
      checkDockerImage: fakeImageChecker({
        [goodManifest.docker_image]: {
          status: 'error',
          reason: 'image not found on registry "ghcr.io" (HTTP 404)',
        },
      }),
      fetchDocFile: fakeDocFetcher(),
      downloadCover: fakeCoverDownloader(),
      storeBaseUrl: STORE_BASE_URL,
      now: NOW,
    });
    expect(index.integrations).to.deep.equal([]);
    expect(rejected).to.deep.equal([
      {
        store_slug: 'mallory/ghost-image',
        level: 'error',
        reason: 'docker_image: image not found on registry "ghcr.io" (HTTP 404)',
        checked_at: NOW,
      },
    ]);
  });

  it('should index with a warning when the Docker image cannot be verified', async () => {
    const goodManifest = manifest({ cover_image: 'https://example.com/cover.jpg' });
    const { index, rejected } = await buildIndex({
      repositories: [repository('grace', 'flaky-registry')],
      fetchManifestFile: fakeManifestFetcher({
        'grace/flaky-registry': { status: 'ok', raw: JSON.stringify(goodManifest) },
      }),
      checkDockerImage: fakeImageChecker({
        [goodManifest.docker_image]: { status: 'unverified', reason: 'registry check failed (HTTP 503)' },
      }),
      fetchDocFile: fakeDocFetcher(),
      downloadCover: fakeCoverDownloader({
        'https://example.com/cover.jpg': { status: 'ok', data: makeFakeJpeg(COVER_WIDTH, COVER_HEIGHT) },
      }),
      storeBaseUrl: STORE_BASE_URL,
      now: NOW,
    });
    expect(index.integrations).to.have.lengthOf(1);
    expect(rejected).to.deep.equal([
      {
        store_slug: 'grace/flaky-registry',
        level: 'warning',
        reason: 'docker_image: registry check failed (HTTP 503) — indexed without image verification',
        checked_at: NOW,
      },
    ]);
  });

  it('should reject an integration whose sub-container image does not exist', async () => {
    const goodManifest = manifest();
    const { index, rejected } = await buildIndex({
      repositories: [repository('mallory', 'ghost-sub-image')],
      fetchManifestFile: fakeManifestFetcher({
        'mallory/ghost-sub-image': { status: 'ok', raw: JSON.stringify(goodManifest) },
      }),
      checkDockerImage: fakeImageChecker({
        [goodManifest.containers[0].docker_image]: {
          status: 'error',
          reason: 'image not found on registry "registry-1.docker.io" (HTTP 404)',
        },
      }),
      fetchDocFile: fakeDocFetcher(),
      downloadCover: fakeCoverDownloader(),
      storeBaseUrl: STORE_BASE_URL,
      now: NOW,
    });
    expect(index.integrations).to.deep.equal([]);
    expect(rejected).to.deep.equal([
      {
        store_slug: 'mallory/ghost-sub-image',
        level: 'error',
        reason: 'containers.0.docker_image: image not found on registry "registry-1.docker.io" (HTTP 404)',
        checked_at: NOW,
      },
    ]);
  });

  it('should index with a warning when a sub-container image cannot be verified', async () => {
    const goodManifest = manifest({ cover_image: 'https://example.com/cover.jpg' });
    const { index, rejected } = await buildIndex({
      repositories: [repository('grace', 'flaky-sub-registry')],
      fetchManifestFile: fakeManifestFetcher({
        'grace/flaky-sub-registry': { status: 'ok', raw: JSON.stringify(goodManifest) },
      }),
      checkDockerImage: fakeImageChecker({
        [goodManifest.containers[0].docker_image]: { status: 'unverified', reason: 'registry check failed (HTTP 503)' },
      }),
      fetchDocFile: fakeDocFetcher(),
      downloadCover: fakeCoverDownloader({
        'https://example.com/cover.jpg': { status: 'ok', data: makeFakeJpeg(COVER_WIDTH, COVER_HEIGHT) },
      }),
      storeBaseUrl: STORE_BASE_URL,
      now: NOW,
    });
    expect(index.integrations).to.have.lengthOf(1);
    expect(rejected).to.deep.equal([
      {
        store_slug: 'grace/flaky-sub-registry',
        level: 'warning',
        reason: 'containers.0.docker_image: registry check failed (HTTP 503) — indexed without image verification',
        checked_at: NOW,
      },
    ]);
  });

  it('should produce a deterministic output sorted by store_slug regardless of input order', async () => {
    const manifestA = manifest();
    delete manifestA.cover_image;
    // No sub-container: only the main image goes through the registry check.
    delete manifestA.containers;
    const repositories = [repository('zoe', 'z-repo'), repository('adam', 'a-repo')];
    const fetchers = {
      fetchManifestFile: fakeManifestFetcher({
        'zoe/z-repo': { status: 'ok', raw: JSON.stringify(manifestA) },
        'adam/a-repo': { status: 'ok', raw: JSON.stringify(manifestA) },
      }),
      checkDockerImage: fakeImageChecker(),
      fetchDocFile: fakeDocFetcher(),
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
