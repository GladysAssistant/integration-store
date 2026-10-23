import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fallbackPath = fileURLToPath(new URL('../data/country-fallback.json', import.meta.url));

/**
 * Load the country fallback mapping maintained in this repository
 * (integration-catalog-categories.md §4): the countries the community
 * integrations published before the manifest `countries` field existed are
 * usable in, keyed by store_slug — never by display name. Only the regional
 * integrations are listed (national weather services, transit networks,
 * utilities, open data…): an integration absent from the file is worldwide,
 * which is the right default for a hardware brand sold everywhere. The
 * manifest field always wins over this file, which is expected to shrink as
 * authors adopt it.
 * @returns {object} Map of store_slug → ISO 3166-1 alpha-2 codes.
 */
export function loadCountryFallback() {
  return JSON.parse(readFileSync(fallbackPath, 'utf8')).countries;
}

/**
 * Resolve the countries of an index entry: the manifest's declared
 * `countries` (already schema-validated), else the fallback mapping entry of
 * the store_slug, else [] — worldwide, the default that hides nothing. No
 * author-facing warning: worldwide is the common case, not a degradation.
 * @param {object} options - Options.
 * @param {object} options.manifest - Validated manifest.
 * @param {string} options.storeSlug - store_slug of the integration.
 * @param {object} options.countryFallback - Map of store_slug → countries.
 * @returns {string[]} ISO 3166-1 alpha-2 codes, empty for a worldwide integration.
 */
export function resolveCountries({ manifest, storeSlug, countryFallback }) {
  if (manifest.countries !== undefined) {
    return manifest.countries;
  }
  return countryFallback[storeSlug] ?? [];
}
