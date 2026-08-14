import { REQUEST_TIMEOUT_MS } from './constants.js';

const USER_AGENT = 'gladys-integration-store-indexer';

/**
 * Fetch the index published by the previous crawl, from the store's own
 * public URL. It carries the `first_seen_at` of every already-indexed
 * integration ("Newest first" sort, integration-catalog-categories.md §4):
 * the value must survive every rebuild, so a store that already published an
 * index refuses to rebuild without it — a transient failure here would
 * otherwise silently re-seed every date, reshuffling the catalog sort. A 404
 * is not a failure: it is the first crawl of a fresh store (or a local dry
 * run against a base URL that serves nothing), where there is genuinely
 * nothing to carry over.
 * @param {object} options - Options.
 * @param {string} options.storeBaseUrl - Public base URL of the published store, no trailing slash.
 * @param {Function} [options.fetchFn] - fetch implementation, injectable for tests.
 * @returns {Promise<object|null>} Previous index, or null when none is published yet.
 */
export async function fetchPreviousIndex({ storeBaseUrl, fetchFn = fetch }) {
  const url = `${storeBaseUrl}/index.json`;
  const response = await fetchFn(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`previous index download failed (HTTP ${response.status}): refusing to rebuild without it`);
  }
  let index;
  try {
    index = await response.json();
  } catch {
    throw new Error('previous index is not valid JSON: refusing to rebuild without it');
  }
  if (index === null || typeof index !== 'object' || !Array.isArray(index.integrations)) {
    throw new Error('previous index has an unexpected shape: refusing to rebuild without it');
  }
  return index;
}
