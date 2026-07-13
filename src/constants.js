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

export const REJECTION_LEVELS = {
  // The integration is NOT indexed.
  ERROR: 'error',
  // The integration IS indexed, with a degradation (e.g. placeholder cover).
  WARNING: 'warning',
};
