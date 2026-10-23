import { expect } from 'chai';

import { loadCountryFallback, resolveCountries } from '../src/countries.js';

describe('loadCountryFallback', () => {
  it('should load a mapping of store_slug to 1-20 unique ISO 3166-1 alpha-2 codes', () => {
    const fallback = loadCountryFallback();
    const slugs = Object.keys(fallback);
    expect(slugs.length).to.be.greaterThan(0);
    for (const slug of slugs) {
      // Keyed by store_slug ("owner/repo"), never by display name.
      expect(slug, slug).to.match(/^[^/\s]+\/[^/\s]+$/);
      const countries = fallback[slug];
      expect(countries, slug).to.be.an('array');
      expect(countries.length, slug).to.be.within(1, 20);
      expect(new Set(countries).size, slug).to.equal(countries.length);
      for (const country of countries) {
        expect(country, `${slug}: ${country}`).to.match(/^[A-Z]{2}$/);
      }
    }
  });
});

describe('resolveCountries', () => {
  const storeSlug = 'john/gladys-open-meteo-demo';

  it('should use the declared countries, which win over the fallback mapping', () => {
    expect(
      resolveCountries({ manifest: { countries: ['FR', 'BE'] }, storeSlug, countryFallback: { [storeSlug]: ['CA'] } }),
    ).to.deep.equal(['FR', 'BE']);
  });

  it('should fall back to the mapping when the manifest declares nothing', () => {
    expect(resolveCountries({ manifest: {}, storeSlug, countryFallback: { [storeSlug]: ['CA'] } })).to.deep.equal([
      'CA',
    ]);
  });

  it('should resolve to worldwide (empty) when nothing is declared nor mapped', () => {
    expect(resolveCountries({ manifest: {}, storeSlug, countryFallback: {} })).to.deep.equal([]);
  });
});
