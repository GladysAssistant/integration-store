import { expect } from 'chai';

import { loadCategoryFallback, resolveCategories, splitKnownCategories } from '../src/categories.js';
import { INTEGRATION_CATALOG_CATEGORIES } from '../src/constants.js';

describe('loadCategoryFallback', () => {
  it('should load a mapping of store_slug to 1-3 unique keys of the controlled vocabulary', () => {
    const fallback = loadCategoryFallback();
    const slugs = Object.keys(fallback);
    expect(slugs.length).to.be.greaterThan(0);
    for (const slug of slugs) {
      // Keyed by store_slug ("owner/repo"), never by display name.
      expect(slug, slug).to.match(/^[^/\s]+\/[^/\s]+$/);
      const categories = fallback[slug];
      expect(categories, slug).to.be.an('array');
      expect(categories.length, slug).to.be.within(1, 3);
      expect(new Set(categories).size, slug).to.equal(categories.length);
      for (const category of categories) {
        expect(INTEGRATION_CATALOG_CATEGORIES, `${slug}: ${category}`).to.include(category);
      }
    }
  });
});

describe('splitKnownCategories', () => {
  it('should split declared keys between the controlled vocabulary and the unknown ones', () => {
    expect(splitKnownCategories(['climate', 'spaceships', 'energy'])).to.deep.equal({
      known: ['climate', 'energy'],
      unknown: ['spaceships'],
    });
  });
});

describe('resolveCategories', () => {
  const storeSlug = 'john/gladys-open-meteo-demo';

  it('should use the declared categories when every key is known', () => {
    expect(
      resolveCategories({ manifest: { categories: ['environment'] }, storeSlug, categoryFallback: {} }),
    ).to.deep.equal({ categories: ['environment'], warnings: [] });
  });

  it('should win over the fallback mapping when the manifest declares categories', () => {
    const { categories, warnings } = resolveCategories({
      manifest: { categories: ['environment'] },
      storeSlug,
      categoryFallback: { [storeSlug]: ['climate'] },
    });
    expect(categories).to.deep.equal(['environment']);
    expect(warnings).to.deep.equal([]);
  });

  it('should drop unknown keys with a warning and keep the known ones', () => {
    const { categories, warnings } = resolveCategories({
      manifest: { categories: ['environment', 'spaceships'] },
      storeSlug,
      categoryFallback: {},
    });
    expect(categories).to.deep.equal(['environment']);
    expect(warnings).to.have.lengthOf(1);
    expect(warnings[0]).to.include('unknown key(s) "spaceships" dropped');
    expect(warnings[0]).to.include(INTEGRATION_CATALOG_CATEGORIES.join(', '));
  });

  it('should fall back to the mapping when every declared key is unknown', () => {
    const { categories, warnings } = resolveCategories({
      manifest: { categories: ['spaceships'] },
      storeSlug,
      categoryFallback: { [storeSlug]: ['environment'] },
    });
    expect(categories).to.deep.equal(['environment']);
    expect(warnings).to.have.lengthOf(1);
    expect(warnings[0]).to.include('unknown key(s) "spaceships" dropped');
  });

  it('should fall back to the mapping when the manifest declares nothing, without any warning', () => {
    expect(
      resolveCategories({ manifest: {}, storeSlug, categoryFallback: { [storeSlug]: ['climate', 'energy'] } }),
    ).to.deep.equal({ categories: ['climate', 'energy'], warnings: [] });
  });

  it('should resolve to uncategorized with a warning when nothing is declared nor mapped', () => {
    const { categories, warnings } = resolveCategories({ manifest: {}, storeSlug, categoryFallback: {} });
    expect(categories).to.deep.equal([]);
    expect(warnings).to.have.lengthOf(1);
    expect(warnings[0]).to.include('uncategorized');
  });
});
