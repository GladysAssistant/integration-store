import {
  COVER_DOWNLOAD_CAP_BYTES,
  COVER_MAX_BYTES,
  MANIFEST_FILE_NAME,
  MANIFEST_MAX_BYTES,
  REQUEST_TIMEOUT_MS,
} from './constants.js';
import { isForbiddenHost } from './isForbiddenHost.js';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const USER_AGENT = 'gladys-integration-store-indexer';
// The GitHub search API never returns more than 1000 results.
const SEARCH_MAX_RESULTS = 1000;
// The search API has its own strict rate limit (~30 requests/minute): a
// transient hit is retried with a bounded backoff instead of failing the run.
const SEARCH_MAX_ATTEMPTS = 3;
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
 * Search all public repositories tagged with a topic. Publishing an
 * integration IS adding this topic to a public repo: this list is the
 * decentralized source of truth of the store.
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
  const repositories = [];
  let page = 1;
  let attempt = 1;
  for (;;) {
    const url = `${GITHUB_API_BASE_URL}/search/repositories?q=${encodeURIComponent(
      `topic:${topic} is:public`,
    )}&per_page=${perPage}&page=${page}`;
    const response = await fetchFn(url, {
      headers: buildApiHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (isRateLimited(response) && attempt < SEARCH_MAX_ATTEMPTS) {
        const delayMs = rateLimitDelayMs(response, nowFn());
        logger.warn(
          `GitHub search rate limited (HTTP ${response.status}), retrying in ${Math.round(delayMs / 1000)}s` +
            ` (attempt ${attempt}/${SEARCH_MAX_ATTEMPTS})...`,
        );
        await sleepFn(delayMs);
        attempt += 1;
        continue;
      }
      throw new Error(`GitHub repository search failed (HTTP ${response.status})`);
    }
    attempt = 1;
    const body = await response.json();
    repositories.push(
      ...body.items.map((item) => ({
        storeSlug: item.full_name,
        owner: item.owner.login,
        repo: item.name,
        repoUrl: item.html_url,
        defaultBranch: item.default_branch,
        stars: item.stargazers_count,
        pushedAt: item.pushed_at,
        ownerAvatarUrl: item.owner.avatar_url,
      })),
    );
    if (body.items.length < perPage) {
      return repositories;
    }
    if (page * perPage >= maxResults) {
      logger.warn(
        `GitHub search API cap reached (${maxResults} results): some integrations may be missing from the index.`,
      );
      return repositories;
    }
    page += 1;
  }
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
