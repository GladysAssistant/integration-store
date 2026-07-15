// Grammar from the OCI distribution reference specification
// (https://github.com/distribution/reference), restricted to what the store
// accepts: a well-formed name with an EXPLICIT tag or digest — an implicit
// `latest` would make "update available" detection meaningless.

const DOMAIN_COMPONENT = '(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])';
const DOMAIN = `${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*(?::[0-9]+)?`;
const PATH_COMPONENT = '[a-z0-9]+(?:(?:\\.|_|__|-+)[a-z0-9]+)*';
const NAME = `(?:${DOMAIN}/)?${PATH_COMPONENT}(?:/${PATH_COMPONENT})*`;
const TAG = '[\\w][\\w.-]{0,127}';
const DIGEST = '[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[a-fA-F0-9]{32,}';

const REFERENCE_REGEX = new RegExp(`^(${NAME})(?::(${TAG}))?(?:@(${DIGEST}))?$`);

const NAME_MAX_LENGTH = 255;

/**
 * Parse a Docker image reference.
 * @param {string} reference - Image reference, e.g. "ghcr.io/john/demo:1.2.0".
 * @returns {{name: string, tag: string|null, digest: string|null}|null} Parsed parts, or null if malformed.
 */
export function parseDockerImageReference(reference) {
  if (typeof reference !== 'string') {
    return null;
  }
  const match = REFERENCE_REGEX.exec(reference);
  if (!match) {
    return null;
  }
  const [, name, tag = null, digest = null] = match;
  if (name.length > NAME_MAX_LENGTH) {
    return null;
  }
  return { name, tag, digest };
}

/**
 * Tell whether a Docker image reference is valid for the store: well-formed,
 * with an explicit tag or digest.
 * @param {string} reference - Image reference to check.
 * @returns {boolean} True when the reference is acceptable.
 */
export function isValidDockerImageReference(reference) {
  const parsed = parseDockerImageReference(reference);
  return parsed !== null && (parsed.tag !== null || parsed.digest !== null);
}
