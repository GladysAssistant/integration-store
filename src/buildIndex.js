import {
  DOCS_LANGUAGES,
  DOCS_MIN_CHARS,
  INDEX_FORMAT,
  MANIFEST_FILE_NAME,
  PLACEHOLDER_COVER_FILE_NAME,
  REJECTION_LEVELS,
  docsFilePath,
} from './constants.js';
import { validateCover } from './validateCover.js';
import { validateManifest } from './validateManifest.js';

/**
 * File name of a re-hosted cover, e.g. "john--gladys-open-meteo-demo.jpg".
 * @param {object} repository - Repository entry.
 * @param {'jpg'|'png'} type - Detected image type.
 * @returns {string} File name.
 */
function coverFileName(repository, type) {
  return `${repository.owner}--${repository.repo}.${type}`;
}

/**
 * Fetch and parse the manifest of a repository.
 * @param {object} repository - Repository entry.
 * @param {Function} fetchManifestFile - Injected fetcher.
 * @returns {Promise<{manifest: object}|{rejectionReason: string}>} Parsed manifest or rejection reason.
 */
async function resolveManifest(repository, fetchManifestFile) {
  const result = await fetchManifestFile({
    owner: repository.owner,
    repo: repository.repo,
    defaultBranch: repository.defaultBranch,
  });
  if (result.status === 'not_found') {
    return { rejectionReason: `${MANIFEST_FILE_NAME}: file not found at the root of the default branch` };
  }
  if (result.status === 'error') {
    return { rejectionReason: `${MANIFEST_FILE_NAME}: ${result.reason}` };
  }
  try {
    return { manifest: JSON.parse(result.raw) };
  } catch {
    return { rejectionReason: `${MANIFEST_FILE_NAME}: invalid JSON` };
  }
}

/**
 * Fetch and validate the mandatory user documentation (docs/en.md and
 * docs/fr.md, B.9): both files must exist and hold at least DOCS_MIN_CHARS
 * characters, otherwise the integration is rejected. Valid files are re-hosted
 * next to the covers, and the index references the re-hosted URLs (C.6).
 * @param {object} repository - Repository entry.
 * @param {Function} fetchDocFile - Injected doc fetcher.
 * @param {string} storeBaseUrl - Public base URL of the published store.
 * @returns {Promise<{docs: object, docsFiles: {fileName: string, data: Buffer}[]}|{rejectionReason: string}>} Re-hosted URLs and files, or rejection reason.
 */
async function resolveDocs(repository, fetchDocFile, storeBaseUrl) {
  const docs = {};
  const docsFiles = [];
  for (const lang of DOCS_LANGUAGES) {
    const path = docsFilePath(lang);
    const result = await fetchDocFile({
      owner: repository.owner,
      repo: repository.repo,
      defaultBranch: repository.defaultBranch,
      lang,
    });
    if (result.status === 'not_found') {
      return { rejectionReason: `${path}: file not found — user documentation is mandatory` };
    }
    if (result.status === 'error') {
      return { rejectionReason: `${path}: ${result.reason}` };
    }
    if (result.raw.trim().length < DOCS_MIN_CHARS) {
      return { rejectionReason: `${path}: must hold at least ${DOCS_MIN_CHARS} characters of user documentation` };
    }
    const fileName = `${repository.owner}--${repository.repo}/${lang}.md`;
    docs[lang] = `${storeBaseUrl}/docs/${fileName}`;
    docsFiles.push({ fileName, data: Buffer.from(result.raw, 'utf8') });
  }
  return { docs, docsFiles };
}

/**
 * Download, validate and prepare the re-hosting of a cover. A missing or
 * invalid cover never rejects the integration: it gets the placeholder and a
 * warning is published in rejected.json (C.1).
 * @param {object} repository - Repository entry.
 * @param {object} manifest - Validated manifest.
 * @param {Function} downloadCover - Injected downloader.
 * @param {string} storeBaseUrl - Public base URL of the published store.
 * @returns {Promise<{coverUrl: string, coverFile: {fileName: string, data: Buffer}|null, warning: string|null}>} Result.
 */
async function resolveCover(repository, manifest, downloadCover, storeBaseUrl) {
  const placeholder = {
    coverUrl: `${storeBaseUrl}/covers/${PLACEHOLDER_COVER_FILE_NAME}`,
    coverFile: null,
  };
  if (manifest.cover_image === undefined) {
    return { ...placeholder, warning: 'cover_image: missing — placeholder used' };
  }
  const downloaded = await downloadCover({ url: manifest.cover_image });
  if (downloaded.status === 'error') {
    return { ...placeholder, warning: `cover_image: ${downloaded.reason} — placeholder used` };
  }
  const validation = validateCover(downloaded.data);
  if (!validation.ok) {
    return { ...placeholder, warning: `cover_image: ${validation.reason} — placeholder used` };
  }
  const fileName = coverFileName(repository, validation.type);
  return {
    coverUrl: `${storeBaseUrl}/covers/${fileName}`,
    coverFile: { fileName, data: downloaded.data },
    warning: null,
  };
}

/**
 * Build the store index from the repositories tagged with the store topic:
 * fetch each manifest, validate it (schema + code rules), check the mandatory
 * user documentation (docs/en.md + docs/fr.md, re-hosted), check that the
 * Docker images (main and sub-containers) actually exist on their registry,
 * validate and re-host each cover, and produce the deterministic
 * index.json / rejected.json contents
 * (C.6) plus the cover and documentation files to publish.
 * @param {object} options - Options.
 * @param {object[]} options.repositories - Output of searchRepositoriesByTopic.
 * @param {Function} options.fetchManifestFile - Manifest fetcher (injectable for tests).
 * @param {Function} options.fetchDocFile - Documentation fetcher (injectable for tests).
 * @param {Function} options.checkDockerImage - Docker image existence checker (injectable for tests).
 * @param {Function} options.downloadCover - Cover downloader (injectable for tests).
 * @param {string} options.storeBaseUrl - Public base URL of the published store, no trailing slash.
 * @param {string} options.now - ISO 8601 timestamp of the crawl (injected: keeps the output deterministic).
 * @returns {Promise<{index: object, rejected: object[], coverFiles: {fileName: string, data: Buffer}[], docsFiles: {fileName: string, data: Buffer}[]}>} Build result.
 */
export async function buildIndex({
  repositories,
  fetchManifestFile,
  fetchDocFile,
  checkDockerImage,
  downloadCover,
  storeBaseUrl,
  now,
}) {
  const integrations = [];
  const rejected = [];
  const coverFiles = [];
  const allDocsFiles = [];

  const sortedRepositories = [...repositories].sort((a, b) => a.storeSlug.localeCompare(b.storeSlug));

  for (const repository of sortedRepositories) {
    const reject = (level, reason) => {
      rejected.push({ store_slug: repository.storeSlug, level, reason, checked_at: now });
    };

    const { manifest, rejectionReason } = await resolveManifest(repository, fetchManifestFile);
    if (rejectionReason !== undefined) {
      reject(REJECTION_LEVELS.ERROR, rejectionReason);
      continue;
    }

    const validation = validateManifest(manifest);
    if (!validation.valid) {
      reject(REJECTION_LEVELS.ERROR, validation.errors.join('; '));
      continue;
    }

    // Mandatory user documentation (B.9): absent or too small → rejection. The
    // fine structure of the files (template sections) stays conventional.
    const {
      docs,
      docsFiles,
      rejectionReason: docsRejectionReason,
    } = await resolveDocs(repository, fetchDocFile, storeBaseUrl);
    if (docsRejectionReason !== undefined) {
      reject(REJECTION_LEVELS.ERROR, docsRejectionReason);
      continue;
    }

    // A definitive registry verdict (image missing, not anonymously pullable)
    // rejects the integration: a catalog entry must have an image at the end —
    // the sub-container images follow the exact same rule. A transient registry
    // failure must not evict an integration that may already be published: it
    // is indexed with a warning instead.
    const imageReferences = [
      { path: 'docker_image', reference: manifest.docker_image },
      ...(manifest.containers ?? []).map((container, i) => ({
        path: `containers.${i}.docker_image`,
        reference: container.docker_image,
      })),
    ];
    let missingImage = false;
    for (const { path, reference } of imageReferences) {
      const imageCheck = await checkDockerImage({ reference });
      if (imageCheck.status === 'error') {
        reject(REJECTION_LEVELS.ERROR, `${path}: ${imageCheck.reason}`);
        missingImage = true;
        break;
      }
      if (imageCheck.status === 'unverified') {
        reject(REJECTION_LEVELS.WARNING, `${path}: ${imageCheck.reason} — indexed without image verification`);
      }
    }
    if (missingImage) {
      continue;
    }

    const { coverUrl, coverFile, warning } = await resolveCover(repository, manifest, downloadCover, storeBaseUrl);
    if (warning !== null) {
      reject(REJECTION_LEVELS.WARNING, warning);
    }
    if (coverFile !== null) {
      coverFiles.push(coverFile);
    }
    allDocsFiles.push(...docsFiles);

    integrations.push({
      store_slug: repository.storeSlug,
      repo_url: repository.repoUrl,
      manifest,
      cover_url: coverUrl,
      docs,
      github: {
        stars: repository.stars,
        pushed_at: repository.pushedAt,
        owner_avatar_url: repository.ownerAvatarUrl,
      },
    });
  }

  return {
    index: { index_format: INDEX_FORMAT, generated_at: now, integrations },
    rejected,
    coverFiles,
    docsFiles: allDocsFiles,
  };
}
