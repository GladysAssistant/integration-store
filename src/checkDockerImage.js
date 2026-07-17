// Existence check of the `docker_image` reference against its registry,
// through the Docker Registry HTTP API v2 (the protocol spoken by Docker Hub,
// GHCR, Quay, GitLab, self-hosted registries...): anonymous Bearer token when
// the registry asks for one, then a HEAD on the manifest of the tag/digest.
// A HEAD never downloads the image and, on Docker Hub, does not count against
// the anonymous pull rate limit.

import { REQUEST_TIMEOUT_MS } from './constants.js';
import { isForbiddenHost } from './isForbiddenHost.js';
import { parseDockerImageReference } from './parseDockerImageReference.js';

const USER_AGENT = 'gladys-integration-store-indexer';

// Docker Hub is the only registry with legacy naming quirks: several aliases
// for its domain, a dedicated API host, and an implicit "library/" namespace
// for official images ("redis" is really "library/redis").
const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);
const DOCKER_HUB_REGISTRY = 'registry-1.docker.io';

// Accept every manifest flavor a registry may store: Docker v2 (single image
// and multi-arch list) and their OCI equivalents. Without these a registry
// can answer 404 for an image that does exist.
const MANIFEST_ACCEPT = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
].join(', ');

/**
 * Resolve the registry host and repository path of an image name, applying
 * the Docker rule: the first path component is a registry domain only when it
 * contains a "." or a ":" or is "localhost"; otherwise the name lives on
 * Docker Hub ("redis" → "library/redis" on registry-1.docker.io).
 * @param {string} name - Image name without tag or digest, e.g. "ghcr.io/john/demo".
 * @returns {{registry: string, repository: string}} Registry host and repository path.
 */
function resolveRegistryRepository(name) {
  const slashIndex = name.indexOf('/');
  const firstComponent = slashIndex === -1 ? '' : name.slice(0, slashIndex);
  const isDomain = firstComponent.includes('.') || firstComponent.includes(':') || firstComponent === 'localhost';
  if (!isDomain) {
    return { registry: DOCKER_HUB_REGISTRY, repository: slashIndex === -1 ? `library/${name}` : name };
  }
  const repository = name.slice(slashIndex + 1);
  if (DOCKER_HUB_ALIASES.has(firstComponent.toLowerCase())) {
    return {
      registry: DOCKER_HUB_REGISTRY,
      repository: repository.includes('/') ? repository : `library/${repository}`,
    };
  }
  return { registry: firstComponent, repository };
}

/**
 * Parse a `WWW-Authenticate: Bearer realm="...",service="..."` challenge.
 * @param {string|null} header - Header value, or null when absent.
 * @returns {{realm: string, service: string|null}|null} Challenge parameters, or null when not a Bearer challenge.
 */
function parseBearerChallenge(header) {
  if (header === null || !/^bearer\s/i.test(header)) {
    return null;
  }
  const params = {};
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) {
    params[match[1].toLowerCase()] = match[2];
  }
  if (params.realm === undefined) {
    return null;
  }
  return { realm: params.realm, service: params.service ?? null };
}

/**
 * HEAD the manifest of an image reference on its registry.
 * @param {string} url - Manifest URL.
 * @param {string|null} token - Bearer token, or null for an anonymous request.
 * @param {Function} fetchFn - fetch implementation.
 * @returns {Promise<Response>} Fetch response.
 */
async function headManifest(url, token, fetchFn) {
  const headers = { 'User-Agent': USER_AGENT, Accept: MANIFEST_ACCEPT };
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetchFn(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/**
 * Fetch an anonymous pull token from the realm advertised by the registry.
 * @param {object} challenge - Parsed Bearer challenge.
 * @param {string} repository - Repository path, for the pull scope.
 * @param {Function} fetchFn - fetch implementation.
 * @returns {Promise<{status: 'ok', token: string}|{status: 'error'|'unverified', reason: string}>} Result.
 */
async function fetchAnonymousToken(challenge, repository, fetchFn) {
  let tokenUrl;
  try {
    tokenUrl = new URL(challenge.realm);
  } catch {
    return { status: 'error', reason: 'registry sent an invalid auth realm' };
  }
  // The realm comes from the registry's own response but the registry domain
  // comes from a third-party manifest: keep the same SSRF bar as every other
  // outbound request of the indexer.
  if (tokenUrl.protocol !== 'https:' || isForbiddenHost(tokenUrl.hostname)) {
    return { status: 'error', reason: 'registry auth realm is not a public https URL' };
  }
  if (challenge.service !== null) {
    tokenUrl.searchParams.set('service', challenge.service);
  }
  tokenUrl.searchParams.set('scope', `repository:${repository}:pull`);
  const response = await fetchFn(tokenUrl.toString(), {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    return {
      status: 'error',
      reason: `image is not publicly pullable (registry auth denied, HTTP ${response.status})`,
    };
  }
  if (!response.ok) {
    return { status: 'unverified', reason: `registry token request failed (HTTP ${response.status})` };
  }
  const body = await response.json();
  const token = body.token ?? body.access_token;
  if (typeof token !== 'string') {
    return { status: 'unverified', reason: 'registry token response has no token' };
  }
  return { status: 'ok', token };
}

/**
 * Turn the final manifest HEAD response into a check result. A 403 is only a
 * definitive verdict once the anonymous token flow actually ran: before that,
 * it can come from an HTTP middlebox (corporate proxy, WAF...) rather than
 * from the registry itself, and evicting an integration on such an ambiguous
 * answer would be wrong.
 * @param {Response} response - Fetch response of the manifest HEAD.
 * @param {string} registry - Registry host, for error messages.
 * @param {boolean} authenticated - Whether the HEAD carried an anonymous pull token.
 * @returns {{status: 'ok'}|{status: 'error'|'unverified', reason: string}} Result.
 */
function manifestResponseResult(response, registry, authenticated) {
  if (response.ok) {
    return { status: 'ok' };
  }
  if (response.status === 404) {
    return { status: 'error', reason: `image not found on registry "${registry}" (HTTP 404)` };
  }
  if (authenticated && (response.status === 401 || response.status === 403)) {
    return { status: 'error', reason: `image is not publicly pullable (HTTP ${response.status})` };
  }
  return { status: 'unverified', reason: `registry check failed (HTTP ${response.status})` };
}

/**
 * Check that a Docker image reference actually exists on its registry and is
 * anonymously pullable — a catalog entry pointing to a missing image would
 * only ever produce a broken install.
 *
 * `error` is a definitive verdict (the registry answered: the image does not
 * exist or cannot be pulled anonymously) and rejects the integration;
 * `unverified` is a transient failure (registry unreachable, 5xx...) and must
 * NOT reject an integration that may already be published — the caller indexes
 * it with a warning instead.
 * @param {object} options - Options.
 * @param {string} options.reference - Image reference, e.g. "ghcr.io/john/demo:1.2.0".
 * @param {Function} [options.fetchFn] - fetch implementation, injectable for tests.
 * @returns {Promise<{status: 'ok'}|{status: 'error'|'unverified', reason: string}>} Result.
 */
export async function checkDockerImage({ reference, fetchFn = fetch }) {
  const parsed = parseDockerImageReference(reference);
  if (parsed === null || (parsed.tag === null && parsed.digest === null)) {
    return { status: 'error', reason: 'malformed image reference' };
  }
  const { registry, repository } = resolveRegistryRepository(parsed.name);
  // `new URL` splits a possible :port off the hostname for the SSRF check.
  if (isForbiddenHost(new URL(`https://${registry}`).hostname)) {
    return { status: 'error', reason: 'forbidden registry host (private or reserved address)' };
  }
  // A digest identifies the exact bytes; it wins over a tag, which can move.
  const manifestReference = parsed.digest ?? parsed.tag;
  const manifestUrl = `https://${registry}/v2/${repository}/manifests/${manifestReference}`;

  try {
    let response = await headManifest(manifestUrl, null, fetchFn);
    let authenticated = false;
    if (response.status === 401) {
      const challenge = parseBearerChallenge(response.headers.get('www-authenticate'));
      if (challenge === null) {
        return { status: 'error', reason: 'image is not publicly pullable (registry requires credentials)' };
      }
      const tokenResult = await fetchAnonymousToken(challenge, repository, fetchFn);
      if (tokenResult.status !== 'ok') {
        return tokenResult;
      }
      response = await headManifest(manifestUrl, tokenResult.token, fetchFn);
      authenticated = true;
    }
    return manifestResponseResult(response, registry, authenticated);
  } catch (e) {
    return { status: 'unverified', reason: `registry check failed (${e.message})` };
  }
}
