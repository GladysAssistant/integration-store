import { LITE_INDEX_MANIFEST_FIELDS } from './constants.js';

/**
 * Build index-lite.json from index.json: the same document — same
 * index_format, generated_at, entries, order and entry fields — with each
 * manifest reduced to LITE_INDEX_MANIFEST_FIELDS. It is a strict subset of
 * index.json, so a consumer reading only those fields can switch from one to
 * the other by changing the URL. Gladys keeps reading index.json, which
 * carries the full manifests it needs to install and run an integration.
 * @param {object} index - index.json content (buildIndex output).
 * @returns {object} index-lite.json content.
 */
export function buildLiteIndex(index) {
  return {
    ...index,
    integrations: index.integrations.map((entry) => ({
      ...entry,
      manifest: Object.fromEntries(
        LITE_INDEX_MANIFEST_FIELDS.filter((field) => entry.manifest[field] !== undefined).map((field) => [
          field,
          entry.manifest[field],
        ]),
      ),
    })),
  };
}
