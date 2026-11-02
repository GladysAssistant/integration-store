import {
  COVER_DOWNLOAD_CAP_BYTES,
  COVER_MAX_BYTES,
  DOCS_MAX_BYTES,
  MANIFEST_FILE_NAME,
  MANIFEST_MAX_BYTES,
  REQUEST_TIMEOUT_MS,
  docsFilePath,
} from './constants.js';
import { isForbiddenHost } from './isForbiddenHost.js';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const USER_AGENT = 'gladys-integration-store-indexer';
// The GitHub search API never returns more than 1000 results per query,
// whatever the pagination. Past that size the topic is crawled by slices of
// repository creation date (`created:from..to`): a slice holding more than
// the cap is split in two, recursively, until every slice fits. A creation
// date never changes, so the slices are disjoint and together cover the
// whole topic — no integration is left behind.
const SEARCH_MAX_RESULTS = 1000;
// Lower bound of the creation-date slicing: GitHub's oldest repositories date
// from October 2007, no public repository predates this.
const SEARCH_CREATED_FLOOR_MS = Date.UTC(2007, 0, 1);
// Granularity of the `created:` qualifier: one second. A slice reduced to a
// single second cannot be split further (only matters if more than
// SEARCH_MAX_RESULTS tagged repositories were created in that very second).
const SEARCH_SLICE_STEP_MS = 1000;
// The search API has its own strict rate limit (~30 requests/minute): a
// transient hit is retried with a bounded backoff instead of failing the run.
// Same bound for a page flagged `incomplete_results` (the search timed out
// server-side and its total_count is unreliable), retried after a delay.
const SEARCH_MAX_ATTEMPTS = 3;
// A slice is paginated again when it ends up with fewer repositories than
// its total_count (a page drifted while it was paginated), up to this many
// passes before giving up with a warning.
const SLICE_MAX_PASSES = 3;
const RATE_LIMIT_DEFAULT_DELAY_MS = 10 * 1000;
const RATE_LIMIT_MAX_DELAY_MS = 60 * 1000;

/**
 * Build the headers of a GitHub API request.
 * @param {string|undefined} token - Optional GitHub token.
 * @returns {object} Headers.
 */
function buildApiHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Read a response body in streaming, giving up as soon as it exceeds
 * maxBytes — never buffer an attacker-sized body before checking its size.
 * @param {Response} response - Fetch response.
 * @param {number} maxBytes - Hard cap on the number of bytes read.
 * @returns {Promise<{ok: true, data: Buffer}|{ok: false}>} Body, or ok:false when over the cap.
 */
async function readBodyWithCap(response, maxBytes) {
  if (response.body === null) {
    return { ok: true, data: Buffer.alloc(0) };
  }
  const chunks = [];
  let totalLength = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(Buffer.from(value));
    totalLength += value.length;
    if (totalLength > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
  }
  return { ok: true, data: Buffer.concat(chunks) };
}

/**
 * Tell whether a response is a rate-limit rejection: HTTP 429, or the
 * GitHub-style 403 carrying rate-limit headers (a plain 403 — bad token,
 * blocked request — is not retried).
 * @param {Response} response - Fetch response.
 * @returns {boolean} True when the request should be retried later.
 */
function isRateLimited(response) {
  if (response.status === 429) {
    return true;
  }
  return (
    response.status === 403 &&
    (response.headers.get('retry-after') !== null || response.headers.get('x-ratelimit-remaining') === '0')
  );
}

/**
 * Delay to wait before retrying a rate-limited request, honoring Retry-After
 * then x-ratelimit-reset, bounded by RATE_LIMIT_MAX_DELAY_MS.
 * @param {Response} response - Rate-limited fetch response.
 * @param {number} nowMs - Current epoch time in milliseconds.
 * @returns {number} Delay in milliseconds.
 */
function rateLimitDelayMs(response, nowMs) {
  const retryAfterSeconds = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, RATE_LIMIT_MAX_DELAY_MS);
  }
  const resetEpochSeconds = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(resetEpochSeconds) && resetEpochSeconds * 1000 > nowMs) {
    return Math.min(resetEpochSeconds * 1000 - nowMs, RATE_LIMIT_MAX_DELAY_MS);
  }
  return RATE_LIMIT_DEFAULT_DELAY_MS;
}

/**
 * Format an epoch time for the `created:` search qualifier, at the second
 * granularity GitHub accepts (e.g. "2026-01-05T09:00:00Z").
 * @param {number} epochMs - Epoch time in milliseconds (second-aligned).
 * @returns {string} ISO 8601 timestamp without milliseconds.
 */
function searchTimestamp(epochMs) {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Search all public repositories tagged with a topic. Publishing an
 * integration IS adding this topic to a public repo: this list is the
 * decentralized source of truth of the store.
 *
 * The search API caps every query at SEARCH_MAX_RESULTS results, so the topic
 * is searched by slices of repository creation date: the whole range first
 * (2008 to now), then — each time a slice reports more results than the cap —
 * its two halves, recursively, until every slice fits and is paginated through.
 * A store under the cap still costs a single query; a bigger one costs a
 * handful of extra probes, well within the search rate limit of a run.
 * @param {object} options - Options.
 * @param {string} options.topic - GitHub topic to search.
 * @param {string} [options.token] - GitHub token (higher rate limit); optional.
 * @param {Function} [options.fetchFn] - fetch implementation, injectable for tests.
 * @param {number} [options.perPage] - Page size, injectable for tests.
 * @param {number} [options.maxResults] - GitHub search API result cap, injectable for tests.
 * @param {object} [options.logger] - Logger, console-compatible.
 * @param {Function} [options.sleepFn] - Delay function, injectable for tests.
 * @param {Function} [options.nowFn] - Clock, injectable for tests.
 * @returns {Promise<object[]>} Repositories with the metadata used by the index.
 */
export async function searchRepositoriesByTopic({
  topic,
  token,
  fetchFn = fetch,
  perPage = 100,
  maxResults = SEARCH_MAX_RESULTS,
  logger = console,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowFn = Date.now,
}) {
  /**
   * Fetch one page of a search query, retrying a rate-limited response with
   * a bounded backoff, and a page flagged incomplete after a short delay.
   * @param {string} query - Search query (qualifiers).
   * @param {number} page - Page number (1-based).
   * @returns {Promise<{total_count: number, items: object[]}>} Search API body.
   */
  async function fetchSearchPage(query, page) {
    // An explicit sort: the default "best match" order is not guaranteed
    // stable from one page request to the next, and an unstable order
    // repeats some repositories across pages while skipping others. Newest
    // update first: a repository updated while its slice is paginated moves
    // to the front, so only that repository can be missed (it jumps to a
    // page already fetched), and the others, shifted later, are at worst
    // seen twice. crawlSlice detects the miss and paginates the slice again.
    const url =
      `${GITHUB_API_BASE_URL}/search/repositories?q=${encodeURIComponent(query)}` +
      `&sort=updated&order=desc&per_page=${perPage}&page=${page}`;
    let attempt = 1;
    for (;;) {
      const response = await fetchFn(url, {
        headers: buildApiHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = await response.json();
        if (!body.incomplete_results || attempt >= SEARCH_MAX_ATTEMPTS) {
          return body;
        }
        logger.warn(
          `GitHub search returned incomplete results (search timed out), retrying in ${RATE_LIMIT_DEFAULT_DELAY_MS / 1000}s` +
            ` (attempt ${attempt}/${SEARCH_MAX_ATTEMPTS})...`,
        );
        await sleepFn(RATE_LIMIT_DEFAULT_DELAY_MS);
        attempt += 1;
        continue;
      }
      if (!isRateLimited(response) || attempt >= SEARCH_MAX_ATTEMPTS) {
        throw new Error(`GitHub repository search failed (HTTP ${response.status})`);
      }
      const delayMs = rateLimitDelayMs(response, nowFn());
      logger.warn(
        `GitHub search rate limited (HTTP ${response.status}), retrying in ${Math.round(delayMs / 1000)}s` +
          ` (attempt ${attempt}/${SEARCH_MAX_ATTEMPTS})...`,
      );
      await sleepFn(delayMs);
      attempt += 1;
    }
  }

  // Keyed by full name: a repository can only be created once, so the slices
  // never overlap — the map absorbs a repository seen twice when a page
  // drifts while its slice is paginated.
  const repositories = new Map();

  /**
   * Crawl every tagged repository created within [fromMs, toMs] (inclusive,
   * second-aligned bounds), splitting the slice when it exceeds the cap.
   * A slice that ends up with fewer repositories than its total_count (a
   * page drifted while it was paginated) is paginated again, a few times.
   * @param {number} fromMs - Start of the slice, epoch milliseconds.
   * @param {number} toMs - End of the slice, epoch milliseconds.
   * @returns {Promise<void>} Resolves once the slice is fully collected.
   */
  async function crawlSlice(fromMs, toMs) {
    const range = `${searchTimestamp(fromMs)}..${searchTimestamp(toMs)}`;
    const query = `topic:${topic} is:public created:${range}`;
    let pass = 1;
    for (;;) {
      const body = await fetchSearchPage(query, 1);
      if (body.total_count > maxResults && toMs > fromMs) {
        // Split at a second boundary: [from, mid] and [mid + 1 s, to] are
        // both non-empty and disjoint.
        const midMs = fromMs + Math.floor((toMs - fromMs) / (2 * SEARCH_SLICE_STEP_MS)) * SEARCH_SLICE_STEP_MS;
        await crawlSlice(fromMs, midMs);
        await crawlSlice(midMs + SEARCH_SLICE_STEP_MS, toMs);
        return;
      }
      const collected = await paginateSlice(query, body, range);
      if (collected === null || collected >= body.total_count) {
        return;
      }
      if (pass >= SLICE_MAX_PASSES) {
        logger.warn(
          `GitHub search slice ${range} still incomplete after ${pass} passes (${collected}/${body.total_count} collected):` +
            ' some integrations may be missing from the index.',
        );
        return;
      }
      logger.warn(
        `GitHub search slice ${range} drifted while paginated (${collected}/${body.total_count} collected), ` +
          `crawling it again (pass ${pass}/${SLICE_MAX_PASSES})...`,
      );
      pass += 1;
    }
  }

  /**
   * Collect every page of a slice known to fit in the cap, starting from its
   * already fetched first page.
   * @param {string} query - Search query of the slice.
   * @param {{total_count: number, items: object[]}} firstPage - Body of page 1.
   * @param {string} range - Creation-date range of the slice, for the logs.
   * @returns {Promise<number|null>} Number of distinct repositories collected, or null when the cap cut the slice short.
   */
  async function paginateSlice(query, firstPage, range) {
    const collected = new Set();
    let page = 1;
    let body = firstPage;
    for (;;) {
      for (const item of body.items) {
        collected.add(item.full_name);
        repositories.set(item.full_name, {
          storeSlug: item.full_name,
          owner: item.owner.login,
          repo: item.name,
          repoUrl: item.html_url,
          defaultBranch: item.default_branch,
          stars: item.stargazers_count,
          // Repository creation date: the one-time backfill seed of
          // first_seen_at for entries indexed before the field existed —
          // never pushed_at, a documentation commit would reshuffle the
          // catalog's "Newest first" sort.
          createdAt: item.created_at,
          pushedAt: item.pushed_at,
          ownerAvatarUrl: item.owner.avatar_url,
        });
      }
      if (body.items.length < perPage || page * perPage >= body.total_count) {
        return collected.size;
      }
      if (page * perPage >= maxResults) {
        logger.warn(
          `GitHub search API cap reached (${maxResults} results) on an unsplittable slice (${range}):` +
            ' some integrations may be missing from the index.',
        );
        return null;
      }
      page += 1;
      body = await fetchSearchPage(query, page);
    }
  }

  // Upper bound rounded up to the next second so that a repository created
  // during the very millisecond of the call is still covered.
  const nowMs = Math.ceil(nowFn() / SEARCH_SLICE_STEP_MS) * SEARCH_SLICE_STEP_MS;
  await crawlSlice(SEARCH_CREATED_FLOOR_MS, nowMs);
  return [...repositories.values()];
}

/**
 * Fetch the raw manifest file at the root of a repository default branch.
 * @param {object} options - Options.
 * @param {string} options.owner - Repository owner.
 * @param {string} options.repo - Repository name.
 * @param {string} options.defaultBranch - Default branch of the repository.
 * @param {Function} [options.fetchFn] - fetch implementation, injectable for tests.
 * @returns {Promise<{status: 'ok', raw: string}|{status: 'not_found'}|{status: 'error', reason: string}>} Result.
 */
export async function fetchManifestFile({ owner, repo, defaultBranch, fetchFn = fetch }) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(
    defaultBranch,
  )}/${MANIFEST_FILE_NAME}`;
  try {
    const response = await fetchFn(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) {
      return { status: 'not_found' };
    }
    if (!response.ok) {
      return { status: 'error', reason: `download failed (HTTP ${response.status})` };
    }
    const body = await readBodyWithCap(response, MANIFEST_MAX_BYTES);
    if (!body.ok) {
      return { status: 'error', reason: `file too large (> ${MANIFEST_MAX_BYTES / 1024} KB)` };
    }
    return { status: 'ok', raw: body.data.toString('utf8') };
  } catch (e) {
    return { status: 'error', reason: `download failed (${e.message})` };
  }
}

/**
 * Fetch a raw user documentation file (docs/<lang>.md) from a repository
 * default branch. Same transport as the manifest: raw.githubusercontent, hard
 * timeout, capped body size.
 * @param {object} options - Options.
 * @param {string} options.owner - Repository owner.
 * @param {string} options.repo - Repository name.
 * @param {string} options.defaultBranch - Default branch of the repository.
 * @param {string} options.lang - Language code of the file (e.g. "en").
 * @param {Function} [options.fetchFn] - fetch implementation, injectable for tests.
 * @returns {Promise<{status: 'ok', raw: string}|{status: 'not_found'}|{status: 'error', reason: string}>} Result.
 */
export async function fetchDocFile({ owner, repo, defaultBranch, lang, fetchFn = fetch }) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(
    defaultBranch,
  )}/${docsFilePath(lang)}`;
  try {
    const response = await fetchFn(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) {
      return { status: 'not_found' };
    }
    if (!response.ok) {
      return { status: 'error', reason: `download failed (HTTP ${response.status})` };
    }
    const body = await readBodyWithCap(response, DOCS_MAX_BYTES);
    if (!body.ok) {
      return { status: 'error', reason: `file too large (> ${DOCS_MAX_BYTES / 1024} KB)` };
    }
    return { status: 'ok', raw: body.data.toString('utf8') };
  } catch (e) {
    return { status: 'error', reason: `download failed (${e.message})` };
  }
}

/**
 * Download a cover image. The URL comes straight from a third-party manifest,
 * so it is treated as hostile: https only, no private/reserved destination,
 * no redirect followed, 30 s timeout, and at most COVER_DOWNLOAD_CAP_BYTES
 * read (past that the cover is already way above the 150 KB contract).
 * @param {object} options - Options.
 * @param {string} options.url - HTTPS URL of the cover.
 * @param {Function} [options.fetchFn] - fetch implementation, injectable for tests.
 * @returns {Promise<{status: 'ok', data: Buffer}|{status: 'error', reason: string}>} Result.
 */
export async function downloadCover({ url, fetchFn = fetch }) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { status: 'error', reason: 'invalid URL' };
  }
  if (parsedUrl.protocol !== 'https:') {
    return { status: 'error', reason: 'only https URLs are allowed' };
  }
  if (isForbiddenHost(parsedUrl.hostname)) {
    return { status: 'error', reason: 'forbidden host (private or reserved address)' };
  }
  try {
    const response = await fetchFn(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      return {
        status: 'error',
        reason: `redirect not followed (HTTP ${response.status}) — serve the cover from a direct URL`,
      };
    }
    if (!response.ok) {
      return { status: 'error', reason: `download failed (HTTP ${response.status})` };
    }
    const body = await readBodyWithCap(response, COVER_DOWNLOAD_CAP_BYTES);
    if (!body.ok) {
      return {
        status: 'error',
        reason: `expected ≤ ${COVER_MAX_BYTES / 1024} KB, got more than ${COVER_DOWNLOAD_CAP_BYTES / 1024} KB`,
      };
    }
    return { status: 'ok', data: body.data };
  } catch (e) {
    return { status: 'error', reason: `download failed (${e.message})` };
  }
}
