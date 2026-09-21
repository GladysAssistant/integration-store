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

// Controlled vocabulary of the catalog browse categories
// (integration-catalog-categories.md §3). The manifest schema deliberately
// carries no enum: the schema rejects the shape only, and this list filters
// as a second stage — unknown keys are dropped with a warning, never a
// rejection, so a manifest published with a newer vocabulary than a running
// Gladys instance still installs. Adding a key here follows the governance
// rules of the spec (≥3 concrete candidate integrations, same-diff update of
// the core enum and of the spec).
export const INTEGRATION_CATALOG_CATEGORIES = [
  'climate',
  'lighting',
  'energy',
  'security',
  'multimedia',
  'appliances',
  'environment',
  'protocols',
  'network',
  'notifications',
  'assistants',
  'services',
];

// Older Gladys releases validate manifests with a strict field allowlist and
// reject any unknown top-level field — or unknown `type` value — at
// install/update time. A manifest declaring one of the fields below must
// therefore require at least the first release whose validator accepts it,
// which turns a cryptic install failure on old instances into the standard
// "requires Gladys ≥ X" catalog filter (integration-catalog-categories.md
// §6.2, generalized to every later addition of the manifest contract).
export const MANIFEST_FIELD_MIN_GLADYS_VERSION = {
  categories: '4.86.0',
  // capability fields: dashboard widgets (capabilities/dashboard-widgets.md)
  // and scene triggers / actions (capabilities/scene-triggers-and-actions.md)
  widgets: '5.0.5',
  scene_triggers: '5.0.5',
  scene_actions: '5.0.5',
};
// Same gate for the `type` values added after the first release: an older
// core rejects an unknown type with "must be one of device, communication…".
export const MANIFEST_TYPE_MIN_GLADYS_VERSION = {
  // capabilities/provider-type.md: an integration made only of capabilities
  provider: '5.0.5',
};

// The capability fields (capabilities/provider-type.md): contracts the core
// does not consume through a dedicated interface, declarable by every type on
// top of its primary contract. A `provider` integration — no device surface,
// no core-consumed interface — must declare at least one of them (the rule
// lives in the schema, its explicit error message in validateManifest).
export const CAPABILITY_MANIFEST_FIELDS = ['widgets', 'scene_triggers', 'scene_actions'];

// Timeout of every outbound HTTP request: a slow host must fail fast, not
// hang the whole indexing run.
export const REQUEST_TIMEOUT_MS = 30 * 1000;

export const REJECTION_LEVELS = {
  // The integration is NOT indexed.
  ERROR: 'error',
  // The integration IS indexed, with a degradation (e.g. placeholder cover).
  WARNING: 'warning',
};
