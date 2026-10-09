import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const blocklistPath = fileURLToPath(new URL('../data/blocklist.json', import.meta.url));

// An empty blocklist: the default of buildIndex, and what a fork of the store
// gets by emptying data/blocklist.json.
export const EMPTY_BLOCKLIST = Object.freeze({ repositories: Object.freeze({}), owners: Object.freeze({}) });

export const BLOCKLIST_SCOPES = {
  REPOSITORY: 'repository',
  OWNER: 'owner',
};

const ENTRY_FIELDS = ['reason', 'reference', 'blocked_at'];
// store_slug "owner/repo" — never a display name.
const STORE_SLUG_PATTERN = /^[^/\s]+\/[^/\s]+$/;
// GitHub login.
const OWNER_PATTERN = /^[^/\s]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const SECTIONS = [
  { name: 'repositories', keyLabel: 'store_slug (owner/repo)', keyPattern: STORE_SLUG_PATTERN },
  { name: 'owners', keyLabel: 'GitHub owner login', keyPattern: OWNER_PATTERN },
];

/**
 * Tell whether a value is a plain JSON object (not null, not an array).
 * @param {*} value - Candidate.
 * @returns {boolean} True for a plain object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Tell whether a string is a calendar date in YYYY-MM-DD form (2026-02-31 is
 * rejected: the round trip through Date must give the same day back).
 * @param {string} value - Candidate.
 * @returns {boolean} True for a valid calendar date.
 */
function isCalendarDate(value) {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Validate one blocklist entry: exactly the three public fields, each well
 * formed. Every problem is pushed with its path.
 * @param {string} path - Entry path for messages, e.g. "repositories.evil/repo".
 * @param {*} entry - Candidate entry.
 * @param {string[]} errors - Accumulator.
 * @returns {void}
 */
function validateEntry(path, entry, errors) {
  if (!isPlainObject(entry)) {
    errors.push(`${path}: must be an object with ${ENTRY_FIELDS.join(', ')}`);
    return;
  }
  for (const field of Object.keys(entry)) {
    if (!ENTRY_FIELDS.includes(field)) {
      errors.push(`${path}: unknown field "${field}" (allowed: ${ENTRY_FIELDS.join(', ')})`);
    }
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
    errors.push(`${path}.reason: must be a non-empty string (it is published verbatim in rejected.json)`);
  }
  if (typeof entry.reference !== 'string' || !entry.reference.startsWith('https://')) {
    errors.push(`${path}.reference: must be an https URL (the public issue documenting the case)`);
  }
  if (typeof entry.blocked_at !== 'string' || !isCalendarDate(entry.blocked_at)) {
    errors.push(`${path}.blocked_at: must be a calendar date in YYYY-MM-DD form`);
  }
}

/**
 * Validate the shape of a blocklist document: `repositories` keyed by
 * store_slug and `owners` keyed by GitHub login, each value an entry with a
 * public reason, an https reference and a block date. Keys are unique
 * case-insensitively (GitHub names are), and a repository entry under an
 * already-blocked owner is refused as redundant — the owner entry would
 * silently make it dead weight.
 * @param {*} blocklist - Parsed data/blocklist.json.
 * @returns {string[]} Problems, empty when the document is valid.
 */
export function validateBlocklist(blocklist) {
  if (!isPlainObject(blocklist)) {
    return ['blocklist: must be a JSON object with "repositories" and "owners"'];
  }
  const errors = [];
  for (const { name, keyLabel, keyPattern } of SECTIONS) {
    const section = blocklist[name];
    if (!isPlainObject(section)) {
      errors.push(`${name}: must be an object keyed by ${keyLabel}`);
      continue;
    }
    const seen = new Set();
    for (const [key, entry] of Object.entries(section)) {
      const path = `${name}.${key}`;
      if (!keyPattern.test(key)) {
        errors.push(`${path}: key must be a ${keyLabel}`);
      }
      const lowerKey = key.toLowerCase();
      if (seen.has(lowerKey)) {
        errors.push(`${path}: duplicate of another key differing only by case`);
      }
      seen.add(lowerKey);
      validateEntry(path, entry, errors);
    }
  }
  if (isPlainObject(blocklist.repositories) && isPlainObject(blocklist.owners)) {
    const blockedOwners = new Set(Object.keys(blocklist.owners).map((owner) => owner.toLowerCase()));
    for (const storeSlug of Object.keys(blocklist.repositories)) {
      const owner = storeSlug.split('/')[0].toLowerCase();
      if (blockedOwners.has(owner)) {
        errors.push(`repositories.${storeSlug}: redundant, owner "${storeSlug.split('/')[0]}" is already blocked`);
      }
    }
  }
  return errors;
}

/**
 * Load the blocklist maintained in this repository (data/blocklist.json). An
 * invalid file aborts the run: a typo must never silently publish an index
 * that re-admits a blocked integration.
 * @param {object} [options] - Options.
 * @param {string} [options.filePath] - Path of the blocklist file, injectable for tests.
 * @returns {{repositories: object, owners: object}} Validated blocklist.
 */
export function loadBlocklist({ filePath = blocklistPath } = {}) {
  const blocklist = JSON.parse(readFileSync(filePath, 'utf8'));
  const errors = validateBlocklist(blocklist);
  if (errors.length > 0) {
    throw new Error(`invalid blocklist (${filePath}):\n  ${errors.join('\n  ')}`);
  }
  return { repositories: blocklist.repositories, owners: blocklist.owners };
}

/**
 * Look up a key in a blocklist section, case-insensitively (GitHub logins and
 * repository names are).
 * @param {object} section - `repositories` or `owners` map.
 * @param {string} key - store_slug or owner login as returned by the GitHub search.
 * @returns {{key: string, entry: object}|null} Matching entry, with the key as written in the file.
 */
function lookup(section, key) {
  const lowerKey = key.toLowerCase();
  for (const [blockedKey, entry] of Object.entries(section)) {
    if (blockedKey.toLowerCase() === lowerKey) {
      return { key: blockedKey, entry };
    }
  }
  return null;
}

/**
 * Find the blocklist entry that excludes a repository, if any: its own
 * store_slug first (the more specific reason), else its owner.
 * @param {object} options - Options.
 * @param {string} options.storeSlug - store_slug of the repository ("owner/repo").
 * @param {string} options.owner - Owner login of the repository.
 * @param {{repositories: object, owners: object}} options.blocklist - Loaded blocklist.
 * @returns {{scope: string, key: string, entry: object}|null} Match, or null when the repository is not blocked.
 */
export function findBlocklistEntry({ storeSlug, owner, blocklist }) {
  const repositoryMatch = lookup(blocklist.repositories, storeSlug);
  if (repositoryMatch !== null) {
    return { scope: BLOCKLIST_SCOPES.REPOSITORY, ...repositoryMatch };
  }
  const ownerMatch = lookup(blocklist.owners, owner);
  if (ownerMatch !== null) {
    return { scope: BLOCKLIST_SCOPES.OWNER, ...ownerMatch };
  }
  return null;
}

/**
 * Author-facing rejection reason of a blocked repository, as published in
 * rejected.json: always prefixed by "blocklist:" so the removal is auditable,
 * carrying the public reason and the reference of the entry.
 * @param {{scope: string, key: string, entry: object}} match - Output of findBlocklistEntry.
 * @returns {string} Rejection reason.
 */
export function blocklistRejectionReason({ scope, key, entry }) {
  const subject = scope === BLOCKLIST_SCOPES.OWNER ? `owner "${key}" is blocked` : 'repository is blocked';
  return `blocklist: ${subject} — ${entry.reason} (see ${entry.reference})`;
}
