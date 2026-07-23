import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect } from 'chai';

import { COVER_HEIGHT, COVER_WIDTH, MANIFEST_FILE_NAME } from '../src/constants.js';
import { validateLocalIntegration } from '../src/validateLocal.js';
import { makeFakeJpeg } from './helpers/images.js';

const validManifest = JSON.parse(readFileSync(new URL('./fixtures/valid-manifest.json', import.meta.url), 'utf8'));

/**
 * Build a manifest variant from the reference fixture.
 * @param {object} overrides - Fields to override.
 * @returns {object} Manifest.
 */
function manifest(overrides = {}) {
  return { ...structuredClone(validManifest), ...overrides };
}

/**
 * Fake cover downloader backed by a map of URL → result.
 * @param {object} responses - Map of URL → downloadCover result.
 * @returns {Function} downloadCover-compatible function.
 */
function fakeCoverDownloader(responses = {}) {
  return async ({ url }) => responses[url] ?? { status: 'error', reason: 'download failed (HTTP 404)' };
}

/**
 * Fake Docker image checker backed by a map of reference → result.
 * @param {object} responses - Map of image reference → checkDockerImage result.
 * @returns {Function} checkDockerImage-compatible function.
 */
function fakeImageChecker(responses = {}) {
  return async ({ reference }) => responses[reference] ?? { status: 'ok' };
}

describe('validateLocalIntegration', () => {
  const temporaryDirs = [];

  afterEach(async () => {
    await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  // Valid documentation content, comfortably above the 300 characters minimum.
  const DOC_CONTENT = `# Demo integration\n\n${'Install the integration, configure your credentials and enjoy. '.repeat(6)}`;

  /**
   * Write a manifest file (and by default the mandatory docs/en.md and
   * docs/fr.md) in a fresh temporary directory, mimicking an integration
   * repository checkout.
   * @param {string} content - Raw manifest file content.
   * @param {object} [docs] - Map of language → docs file content; a language mapped to undefined is not written.
   * @returns {Promise<string>} Path of the written manifest.
   */
  async function writeManifestFile(content, docs = { en: DOC_CONTENT, fr: DOC_CONTENT }) {
    const dir = await mkdtemp(join(tmpdir(), 'integration-store-test-'));
    temporaryDirs.push(dir);
    const manifestPath = join(dir, MANIFEST_FILE_NAME);
    await writeFile(manifestPath, content);
    await mkdir(join(dir, 'docs'), { recursive: true });
    for (const [lang, docContent] of Object.entries(docs)) {
      if (docContent !== undefined) {
        await writeFile(join(dir, 'docs', `${lang}.md`), docContent);
      }
    }
    return manifestPath;
  }

  const workingCover = fakeCoverDownloader({
    [validManifest.cover_image]: { status: 'ok', data: makeFakeJpeg(COVER_WIDTH, COVER_HEIGHT) },
  });

  it('should report no problem for a valid integration', async () => {
    const manifestPath = await writeManifestFile(JSON.stringify(manifest()));
    const { problems } = await validateLocalIntegration({
      manifestPath,
      checkDockerImage: fakeImageChecker(),
      downloadCover: workingCover,
    });
    expect(problems).to.deep.equal([]);
  });

  it('should report no problem for a valid integration without sub-containers', async () => {
    const withoutContainers = manifest();
    delete withoutContainers.containers;
    const manifestPath = await writeManifestFile(JSON.stringify(withoutContainers));
    const { problems } = await validateLocalIntegration({
      manifestPath,
      checkDockerImage: fakeImageChecker(),
      downloadCover: workingCover,
    });
    expect(problems).to.deep.equal([]);
  });

  it('should report an error for each missing documentation file', async () => {
    const manifestPath = await writeManifestFile(JSON.stringify(manifest()), { en: undefined, fr: undefined });
    const { problems } = await validateLocalIntegration({
      manifestPath,
      checkDockerImage: fakeImageChecker(),
      downloadCover: workingCover,
    });
    expect(problems).to.deep.equal([
      { level: 'error', reason: 'docs/en.md: file not found — user documentation is mandatory' },
      { level: 'error', reason: 'docs/fr.md: file not found — user documentation is mandatory' },
    ]);
  });

  it('should report an error when a documentation file is too short', async () => {
    const manifestPath = await writeManifestFile(JSON.stringify(manifest()), { en: DOC_CONTENT, fr: '  # TODO  ' });
    const { problems } = await validateLocalIntegration({
      manifestPath,
      checkDockerImage: fakeImageChecker(),
      downloadCover: workingCover,
    });
    expect(problems).to.deep.equal([
      { level: 'error', reason: 'docs/fr.md: must hold at least 300 characters of user documentation' },
    ]);
  });

  it('should report an error when the manifest file cannot be read', async () => {
    const { problems } = await validateLocalIntegration({
      manifestPath: '/nonexistent/gladys-assistant-integration.json',
      checkDockerImage: fakeImageChecker(),
      downloadCover: workingCover,
    });
    expect(problems).to.have.lengthOf(1);
    expect(problems[0].level).to.equal('error');
    expect(problems[0].reason).to.include('cannot read /nonexistent/gladys-assistant-integration.json');
  });

  it('should report an error when the manifest is not valid JSON', async () => {
    const manifestPath = await writeManifestFile('{ not json');
    const { problems } = await validateLocalIntegration({
      manifestPath,
      checkDockerImage: fakeImageChecker(),
      downloadCover: workingCover,
    });
    expect(problems).to.deep.equal([{ level: 'error', reason: 'invalid JSON' }]);
  });

  it('should report every schema error and skip the remote checks on an invalid manifest', async () => {
    const manifestPath = await writeManifestFile(JSON.stringify(manifest({ name: 'ab', version: 'not-semver' })));
    let remoteChecks = 0;
    const countingChecker = async () => {
      remoteChecks += 1;
      return { status: 'ok' };
    };
    const { problems } = await validateLocalIntegration({
      manifestPath,
      checkDockerImage: countingChecker,
      downloadCover: countingChecker,
    });
    expect(problems.map((problem) => problem.level)).to.deep.equal(['error']);
    expect(problems[0].reason).to.include('manifest.name');
    expect(remoteChecks).to.equal(0);
  });

  it('should report all missing Docker images instead of stopping at the first one', async () => {
    const manifestPath = await writeManifestFile(JSON.stringify(manifest()));
    const { problems } = await validateLocalIntegration({
      manifestPath,
      checkDockerImage: fakeImageChecker({
        [validManifest.docker_image]: { status: 'error', reason: 'image not found on registry "ghcr.io" (HTTP 404)' },
        [validManifest.containers[0].docker_image]: {
          status: 'error',
          reason: 'image not found on registry "registry-1.docker.io" (HTTP 404)',
        },
      }),
      downloadCover: workingCover,
    });
    expect(problems).to.deep.equal([
      { level: 'error', reason: 'docker_image: image not found on registry "ghcr.io" (HTTP 404)' },
      {
        level: 'error',
        reason: 'containers.0.docker_image: image not found on registry "registry-1.docker.io" (HTTP 404)',
      },
    ]);
  });

  it('should report a warning when a registry check is transiently unverified', async () => {
    const manifestPath = await writeManifestFile(JSON.stringify(manifest()));
    const { problems } = await validateLocalIntegration({
      manifestPath,
      checkDockerImage: fakeImageChecker({
        [validManifest.containers[0].docker_image]: {
          status: 'unverified',
          reason: 'registry check failed (HTTP 503)',
        },
      }),
      downloadCover: workingCover,
    });
    expect(problems).to.deep.equal([
      {
        level: 'warning',
        reason:
          'containers.0.docker_image: registry check failed (HTTP 503) — the indexer would index without image verification',
      },
    ]);
  });

  it('should report a warning when the cover_image is missing', async () => {
    const withoutCover = manifest();
    delete withoutCover.cover_image;
    const manifestPath = await writeManifestFile(JSON.stringify(withoutCover));
    const { problems } = await validateLocalIntegration({
      manifestPath,
      checkDockerImage: fakeImageChecker(),
      downloadCover: workingCover,
    });
    expect(problems).to.deep.equal([
      { level: 'warning', reason: 'cover_image: missing — the placeholder cover would be used' },
    ]);
  });

  it('should report a warning when the cover cannot be downloaded', async () => {
    const manifestPath = await writeManifestFile(JSON.stringify(manifest()));
    const { problems } = await validateLocalIntegration({
      manifestPath,
      checkDockerImage: fakeImageChecker(),
      downloadCover: fakeCoverDownloader(),
    });
    expect(problems).to.deep.equal([
      { level: 'warning', reason: 'cover_image: download failed (HTTP 404) — the placeholder cover would be used' },
    ]);
  });

  it('should report a warning when the cover violates the contract', async () => {
    const manifestPath = await writeManifestFile(JSON.stringify(manifest()));
    const { problems } = await validateLocalIntegration({
      manifestPath,
      checkDockerImage: fakeImageChecker(),
      downloadCover: fakeCoverDownloader({
        [validManifest.cover_image]: { status: 'ok', data: makeFakeJpeg(100, 100) },
      }),
    });
    expect(problems).to.deep.equal([
      { level: 'warning', reason: 'cover_image: expected 800x534, got 100x100 — the placeholder cover would be used' },
    ]);
  });
});
