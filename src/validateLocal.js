import { readFile } from 'node:fs/promises';

import { REJECTION_LEVELS } from './constants.js';
import { validateCover } from './validateCover.js';
import { validateManifest } from './validateManifest.js';

/**
 * Run, against a local manifest file, the same admission checks the hourly
 * indexer applies to a published repository: JSON parsing, JSON Schema + code
 * rules, Docker image existence on the registry (main and sub-containers),
 * cover contract. Problems carry the same error/warning levels as
 * rejected.json: an error means the integration would be rejected, a warning
 * means it would be indexed with a degradation.
 *
 * Unlike the indexer, image checks do not stop at the first definitive
 * failure: a local run reports everything at once so the developer fixes it
 * all in one pass. What only exists once published (public repo, store topic,
 * manifest at the root of the default branch) is out of scope.
 * @param {object} options - Options.
 * @param {string} options.manifestPath - Path of the local gladys-assistant-integration.json.
 * @param {Function} options.checkDockerImage - Docker image existence checker (injectable for tests).
 * @param {Function} options.downloadCover - Cover downloader (injectable for tests).
 * @returns {Promise<{problems: {level: string, reason: string}[]}>} Problems, empty when the integration would be indexed cleanly.
 */
export async function validateLocalIntegration({ manifestPath, checkDockerImage, downloadCover }) {
  const problems = [];
  const error = (reason) => problems.push({ level: REJECTION_LEVELS.ERROR, reason });
  const warning = (reason) => problems.push({ level: REJECTION_LEVELS.WARNING, reason });

  let raw;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (e) {
    error(`cannot read ${manifestPath} (${e.message})`);
    return { problems };
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    error('invalid JSON');
    return { problems };
  }

  const validation = validateManifest(manifest);
  if (!validation.valid) {
    validation.errors.forEach(error);
    return { problems };
  }

  const imageReferences = [
    { path: 'docker_image', reference: manifest.docker_image },
    ...(manifest.containers ?? []).map((container, i) => ({
      path: `containers.${i}.docker_image`,
      reference: container.docker_image,
    })),
  ];
  for (const { path, reference } of imageReferences) {
    const imageCheck = await checkDockerImage({ reference });
    if (imageCheck.status === 'error') {
      error(`${path}: ${imageCheck.reason}`);
    } else if (imageCheck.status === 'unverified') {
      warning(`${path}: ${imageCheck.reason} — the indexer would index without image verification`);
    }
  }

  if (manifest.cover_image === undefined) {
    warning('cover_image: missing — the placeholder cover would be used');
  } else {
    const downloaded = await downloadCover({ url: manifest.cover_image });
    if (downloaded.status === 'error') {
      warning(`cover_image: ${downloaded.reason} — the placeholder cover would be used`);
    } else {
      const coverValidation = validateCover(downloaded.data);
      if (!coverValidation.ok) {
        warning(`cover_image: ${coverValidation.reason} — the placeholder cover would be used`);
      }
    }
  }

  return { problems };
}
