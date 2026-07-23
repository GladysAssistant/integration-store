export const SUPPORTED_MANIFEST_VERSION = 1;
export const INDEX_FORMAT = 1;

export const STORE_TOPIC = 'gladys-assistant-integration';
export const MANIFEST_FILE_NAME = 'gladys-assistant-integration.json';

export const DEFAULT_STORE_BASE_URL = 'https://gladysassistant.github.io/integration-store';
export const DEFAULT_OUTPUT_DIR = 'dist';

// Cover contract (C.1): JPEG or PNG, exactly 800x534 (the single format of internal
// integration covers, 3:2 ratio), 150 KB max.
export const COVER_WIDTH = 800;
export const COVER_HEIGHT = 534;
export const COVER_MAX_BYTES = 150 * 1024;
// Hard cap when downloading a cover: past this point we stop reading the body,
// the exact size does not matter anymore (it is already way above COVER_MAX_BYTES).
export const COVER_DOWNLOAD_CAP_BYTES = 1024 * 1024;

export const PLACEHOLDER_COVER_FILE_NAME = 'placeholder.png';

// A manifest is a small JSON file; anything bigger than this is not a manifest.
export const MANIFEST_MAX_BYTES = 100 * 1024;

// Mandatory user documentation (B.9): docs/<lang>.md for both project languages,
// at the root of the integration repository. Both files must exist and hold at
// least DOCS_MIN_CHARS characters, otherwise the integration is rejected; they
// are re-hosted next to the covers and referenced by the index (`docs` URLs).
export const DOCS_LANGUAGES = ['en', 'fr'];
export const DOCS_MIN_CHARS = 300;
// A documentation file is markdown text (images stay in the repo and are
// linked, not embedded); anything bigger than this is not a doc page.
export const DOCS_MAX_BYTES = 200 * 1024;

/**
 * Repository path of a documentation file, e.g. "docs/en.md".
 * @param {string} lang - Language code.
 * @returns {string} Path relative to the repository root.
 */
export function docsFilePath(lang) {
  return `docs/${lang}.md`;
}

// Timeout of every outbound HTTP request: a slow host must fail fast, not
// hang the whole indexing run.
export const REQUEST_TIMEOUT_MS = 30 * 1000;

export const REJECTION_LEVELS = {
  // The integration is NOT indexed.
  ERROR: 'error',
  // The integration IS indexed, with a degradation (e.g. placeholder cover).
  WARNING: 'warning',
};
