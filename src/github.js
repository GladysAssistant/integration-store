import { COVER_DOWNLOAD_CAP_BYTES, MANIFEST_FILE_NAME, MANIFEST_MAX_BYTES } from './constants.js';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const USER_AGENT = 'gladys-integration-store-indexer';
// The GitHub search API never returns more than 1000 results.
const SEARCH_MAX_RESULTS = 1000;

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
 * @returns {Promise<object[]>} Repositories with the metadata used by the index.
 */
export async function searchRepositoriesByTopic({
  topic,
  token,
  fetchFn = fetch,
  perPage = 100,
  maxResults = SEARCH_MAX_RESULTS,
  logger = console,
}) {
  const repositories = [];
  let page = 1;
  for (;;) {
    const url = `${GITHUB_API_BASE_URL}/search/repositories?q=${encodeURIComponent(
      `topic:${topic} is:public`,
    )}&per_page=${perPage}&page=${page}`;
    const response = await fetchFn(url, { headers: buildApiHeaders(token) });
    if (!response.ok) {
      throw new Error(`GitHub repository search failed (HTTP ${response.status})`);
    }
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
  const response = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT } });
  if (response.status === 404) {
    return { status: 'not_found' };
  }
  if (!response.ok) {
    return { status: 'error', reason: `download failed (HTTP ${response.status})` };
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > MANIFEST_MAX_BYTES) {
    return { status: 'error', reason: `file too large (> ${MANIFEST_MAX_BYTES / 1024} KB)` };
  }
  return { status: 'ok', raw };
}

/**
 * Download a cover image, reading at most COVER_DOWNLOAD_CAP_BYTES: past that
 * point the cover is already way above the 150 KB contract, no need to keep
 * downloading an arbitrarily large file.
 * @param {object} options - Options.
 * @param {string} options.url - HTTPS URL of the cover.
 * @param {Function} [options.fetchFn] - fetch implementation, injectable for tests.
 * @returns {Promise<{status: 'ok', data: Buffer}|{status: 'error', reason: string}>} Result.
 */
export async function downloadCover({ url, fetchFn = fetch }) {
  let response;
  try {
    response = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT } });
  } catch (e) {
    return { status: 'error', reason: `download failed (${e.message})` };
  }
  if (!response.ok) {
    return { status: 'error', reason: `download failed (HTTP ${response.status})` };
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
    if (totalLength > COVER_DOWNLOAD_CAP_BYTES) {
      await reader.cancel();
      return {
        status: 'error',
        reason: `expected ≤ 150 KB, got more than ${COVER_DOWNLOAD_CAP_BYTES / 1024} KB`,
      };
    }
  }
  return { status: 'ok', data: Buffer.concat(chunks) };
}
