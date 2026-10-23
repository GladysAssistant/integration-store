import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { INTEGRATION_CATALOG_CATEGORIES } from './constants.js';

const fallbackPath = fileURLToPath(new URL('../data/category-fallback.json', import.meta.url));

/**
 * Load the category fallback mapping maintained in this repository
 * (integration-catalog-categories.md §6.3): the browse categories of the
 * community integrations published before the manifest `categories` field
 * existed, keyed by store_slug — never by display name, which is neither
 * unique nor stable. The manifest field always wins over this file, which is
 * expected to shrink as authors adopt it.
 * @returns {object} Map of store_slug → categories array.
 */
export function loadCategoryFallback() {
  return JSON.parse(readFileSync(fallbackPath, 'utf8')).categories;
}

/**
 * Load the category additions maintained in this repository: the shelves
 * added to the vocabulary after an integration was published (transport,
 * vehicles, servers, leisure — integration-catalog-categories.md §3), keyed
 * by store_slug. Unlike the fallback, an addition applies on top of the
 * categories the manifest declares — a manifest can only name the shelves
 * that existed when it was written, and the new shelves would stay empty
 * until every author republishes. It never removes a declared key, and
 * becomes redundant (then removable) once the author declares the key.
 * @returns {object} Map of store_slug → categories array.
 */
export function loadCategoryAdditions() {
  return JSON.parse(readFileSync(fallbackPath, 'utf8')).additions;
}

/**
 * Split a declared `categories` array between the keys of the controlled
 * vocabulary and the unknown ones. The vocabulary stage filters, never
 * rejects: an integration published with a newer vocabulary than a running
 * instance must still install — the store, which always knows the current
 * vocabulary, surfaces the drop as an author-facing warning instead.
 * @param {string[]} categories - Declared categories, already schema-validated.
 * @returns {{known: string[], unknown: string[]}} Vocabulary split.
 */
export function splitKnownCategories(categories) {
  return {
    known: categories.filter((category) => INTEGRATION_CATALOG_CATEGORIES.includes(category)),
    unknown: categories.filter((category) => !INTEGRATION_CATALOG_CATEGORIES.includes(category)),
  };
}

/**
 * Resolve the browse categories of an index entry
 * (integration-catalog-categories.md §6.3): the manifest's declared
 * categories filtered against the controlled vocabulary, else the fallback
 * mapping entry of the store_slug, else [] — uncategorized, visible under
 * "All" and search only, with an author-facing warning (better shelf
 * placement is the author's incentive to declare the field). The additions
 * of the store_slug (shelves added to the vocabulary after the manifest was
 * written) are then appended, never replacing a declared key.
 * @param {object} options - Options.
 * @param {object} options.manifest - Validated manifest.
 * @param {string} options.storeSlug - store_slug of the integration.
 * @param {object} options.categoryFallback - Map of store_slug → categories.
 * @param {object} [options.categoryAdditions] - Map of store_slug → categories appended to the resolved ones.
 * @returns {{categories: string[], warnings: string[]}} Resolved categories and author-facing warnings.
 */
export function resolveCategories({ manifest, storeSlug, categoryFallback, categoryAdditions = {} }) {
  const { categories, warnings } = resolveDeclaredCategories({ manifest, storeSlug, categoryFallback });
  const additions = (categoryAdditions[storeSlug] ?? []).filter((category) => !categories.includes(category));
  return { categories: [...categories, ...additions], warnings };
}

/**
 * The declared-or-fallback stage of resolveCategories, before the additions.
 * @param {object} options - Options.
 * @param {object} options.manifest - Validated manifest.
 * @param {string} options.storeSlug - store_slug of the integration.
 * @param {object} options.categoryFallback - Map of store_slug → categories.
 * @returns {{categories: string[], warnings: string[]}} Resolved categories and author-facing warnings.
 */
function resolveDeclaredCategories({ manifest, storeSlug, categoryFallback }) {
  const warnings = [];
  if (manifest.categories !== undefined) {
    const { known, unknown } = splitKnownCategories(manifest.categories);
    if (unknown.length > 0) {
      warnings.push(
        `categories: unknown key(s) ${unknown.map((key) => `"${key}"`).join(', ')} dropped` +
          ` — the published vocabulary is: ${INTEGRATION_CATALOG_CATEGORIES.join(', ')}`,
      );
    }
    if (known.length > 0) {
      return { categories: known, warnings };
    }
    // Every declared key is unknown: uncategorized, not an error — the same
    // fallback chain as an entry declaring nothing applies.
  }
  const fallback = categoryFallback[storeSlug];
  if (fallback !== undefined) {
    return { categories: fallback, warnings };
  }
  warnings.push(
    'categories: none declared and no fallback entry — the integration appears uncategorized' +
      ' in the catalog (reachable through "All" and search only); declare `categories` in the manifest',
  );
  return { categories: [], warnings };
}
