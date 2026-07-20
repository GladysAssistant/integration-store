import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  /**
   * Write a manifest file in a fresh temporary directory.
   * @param {string} content - Raw file content.
   * @returns {Promise<string>} Path of the written manifest.
   */
  async function writeManifestFile(content) {
    const dir = await mkdtemp(join(tmpdir(), 'integration-store-test-'));
    temporaryDirs.push(dir);
    const manifestPath = join(dir, MANIFEST_FILE_NAME);
    await writeFile(manifestPath, content);
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
