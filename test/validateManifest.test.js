import { readFileSync } from 'node:fs';

import { expect } from 'chai';

import { manifestSchema, validateManifest } from '../src/validateManifest.js';

const validManifest = JSON.parse(readFileSync(new URL('./fixtures/valid-manifest.json', import.meta.url), 'utf8'));

/**
 * Deep-clone the reference valid manifest so each test can mutate it freely.
 * @returns {object} A fresh valid manifest.
 */
function buildManifest() {
  return structuredClone(validManifest);
}

const providerManifest = JSON.parse(
  readFileSync(new URL('./fixtures/provider-manifest.json', import.meta.url), 'utf8'),
);

/**
 * Deep-clone the reference provider manifest (widgets + scene declarations,
 * gladys_version >= 5.0.5) so each test can mutate it freely.
 * @returns {object} A fresh valid provider manifest.
 */
function buildProviderManifest() {
  return structuredClone(providerManifest);
}

describe('manifestSchema', () => {
  it('should expose the canonical schema with its public $id', () => {
    expect(manifestSchema.$id).to.equal('https://gladysassistant.github.io/integration-store/manifest.schema.json');
  });
});

describe('validateManifest', () => {
  it('should accept the reference manifest of the spec', () => {
    expect(validateManifest(buildManifest())).to.deep.equal({ valid: true, errors: [] });
  });

  it('should accept a minimal manifest without cover_image nor config_schema', () => {
    const manifest = buildManifest();
    delete manifest.cover_image;
    delete manifest.config_schema;
    expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
  });

  it('should reject a non-object manifest', () => {
    expect(validateManifest(null).valid).to.equal(false);
    expect(validateManifest([]).valid).to.equal(false);
    expect(validateManifest('manifest').valid).to.equal(false);
  });

  it('should reject a manifest_version above the supported version with an explicit message', () => {
    const manifest = buildManifest();
    manifest.manifest_version = 2;
    expect(validateManifest(manifest)).to.deep.equal({
      valid: false,
      errors: ['manifest.manifest_version: version 2 is not supported (max supported: 1)'],
    });
  });

  it('should reject a non-integer manifest_version through the schema', () => {
    const manifest = buildManifest();
    manifest.manifest_version = '1';
    const result = validateManifest(manifest);
    expect(result.valid).to.equal(false);
    expect(result.errors.join(' ')).to.include('manifest.manifest_version');
  });

  it('should reject a missing required field', () => {
    const manifest = buildManifest();
    delete manifest.docker_image;
    const result = validateManifest(manifest);
    expect(result.valid).to.equal(false);
    expect(result.errors.join(' ')).to.include('docker_image');
  });

  it('should accept a manifest declaring or omitting the location authorization', () => {
    const declared = buildManifest();
    declared.location = false;
    expect(validateManifest(declared)).to.deep.equal({ valid: true, errors: [] });

    const undeclared = buildManifest();
    delete undeclared.location;
    expect(validateManifest(undeclared)).to.deep.equal({ valid: true, errors: [] });
  });

  it('should reject a non-boolean location', () => {
    const manifest = buildManifest();
    manifest.location = 'yes';
    const result = validateManifest(manifest);
    expect(result.valid).to.equal(false);
    expect(result.errors.join(' ')).to.include('manifest.location');
  });

  it('should accept a manifest declaring or omitting the network_wake authorization', () => {
    const declared = buildManifest();
    declared.network_wake = false;
    expect(validateManifest(declared)).to.deep.equal({ valid: true, errors: [] });

    const undeclared = buildManifest();
    delete undeclared.network_wake;
    expect(validateManifest(undeclared)).to.deep.equal({ valid: true, errors: [] });
  });

  it('should reject a non-boolean network_wake', () => {
    const manifest = buildManifest();
    manifest.network_wake = 'yes';
    const result = validateManifest(manifest);
    expect(result.valid).to.equal(false);
    expect(result.errors.join(' ')).to.include('manifest.network_wake');
  });

  it('should reject an unknown top-level field', () => {
    const manifest = buildManifest();
    manifest.permissions = ['network'];
    const result = validateManifest(manifest);
    expect(result.valid).to.equal(false);
    expect(result.errors.join(' ')).to.include('must NOT have additional properties');
  });

  it('should accept a bidirectional communication integration', () => {
    const manifest = buildManifest();
    manifest.type = 'communication';
    manifest.messaging = { receive: true };
    expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
  });

  it('should accept a weather integration', () => {
    const manifest = buildManifest();
    manifest.type = 'weather';
    expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
  });

  it('should reject an unknown type', () => {
    const manifest = buildManifest();
    manifest.type = 'camera';
    const result = validateManifest(manifest);
    expect(result.valid).to.equal(false);
    expect(result.errors.join(' ')).to.include('manifest.type');
  });

  it('should enforce the 3-30 characters bounds on name', () => {
    const tooShort = buildManifest();
    tooShort.name = 'ab';
    expect(validateManifest(tooShort).valid).to.equal(false);

    const tooLong = buildManifest();
    tooLong.name = 'a'.repeat(31);
    expect(validateManifest(tooLong).valid).to.equal(false);

    const bounds = buildManifest();
    bounds.name = 'abc';
    expect(validateManifest(bounds).valid).to.equal(true);
    bounds.name = 'a'.repeat(30);
    expect(validateManifest(bounds).valid).to.equal(true);
  });

  it('should require an english description', () => {
    const manifest = buildManifest();
    delete manifest.description.en;
    const result = validateManifest(manifest);
    expect(result.valid).to.equal(false);
    expect(result.errors.join(' ')).to.include('manifest.description');
  });

  it('should enforce the 10-100 characters bounds on each description value', () => {
    const tooShort = buildManifest();
    tooShort.description.fr = 'court';
    expect(validateManifest(tooShort).valid).to.equal(false);

    const tooLong = buildManifest();
    tooLong.description.en = 'a'.repeat(101);
    expect(validateManifest(tooLong).valid).to.equal(false);
  });

  it('should reject an invalid language key in description', () => {
    const manifest = buildManifest();
    manifest.description.french = 'Une description suffisamment longue.';
    expect(validateManifest(manifest).valid).to.equal(false);
  });

  it('should reject a non-semver version', () => {
    const manifest = buildManifest();
    manifest.version = '1.2';
    expect(validateManifest(manifest)).to.deep.equal({
      valid: false,
      errors: ['manifest.version: must be valid semver'],
    });
  });

  it('should reject a v-prefixed version (strict semver)', () => {
    const manifest = buildManifest();
    manifest.version = 'v1.2.0';
    expect(validateManifest(manifest).errors).to.deep.equal(['manifest.version: must be valid semver']);
  });

  it('should reject an invalid gladys_version range', () => {
    const manifest = buildManifest();
    manifest.gladys_version = 'not-a-range';
    expect(validateManifest(manifest).errors).to.deep.equal(['manifest.gladys_version: must be a valid semver range']);
  });

  it('should reject a docker_image without explicit tag or digest', () => {
    const manifest = buildManifest();
    manifest.docker_image = 'ghcr.io/john/gladys-open-meteo-demo';
    expect(validateManifest(manifest).errors).to.deep.equal([
      'manifest.docker_image: must be a valid image reference with an explicit tag or digest',
    ]);
  });

  it('should reject a http cover_image URL', () => {
    const manifest = buildManifest();
    manifest.cover_image = 'http://example.com/cover.jpg';
    expect(validateManifest(manifest).valid).to.equal(false);
  });

  it('should collect several errors at once', () => {
    const manifest = buildManifest();
    manifest.version = 'nope';
    manifest.gladys_version = 'nope';
    expect(validateManifest(manifest).errors).to.have.lengthOf(2);
  });

  describe('config_schema', () => {
    it('should reject an invalid key pattern', () => {
      const manifest = buildManifest();
      manifest.config_schema[1].key = 'Latitude';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject an unknown field type', () => {
      const manifest = buildManifest();
      manifest.config_schema[1].type = 'textarea';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a label without english value', () => {
      const manifest = buildManifest();
      manifest.config_schema[1].label = { fr: 'Latitude' };
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject duplicate keys', () => {
      const manifest = buildManifest();
      manifest.config_schema[2].key = 'latitude';
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.config_schema.2.key: duplicate key "latitude"',
      ]);
    });

    it('should reject a select field without options', () => {
      const manifest = buildManifest();
      delete manifest.config_schema[3].options;
      delete manifest.config_schema[3].default;
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject options on a non-select field', () => {
      const manifest = buildManifest();
      manifest.config_schema[1].options = [{ value: 'a', label: { en: 'A' } }];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject min/max on a non-number field', () => {
      const manifest = buildManifest();
      manifest.config_schema[2].min = 0;
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject min greater than max', () => {
      const manifest = buildManifest();
      manifest.config_schema[1].min = 90;
      manifest.config_schema[1].max = -90;
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.config_schema.1.min: must be lower than or equal to max',
      ]);
    });

    it('should reject a default not matching a number field', () => {
      const manifest = buildManifest();
      manifest.config_schema[1].default = 'forty-eight';
      expect(validateManifest(manifest).errors).to.deep.equal(['manifest.config_schema.1.default: must be a number']);
    });

    it('should reject a default not matching a string field', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({ key: 'city', type: 'string', label: { en: 'City' }, default: 42 });
      expect(validateManifest(manifest).errors).to.deep.equal(['manifest.config_schema.5.default: must be a string']);
    });

    it('should reject a default not matching a boolean field', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({ key: 'enabled', type: 'boolean', label: { en: 'Enabled' }, default: 'yes' });
      expect(validateManifest(manifest).errors).to.deep.equal(['manifest.config_schema.5.default: must be a boolean']);
    });

    it('should accept a valid string, boolean and select default', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({ key: 'city', type: 'string', label: { en: 'City' }, default: 'Paris' });
      manifest.config_schema.push({ key: 'enabled', type: 'boolean', label: { en: 'Enabled' }, default: true });
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject a select default outside the options', () => {
      const manifest = buildManifest();
      manifest.config_schema[3].default = 'kelvin';
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.config_schema.3.default: must be one of the select options',
      ]);
    });

    it('should reject a default on a secret field', () => {
      const manifest = buildManifest();
      manifest.config_schema[2].default = 's3cr3t';
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.config_schema.2.default: not allowed for secret fields',
      ]);
    });

    it('should reject an unknown property on a field', () => {
      const manifest = buildManifest();
      manifest.config_schema[1].icon = 'map-pin';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should accept a placeholder on string, number and secret fields', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({
        key: 'city',
        type: 'string',
        label: { en: 'City' },
        placeholder: { en: 'Paris' },
      });
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject a placeholder that is not multi-language text', () => {
      const manifest = buildManifest();
      manifest.config_schema[1].placeholder = '48.85';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a placeholder without english value', () => {
      const manifest = buildManifest();
      manifest.config_schema[1].placeholder = { fr: '48,85' };
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a placeholder on a boolean field', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({
        key: 'enabled',
        type: 'boolean',
        label: { en: 'Enabled' },
        placeholder: { en: 'yes' },
      });
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a placeholder on a select field', () => {
      const manifest = buildManifest();
      manifest.config_schema[3].placeholder = { en: 'Pick a unit' };
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should accept a multi_select field with an array default within the options', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({
        key: 'rooms',
        type: 'multi_select',
        label: { en: 'Rooms' },
        default: ['kitchen'],
        options: [
          { value: 'kitchen', label: { en: 'Kitchen' } },
          { value: 'bedroom', label: { en: 'Bedroom' } },
        ],
      });
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject a multi_select field without options', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({ key: 'rooms', type: 'multi_select', label: { en: 'Rooms' } });
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a multi_select default that is not an array', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({
        key: 'rooms',
        type: 'multi_select',
        label: { en: 'Rooms' },
        default: 'kitchen',
        options: [{ value: 'kitchen', label: { en: 'Kitchen' } }],
      });
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.config_schema.5.default: must be an array of the multi_select option values',
      ]);
    });

    it('should reject a multi_select default outside the options', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({
        key: 'rooms',
        type: 'multi_select',
        label: { en: 'Rooms' },
        default: ['garage'],
        options: [{ value: 'kitchen', label: { en: 'Kitchen' } }],
      });
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.config_schema.5.default: must be an array of the multi_select option values',
      ]);
    });

    it('should accept an oauth2 field', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({ key: 'account', type: 'oauth2', label: { en: 'Account' } });
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject a default on an oauth2 field', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({ key: 'account', type: 'oauth2', label: { en: 'Account' }, default: 'me' });
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.config_schema.5.default: not allowed for oauth2 fields',
      ]);
    });

    it('should reject a placeholder on an oauth2 field', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({
        key: 'account',
        type: 'oauth2',
        label: { en: 'Account' },
        placeholder: { en: 'you@example.com' },
      });
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a default on an account_link field', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({ key: 'vendor', type: 'account_link', label: { en: 'Vendor' }, default: 'me' });
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.config_schema.5.default: not allowed for account_link fields',
      ]);
    });

    it('should reject a placeholder on an account_link field', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({
        key: 'vendor',
        type: 'account_link',
        label: { en: 'Vendor' },
        placeholder: { en: 'you@example.com' },
      });
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should accept a display on a select field', () => {
      const manifest = buildManifest();
      manifest.config_schema[3].display = 'radio';
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject an unknown display value', () => {
      const manifest = buildManifest();
      manifest.config_schema[3].display = 'checkbox';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a display on a non-select field', () => {
      const manifest = buildManifest();
      manifest.config_schema[1].display = 'radio';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should accept a select field with the "devices" dynamic source', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({ key: 'device', type: 'select', source: 'devices', label: { en: 'Device' } });
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should accept a multi_select field with the "devices" dynamic source', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({
        key: 'devices',
        type: 'multi_select',
        source: 'devices',
        label: { en: 'Devices' },
      });
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject an unknown source value', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({ key: 'scene', type: 'select', source: 'scenes', label: { en: 'Scene' } });
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a select field carrying both options and source', () => {
      const manifest = buildManifest();
      manifest.config_schema[3].source = 'devices';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a source on a non-select field', () => {
      const manifest = buildManifest();
      manifest.config_schema[1].source = 'devices';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a default on a dynamic-source select', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({
        key: 'device',
        type: 'select',
        source: 'devices',
        label: { en: 'Device' },
        default: 'ext:demo:switch',
      });
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.config_schema.5.default: not allowed with a dynamic source',
      ]);
    });

    it('should accept a section field with description and https links', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({
        key: 'outro',
        type: 'section',
        label: { en: 'Going further' },
        description: { en: 'Advanced options for power users.' },
        links: [{ url: 'https://example.com/guide', label: { en: 'Guide' } }],
      });
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject a section with a required, default or placeholder value', () => {
      const withRequired = buildManifest();
      withRequired.config_schema[0].required = true;
      expect(validateManifest(withRequired).valid).to.equal(false);

      const withDefault = buildManifest();
      withDefault.config_schema[0].default = 'welcome';
      expect(validateManifest(withDefault).valid).to.equal(false);

      const withPlaceholder = buildManifest();
      withPlaceholder.config_schema[0].placeholder = { en: 'welcome' };
      expect(validateManifest(withPlaceholder).valid).to.equal(false);
    });

    it('should reject a section description over 1000 characters per language', () => {
      const manifest = buildManifest();
      manifest.config_schema[0].description = { en: 'x'.repeat(1001) };
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a non-https section link', () => {
      const manifest = buildManifest();
      manifest.config_schema[0].links = [{ url: 'http://example.com', label: { en: 'Doc' } }];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a section link without label', () => {
      const manifest = buildManifest();
      manifest.config_schema[0].links = [{ url: 'https://example.com' }];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject more than 5 section links', () => {
      const manifest = buildManifest();
      manifest.config_schema[0].links = Array.from({ length: 6 }, (unused, i) => ({
        url: `https://example.com/${i}`,
        label: { en: `Link ${i}` },
      }));
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject links on a non-section field', () => {
      const manifest = buildManifest();
      manifest.config_schema[1].links = [{ url: 'https://example.com', label: { en: 'Doc' } }];
      expect(validateManifest(manifest).valid).to.equal(false);
    });
  });

  describe('categories', () => {
    it('should accept 1 to 3 unique non-empty strings, without any vocabulary enum in the schema', () => {
      const manifest = buildManifest();
      // An unknown key passes the schema on purpose: the vocabulary stage
      // filters in code (unknown keys dropped with a warning, never a
      // rejection), so a newer vocabulary than this indexer still validates.
      manifest.categories = ['climate', 'energy', 'brand-new-key'];
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject an empty categories array', () => {
      const manifest = buildManifest();
      manifest.categories = [];
      const result = validateManifest(manifest);
      expect(result.valid).to.equal(false);
      expect(result.errors.join(' ')).to.include('manifest.categories');
    });

    it('should reject more than 3 categories', () => {
      const manifest = buildManifest();
      manifest.categories = ['climate', 'lighting', 'energy', 'security'];
      const result = validateManifest(manifest);
      expect(result.valid).to.equal(false);
      expect(result.errors.join(' ')).to.include('manifest.categories');
    });

    it('should reject duplicate categories', () => {
      const manifest = buildManifest();
      manifest.categories = ['climate', 'climate'];
      const result = validateManifest(manifest);
      expect(result.valid).to.equal(false);
      expect(result.errors.join(' ')).to.include('manifest.categories');
    });

    it('should reject a non-string or empty category key', () => {
      const withNumber = buildManifest();
      withNumber.categories = ['climate', 3];
      expect(validateManifest(withNumber).valid).to.equal(false);

      const withEmpty = buildManifest();
      withEmpty.categories = [''];
      expect(validateManifest(withEmpty).valid).to.equal(false);
    });

    it('should reject categories on a gladys_version range older Gladys releases satisfy', () => {
      const manifest = buildManifest();
      manifest.gladys_version = '>=4.62.0';
      expect(validateManifest(manifest)).to.deep.equal({
        valid: false,
        errors: [
          'manifest.gladys_version: declaring categories requires ">=4.86.0" at minimum' +
            ' (older Gladys releases reject manifests carrying unknown fields)',
        ],
      });
    });

    it('should reject categories on a valid but unsatisfiable gladys_version range', () => {
      const manifest = buildManifest();
      // A valid range no version satisfies: semver.minVersion() returns null.
      manifest.gladys_version = '<0.0.0';
      const result = validateManifest(manifest);
      expect(result.valid).to.equal(false);
      expect(result.errors.join(' ')).to.include('declaring categories requires ">=4.86.0"');
    });

    it('should accept an old gladys_version range when no categories are declared', () => {
      const manifest = buildManifest();
      delete manifest.categories;
      manifest.gladys_version = '>=4.62.0';
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should not report the version gate when the gladys_version range is already invalid', () => {
      const manifest = buildManifest();
      manifest.gladys_version = 'not-a-range';
      expect(validateManifest(manifest)).to.deep.equal({
        valid: false,
        errors: ['manifest.gladys_version: must be a valid semver range'],
      });
    });
  });

  describe('transports', () => {
    it('should accept a single transport', () => {
      const manifest = buildManifest();
      manifest.transports = ['local'];
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject an empty transports list', () => {
      const manifest = buildManifest();
      manifest.transports = [];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject duplicate transports', () => {
      const manifest = buildManifest();
      manifest.transports = ['local', 'local'];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject an unknown transport', () => {
      const manifest = buildManifest();
      manifest.transports = ['bluetooth'];
      expect(validateManifest(manifest).valid).to.equal(false);
    });
  });

  describe('containers', () => {
    it('should reject more than 5 sub-containers', () => {
      const manifest = buildManifest();
      manifest.containers = Array.from({ length: 6 }, (unused, i) => ({
        name: `sub-${i}`,
        docker_image: `eclipse-mosquitto:2.0.${i}`,
      }));
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject an invalid sub-container name', () => {
      const manifest = buildManifest();
      manifest.containers[0].name = 'M';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject duplicate sub-container names', () => {
      const manifest = buildManifest();
      manifest.containers.push({ name: 'mqtt', docker_image: 'redis:7.2.4' });
      expect(validateManifest(manifest).errors).to.deep.equal(['manifest.containers.1.name: duplicate name "mqtt"']);
    });

    it('should reject a sub-container image without explicit tag or digest', () => {
      const manifest = buildManifest();
      manifest.containers[0].docker_image = 'eclipse-mosquitto';
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.containers.0.docker_image: must be a valid image reference with an explicit tag or digest',
      ]);
    });

    it('should reject an unknown start mode', () => {
      const manifest = buildManifest();
      manifest.containers[0].start = 'later';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a reserved GLADYS_* env key, case-insensitively', () => {
      const manifest = buildManifest();
      manifest.containers[0].env.gladys_token = 'stolen';
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.containers.0.env.gladys_token: GLADYS_* keys are reserved',
      ]);
    });

    it('should reject a non-string env value', () => {
      const manifest = buildManifest();
      manifest.containers[0].env.MOSQUITTO_PORT = 1883;
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a relative volume path', () => {
      const manifest = buildManifest();
      manifest.containers[0].volumes = ['mosquitto/config'];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a volume path containing a ".." segment', () => {
      const manifest = buildManifest();
      manifest.containers[0].volumes = ['/data/../../etc'];
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.containers.0.volumes.0: must not contain ".." segments',
      ]);
    });

    it('should reject more than 3 published ports', () => {
      const manifest = buildManifest();
      manifest.containers[0].ports = [1, 2, 3, 4].map((port) => ({
        container_port: port,
        label: { en: `Port ${port}` },
      }));
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a port without label', () => {
      const manifest = buildManifest();
      manifest.containers[0].ports = [{ container_port: 1883 }];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should accept a port without name nor browsable flag', () => {
      const manifest = buildManifest();
      delete manifest.containers[0].ports[0].name;
      delete manifest.containers[0].ports[0].browsable;
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject an invalid port name', () => {
      const manifest = buildManifest();
      manifest.containers[0].ports[0].name = 'MQTT-Broker';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a non-boolean browsable flag', () => {
      const manifest = buildManifest();
      manifest.containers[0].ports[0].browsable = 'yes';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a duplicate port name across the whole manifest', () => {
      const manifest = buildManifest();
      manifest.containers.push({
        name: 'redis',
        docker_image: 'redis:7.2.4',
        ports: [{ container_port: 6379, label: { en: 'Redis' }, name: 'mqtt_broker' }],
      });
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.containers.1.ports.0.name: duplicate port name "mqtt_broker"',
      ]);
    });

    it('should reject an unknown hardware class', () => {
      const manifest = buildManifest();
      manifest.containers[0].devices = ['usb'];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a duplicate hardware class', () => {
      const manifest = buildManifest();
      manifest.containers[0].devices = ['video', 'video'];
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.containers.0.devices.1: duplicate class "video"',
      ]);
    });

    it('should enforce the memory, cpu and shm bounds', () => {
      const memory = buildManifest();
      memory.containers[0].memory_mb = 16;
      expect(validateManifest(memory).valid).to.equal(false);

      const cpu = buildManifest();
      cpu.containers[0].cpu = 4;
      expect(validateManifest(cpu).valid).to.equal(false);

      const shm = buildManifest();
      shm.containers[0].shm_mb = 1024;
      expect(validateManifest(shm).valid).to.equal(false);
    });

    it('should reject an unknown sub-container field', () => {
      const manifest = buildManifest();
      manifest.containers[0].privileged = true;
      expect(validateManifest(manifest).valid).to.equal(false);
    });
  });

  describe('network_discovery', () => {
    it('should reject an empty capture list', () => {
      const manifest = buildManifest();
      manifest.network_discovery = [];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject an unknown capture type', () => {
      const manifest = buildManifest();
      manifest.network_discovery = [{ type: 'arp-scan' }];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject an udp-broadcast capture without ports', () => {
      const manifest = buildManifest();
      manifest.network_discovery = [{ type: 'udp-broadcast' }];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject duplicate udp-broadcast ports', () => {
      const manifest = buildManifest();
      manifest.network_discovery = [{ type: 'udp-broadcast', ports: [6666, 6666] }];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a mdns capture with an invalid service type', () => {
      const manifest = buildManifest();
      manifest.network_discovery = [{ type: 'mdns', service: 'hue' }];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a ssdp capture without st', () => {
      const manifest = buildManifest();
      manifest.network_discovery = [{ type: 'ssdp' }];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a field of another capture type', () => {
      const manifest = buildManifest();
      manifest.network_discovery = [{ type: 'mdns', service: '_hue._tcp', ports: [6666] }];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should accept an udp-active-broadcast capture with ports', () => {
      const manifest = buildManifest();
      manifest.network_discovery = [{ type: 'udp-active-broadcast', ports: [9999, 20002] }];
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject an udp-active-broadcast capture without ports', () => {
      const manifest = buildManifest();
      manifest.network_discovery = [{ type: 'udp-active-broadcast' }];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject an udp-active-broadcast capture with a field of another type', () => {
      const manifest = buildManifest();
      manifest.network_discovery = [{ type: 'udp-active-broadcast', ports: [9999], st: 'urn:x' }];
      expect(validateManifest(manifest).valid).to.equal(false);
    });
  });

  describe('messaging and contact_schema', () => {
    /**
     * Build a valid send-only communication manifest (Free Mobile-style).
     * @returns {object} A fresh valid send-only manifest.
     */
    function buildSendOnlyManifest() {
      const manifest = buildManifest();
      manifest.type = 'communication';
      manifest.messaging = { receive: false };
      manifest.contact_schema = [
        { key: 'username', type: 'string', label: { en: 'Free Mobile login' }, required: true },
        { key: 'access_token', type: 'secret', label: { en: 'SMS API key' }, required: true },
      ];
      return manifest;
    }

    it('should accept a send-only channel with a contact_schema', () => {
      expect(validateManifest(buildSendOnlyManifest())).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject a communication integration without messaging', () => {
      const manifest = buildManifest();
      manifest.type = 'communication';
      const result = validateManifest(manifest);
      expect(result.valid).to.equal(false);
      expect(result.errors.join(' ')).to.include('messaging');
    });

    it('should reject messaging on a device integration', () => {
      const manifest = buildManifest();
      manifest.messaging = { receive: true };
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject messaging on a weather integration', () => {
      const manifest = buildManifest();
      manifest.type = 'weather';
      manifest.messaging = { receive: true };
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a contact_schema on a device integration', () => {
      const manifest = buildManifest();
      manifest.contact_schema = [{ key: 'username', type: 'string', label: { en: 'Login' } }];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a messaging object without receive', () => {
      const manifest = buildSendOnlyManifest();
      manifest.messaging = {};
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject an unknown messaging property', () => {
      const manifest = buildSendOnlyManifest();
      manifest.messaging = { receive: false, send: true };
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a non-boolean receive', () => {
      const manifest = buildSendOnlyManifest();
      manifest.messaging.receive = 'no';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a send-only channel without contact_schema', () => {
      const manifest = buildSendOnlyManifest();
      delete manifest.contact_schema;
      const result = validateManifest(manifest);
      expect(result.valid).to.equal(false);
      expect(result.errors.join(' ')).to.include('contact_schema');
    });

    it('should reject a contact_schema on a bidirectional channel', () => {
      const manifest = buildSendOnlyManifest();
      manifest.messaging.receive = true;
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject an empty contact_schema', () => {
      const manifest = buildSendOnlyManifest();
      manifest.contact_schema = [];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should apply the config field rules to the contact_schema', () => {
      const manifest = buildSendOnlyManifest();
      manifest.contact_schema.push({ key: 'username', type: 'string', label: { en: 'Login again' } });
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.contact_schema.2.key: duplicate key "username"',
      ]);
    });

    it('should reject a default on a secret contact field', () => {
      const manifest = buildSendOnlyManifest();
      manifest.contact_schema[1].default = 's3cr3t';
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.contact_schema.1.default: not allowed for secret fields',
      ]);
    });

    it('should reject an oauth2 field in the contact_schema', () => {
      const manifest = buildSendOnlyManifest();
      manifest.contact_schema.push({ key: 'account', type: 'oauth2', label: { en: 'Account' } });
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject an account_link field in the contact_schema', () => {
      // Like oauth2: linking a provider account is integration-scoped, never per user.
      const manifest = buildSendOnlyManifest();
      manifest.contact_schema.push({ key: 'vendor', type: 'account_link', label: { en: 'Vendor' } });
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a {{port:<name>}} placeholder in a contact_schema section, declared or not', () => {
      const manifest = buildSendOnlyManifest();
      manifest.contact_schema.push({
        key: 'intro',
        type: 'section',
        label: { en: 'Your {{port:mqtt_broker}} account' },
        description: { en: 'Reachable on {{port:unknown}}' },
      });
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.contact_schema.2.label.en: {{port:mqtt_broker}} is not available in the per-user contact schema',
        'manifest.contact_schema.2.description.en: {{port:unknown}} is not available in the per-user contact schema',
      ]);
    });

    it('should accept a {{gladys_host}} placeholder in a contact_schema section', () => {
      const manifest = buildSendOnlyManifest();
      manifest.contact_schema.push({
        key: 'intro',
        type: 'section',
        label: { en: 'Your account' },
        description: { en: 'Register the callback https://{{gladys_host}}/webhook in your provider.' },
      });
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });
  });

  // The `label` and `description` of a `section` are substituted at render time
  // by the Gladys frontend: `{{gladys_host}}` needs no declaration, while
  // `{{port:<name>}}` must reference a port name declared by a sub-container.
  describe('section text placeholders', () => {
    /**
     * Append a section field to the config_schema of a manifest.
     * @param {object} manifest - The manifest to extend.
     * @param {object} texts - The `label` and `description` of the section.
     * @returns {object} The same manifest, for chaining.
     */
    function withSection(manifest, texts) {
      manifest.config_schema.push({ key: 'setup', type: 'section', ...texts });
      return manifest;
    }

    it('should accept a section referencing a declared port name', () => {
      const manifest = withSection(buildManifest(), {
        label: { en: 'Connect your devices' },
        description: {
          en: 'Point them to mqtt://{{gladys_host}}:{{port:mqtt_broker}}',
          fr: 'Pointez-les vers mqtt://{{gladys_host}}:{{port:mqtt_broker}}',
        },
      });
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should accept a section without description', () => {
      const manifest = withSection(buildManifest(), { label: { en: 'Connect your devices' } });
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject a port placeholder referencing no declared port name', () => {
      const manifest = withSection(buildManifest(), {
        label: { en: 'Connect your devices' },
        description: { en: 'Point them to ws://{{gladys_host}}:{{port:ocpp}}' },
      });
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.config_schema.5.description.en: {{port:ocpp}} does not reference any declared port name',
      ]);
    });

    it('should reject a port placeholder in a section label, in every language', () => {
      const manifest = withSection(buildManifest(), {
        label: { en: 'Port {{port:ocpp}}', fr: 'Port {{port:ocpp}}' },
      });
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.config_schema.5.label.en: {{port:ocpp}} does not reference any declared port name',
        'manifest.config_schema.5.label.fr: {{port:ocpp}} does not reference any declared port name',
      ]);
    });

    it('should reject a port placeholder when the manifest declares no sub-container at all', () => {
      const manifest = buildManifest();
      delete manifest.containers;
      withSection(manifest, {
        label: { en: 'Connect your devices' },
        description: { en: 'Point them to mqtt://{{port:mqtt_broker}}' },
      });
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.config_schema.5.description.en: {{port:mqtt_broker}} does not reference any declared port name',
      ]);
    });

    it('should reject a port placeholder in the section of an action mini form', () => {
      const manifest = buildManifest();
      manifest.actions[0].fields.push({
        key: 'setup',
        type: 'section',
        label: { en: 'Setup' },
        description: { en: 'Point them to ws://{{port:ocpp}}' },
      });
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.actions.0.fields.2.description.en: {{port:ocpp}} does not reference any declared port name',
      ]);
    });

    it('should not interpret a placeholder outside a section field', () => {
      const manifest = buildManifest();
      manifest.config_schema[1].description = { en: 'Latitude of {{port:ocpp}}, not substituted' };
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should not interpret a loosely written placeholder', () => {
      const manifest = withSection(buildManifest(), {
        label: { en: 'Connect your devices' },
        description: { en: 'Neither {{ port:ocpp }} nor {{port:OCPP}} is a placeholder.' },
      });
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });
  });

  describe('webhooks', () => {
    it('should reject an empty webhooks list', () => {
      const manifest = buildManifest();
      manifest.webhooks = [];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject more than 3 webhooks', () => {
      const manifest = buildManifest();
      manifest.webhooks = Array.from({ length: 4 }, (unused, i) => ({
        key: `hook_${i}`,
        label: { en: `Hook ${i}` },
      }));
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should accept a webhook without mode (fire_and_forget is the default)', () => {
      const manifest = buildManifest();
      manifest.webhooks = [{ key: 'events', label: { en: 'Events' } }];
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject an invalid webhook key pattern', () => {
      const manifest = buildManifest();
      manifest.webhooks[0].key = 'Events';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject duplicate webhook keys', () => {
      const manifest = buildManifest();
      manifest.webhooks[1].key = 'events';
      expect(validateManifest(manifest).errors).to.deep.equal(['manifest.webhooks.1.key: duplicate key "events"']);
    });

    it('should reject a webhook without label', () => {
      const manifest = buildManifest();
      delete manifest.webhooks[0].label;
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a webhook label without english value', () => {
      const manifest = buildManifest();
      manifest.webhooks[0].label = { fr: 'Événements' };
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject an unknown webhook mode', () => {
      const manifest = buildManifest();
      manifest.webhooks[0].mode = 'async';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject an unknown webhook property', () => {
      const manifest = buildManifest();
      manifest.webhooks[0].url = 'https://example.com/hook';
      expect(validateManifest(manifest).valid).to.equal(false);
    });
  });

  describe('actions', () => {
    it('should reject an empty actions list', () => {
      const manifest = buildManifest();
      manifest.actions = [];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject more than 10 actions', () => {
      const manifest = buildManifest();
      manifest.actions = Array.from({ length: 11 }, (unused, i) => ({
        key: `action_${i}`,
        label: { en: `Action ${i}` },
      }));
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject duplicate action keys', () => {
      const manifest = buildManifest();
      manifest.actions.push({ key: 'test_connection', label: { en: 'Test again' } });
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.actions.1.key: duplicate key "test_connection"',
      ]);
    });

    it('should reject a timeout outside the 5-120 seconds bounds', () => {
      const tooShort = buildManifest();
      tooShort.actions[0].timeout_seconds = 2;
      expect(validateManifest(tooShort).valid).to.equal(false);

      const tooLong = buildManifest();
      tooLong.actions[0].timeout_seconds = 300;
      expect(validateManifest(tooLong).valid).to.equal(false);
    });

    it('should apply the config field rules to the action mini form', () => {
      const manifest = buildManifest();
      manifest.actions[0].fields.push({ key: 'host', type: 'string', label: { en: 'Host again' } });
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.actions.0.fields.2.key: duplicate key "host"',
      ]);
    });

    it('should allow the same field key in two different actions', () => {
      const manifest = buildManifest();
      manifest.actions.push({
        key: 'identify',
        label: { en: 'Identify' },
        fields: [{ key: 'host', type: 'string', label: { en: 'Host' } }],
      });
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject an unknown action field', () => {
      const manifest = buildManifest();
      manifest.actions[0].icon = 'bolt';
      expect(validateManifest(manifest).valid).to.equal(false);
    });
  });

  describe('gladys_version compatibility gates', () => {
    it('should reject type "provider" on a gladys_version range older Gladys releases satisfy', () => {
      const manifest = buildProviderManifest();
      manifest.gladys_version = '>=5.0.4';
      expect(validateManifest(manifest).errors).to.include(
        'manifest.gladys_version: type "provider" requires ">=5.0.5" at minimum' +
          ' (older Gladys releases reject manifests carrying an unknown type)',
      );
    });

    it('should reject each capability field on a gladys_version range older Gladys releases satisfy', () => {
      const manifest = buildProviderManifest();
      manifest.type = 'device';
      manifest.gladys_version = '>=4.86.0';
      expect(validateManifest(manifest).errors).to.deep.equal(
        ['widgets', 'scene_triggers', 'scene_actions'].map(
          (field) =>
            `manifest.gladys_version: declaring ${field} requires ">=5.0.5" at minimum` +
            ' (older Gladys releases reject manifests carrying unknown fields)',
        ),
      );
    });

    it('should accept the capability fields on a range starting at the first release accepting them', () => {
      const manifest = buildProviderManifest();
      manifest.gladys_version = '^5.0.5';
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should accept a device manifest on an old range when it declares no gated field', () => {
      const manifest = buildManifest();
      delete manifest.categories;
      manifest.gladys_version = '>=4.62.0';
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });
  });

  describe('provider type', () => {
    it('should accept the reference provider manifest (widgets + scene declarations)', () => {
      expect(validateManifest(buildProviderManifest())).to.deep.equal({ valid: true, errors: [] });
    });

    it('should accept a provider declaring a single capability field', () => {
      ['widgets', 'scene_triggers', 'scene_actions'].forEach((field) => {
        const manifest = buildProviderManifest();
        ['widgets', 'scene_triggers', 'scene_actions']
          .filter((other) => other !== field)
          .forEach((other) => delete manifest[other]);
        expect(validateManifest(manifest), field).to.deep.equal({ valid: true, errors: [] });
      });
    });

    it('should reject a provider declaring no capability field, with the explicit rule', () => {
      const manifest = buildProviderManifest();
      delete manifest.widgets;
      delete manifest.scene_triggers;
      delete manifest.scene_actions;
      expect(validateManifest(manifest)).to.deep.equal({
        valid: false,
        errors: [
          'manifest.type: a provider integration must declare at least one capability field' +
            ' (widgets, scene_triggers, scene_actions)',
        ],
      });
    });

    it('should keep the other schema errors next to the provider rule', () => {
      const manifest = buildProviderManifest();
      delete manifest.widgets;
      delete manifest.scene_triggers;
      delete manifest.scene_actions;
      manifest.name = 'ab';
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.name: must NOT have fewer than 3 characters',
        'manifest.type: a provider integration must declare at least one capability field' +
          ' (widgets, scene_triggers, scene_actions)',
      ]);
    });

    it('should reject messaging and contact_schema on a provider integration', () => {
      const manifest = buildProviderManifest();
      manifest.messaging = { receive: false };
      manifest.contact_schema = [{ key: 'phone', type: 'string', label: { en: 'Phone' } }];
      expect(validateManifest(manifest).valid).to.equal(false);
    });
  });

  describe('widgets', () => {
    /**
     * Provider manifest whose first widget is replaced.
     * @param {object} widget - Widget declaration.
     * @returns {object} Manifest.
     */
    function withWidget(widget) {
      const manifest = buildProviderManifest();
      manifest.widgets = [widget];
      return manifest;
    }

    it('should accept widgets on device, communication and weather manifests too', () => {
      const device = buildManifest();
      device.gladys_version = '>=5.0.5';
      device.widgets = buildProviderManifest().widgets;
      expect(validateManifest(device)).to.deep.equal({ valid: true, errors: [] });

      const weather = { ...device, type: 'weather' };
      expect(validateManifest(weather)).to.deep.equal({ valid: true, errors: [] });

      const communication = { ...device, type: 'communication', messaging: { receive: true } };
      expect(validateManifest(communication)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should accept a minimal widget (key and label only)', () => {
      expect(validateManifest(withWidget({ key: 'battery', label: { en: 'Battery' } }))).to.deep.equal({
        valid: true,
        errors: [],
      });
    });

    it('should reject an empty widgets list', () => {
      const manifest = buildProviderManifest();
      manifest.widgets = [];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject more than 5 widgets', () => {
      const manifest = buildProviderManifest();
      manifest.widgets = Array.from({ length: 6 }, (unused, i) => ({
        key: `widget_${i}`,
        label: { en: `Widget ${i}` },
      }));
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject an invalid widget key', () => {
      ['A', 'a', 'x'.repeat(33), 'with-dash'].forEach((key) => {
        expect(validateManifest(withWidget({ key, label: { en: 'Widget' } })).valid, key).to.equal(false);
      });
    });

    it('should reject duplicate widget keys', () => {
      const manifest = buildProviderManifest();
      manifest.widgets[1].key = 'upcoming_releases';
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.widgets.1.key: duplicate key "upcoming_releases"',
      ]);
    });

    it('should enforce the 3-30 characters bounds on each label value', () => {
      expect(validateManifest(withWidget({ key: 'w1', label: { en: 'Up' } })).errors).to.deep.equal([
        'manifest.widgets.0.label.en: must NOT have fewer than 3 characters',
      ]);
      expect(validateManifest(withWidget({ key: 'w1', label: { en: 'Widget', fr: 'x'.repeat(31) } })).valid).to.equal(
        false,
      );
    });

    it('should require an english label', () => {
      expect(validateManifest(withWidget({ key: 'w1', label: { fr: 'Batterie' } })).valid).to.equal(false);
    });

    it('should enforce the 100 characters bound on each description value', () => {
      const manifest = withWidget({ key: 'w1', label: { en: 'Widget' }, description: { en: 'x'.repeat(101) } });
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should validate the icon shape but never the icon name', () => {
      expect(validateManifest(withWidget({ key: 'w1', label: { en: 'Widget' }, icon: 'Film Reel' })).valid).to.equal(
        false,
      );
      expect(
        validateManifest(withWidget({ key: 'w1', label: { en: 'Widget' }, icon: 'not-a-feather-icon' })),
      ).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject an unknown widget field', () => {
      expect(validateManifest(withWidget({ key: 'w1', label: { en: 'Widget' }, color: 'red' })).valid).to.equal(false);
    });

    it('should reject more than 10 settings', () => {
      const settings = Array.from({ length: 11 }, (unused, i) => ({
        key: `setting_${i}`,
        type: 'string',
        label: { en: 'Setting' },
      }));
      expect(validateManifest(withWidget({ key: 'w1', label: { en: 'Widget' }, settings })).valid).to.equal(false);
    });

    it('should reject sensitive setting types (secret, oauth2, account_link)', () => {
      ['secret', 'oauth2', 'account_link'].forEach((type) => {
        const manifest = withWidget({
          key: 'w1',
          label: { en: 'Widget' },
          settings: [{ key: 'token', type, label: { en: 'Token' } }],
        });
        expect(validateManifest(manifest).errors, type).to.deep.equal([
          'manifest.widgets.0.settings.0.type: must be equal to one of the allowed values',
        ]);
      });
    });

    it('should apply the config field rules to the settings', () => {
      const manifest = withWidget({
        key: 'w1',
        label: { en: 'Widget' },
        settings: [
          { key: 'a', type: 'string', label: { en: 'A' } },
          { key: 'a', type: 'number', label: { en: 'A again' }, default: 'nope' },
        ],
      });
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.widgets.0.settings.1.key: duplicate key "a"',
        'manifest.widgets.0.settings.1.default: must be a number',
      ]);
    });

    it('should reject a {{port:<name>}} placeholder in a settings section, declared or not, but allow {{gladys_host}}', () => {
      const manifest = withWidget({
        key: 'w1',
        label: { en: 'Widget' },
        settings: [
          {
            key: 'intro',
            type: 'section',
            label: { en: 'Reach the UI on {{port:frigate_ui}}' },
            description: { en: 'http://{{gladys_host}}:{{port:frigate_ui}}', fr: 'Sur {{port:other}}' },
          },
        ],
      });
      manifest.containers = [
        {
          name: 'frigate',
          docker_image: 'ghcr.io/blakeblackshear/frigate:0.14.1',
          ports: [{ container_port: 5000, name: 'frigate_ui', label: { en: 'UI' } }],
        },
      ];
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.widgets.0.settings.0.label.en: {{port:frigate_ui}} is not available in widget settings',
        'manifest.widgets.0.settings.0.description.en: {{port:frigate_ui}} is not available in widget settings',
        'manifest.widgets.0.settings.0.description.fr: {{port:other}} is not available in widget settings',
      ]);

      const hostOnly = withWidget({
        key: 'w1',
        label: { en: 'Widget' },
        settings: [{ key: 'intro', type: 'section', label: { en: 'Open http://{{gladys_host}}' } }],
      });
      expect(validateManifest(hostOnly)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject an action_timeout_seconds outside the 5-120 seconds bounds', () => {
      [4, 121, '30'].forEach((timeout) => {
        const manifest = withWidget({ key: 'w1', label: { en: 'Widget' }, action_timeout_seconds: timeout });
        expect(validateManifest(manifest).valid, String(timeout)).to.equal(false);
      });
    });
  });

  describe('scene_triggers and scene_actions', () => {
    ['scene_triggers', 'scene_actions'].forEach((listName) => {
      /**
       * Provider manifest whose list is replaced.
       * @param {object[]} declarations - Scene declarations.
       * @returns {object} Manifest.
       */
      function withDeclarations(declarations) {
        const manifest = buildProviderManifest();
        manifest[listName] = declarations;
        return manifest;
      }

      describe(listName, () => {
        it('should accept a minimal declaration (key and label only)', () => {
          expect(validateManifest(withDeclarations([{ key: 'a', label: { en: 'A' } }]))).to.deep.equal({
            valid: true,
            errors: [],
          });
        });

        it('should reject an empty list', () => {
          expect(validateManifest(withDeclarations([])).valid).to.equal(false);
        });

        it('should reject more than 20 entries', () => {
          const declarations = Array.from({ length: 21 }, (unused, i) => ({ key: `k${i}`, label: { en: 'A' } }));
          expect(validateManifest(withDeclarations(declarations)).valid).to.equal(false);
        });

        it('should reject an invalid or too long key', () => {
          expect(validateManifest(withDeclarations([{ key: 'Bad Key', label: { en: 'A' } }])).valid).to.equal(false);
          expect(validateManifest(withDeclarations([{ key: 'a'.repeat(41), label: { en: 'A' } }])).valid).to.equal(
            false,
          );
          expect(validateManifest(withDeclarations([{ key: 'a'.repeat(40), label: { en: 'A' } }]))).to.deep.equal({
            valid: true,
            errors: [],
          });
        });

        it('should reject duplicate keys within the list', () => {
          const manifest = withDeclarations([
            { key: 'a', label: { en: 'A' } },
            { key: 'a', label: { en: 'A again' } },
          ]);
          expect(validateManifest(manifest).errors).to.deep.equal([`manifest.${listName}.1.key: duplicate key "a"`]);
        });

        it('should reject a label without english value and a non-object description', () => {
          expect(validateManifest(withDeclarations([{ key: 'a', label: { fr: 'A' } }])).valid).to.equal(false);
          expect(
            validateManifest(withDeclarations([{ key: 'a', label: { en: 'A' }, description: 'plain' }])).valid,
          ).to.equal(false);
        });

        it('should reject an unknown field', () => {
          expect(validateManifest(withDeclarations([{ key: 'a', label: { en: 'A' }, icon: 'x' }])).valid).to.equal(
            false,
          );
        });

        it('should reject more than 10 fields', () => {
          const fields = Array.from({ length: 11 }, (unused, i) => ({
            key: `f${i}`,
            type: 'string',
            label: { en: 'F' },
          }));
          expect(validateManifest(withDeclarations([{ key: 'a', label: { en: 'A' }, fields }])).valid).to.equal(false);
        });

        it('should reject secret, oauth2 and account_link fields', () => {
          ['secret', 'oauth2', 'account_link'].forEach((type) => {
            const manifest = withDeclarations([
              { key: 'a', label: { en: 'A' }, fields: [{ key: 'x', type, label: { en: 'X' } }] },
            ]);
            expect(validateManifest(manifest).errors, type).to.deep.equal([
              `manifest.${listName}.0.fields.0.type: must be equal to one of the allowed values`,
            ]);
          });
        });

        it('should apply the config field rules to the fields', () => {
          const manifest = withDeclarations([
            {
              key: 'a',
              label: { en: 'A' },
              fields: [
                { key: 'x', type: 'string', label: { en: 'X' } },
                { key: 'x', type: 'number', label: { en: 'X again' }, min: 5, max: 1 },
              ],
            },
          ]);
          expect(validateManifest(manifest).errors).to.deep.equal([
            `manifest.${listName}.0.fields.1.key: duplicate key "x"`,
            `manifest.${listName}.0.fields.1.min: must be lower than or equal to max`,
          ]);
        });

        it('should reject a {{port:<name>}} placeholder in a fields section, declared or not, but allow {{gladys_host}}', () => {
          const manifest = withDeclarations([
            {
              key: 'a',
              label: { en: 'A' },
              fields: [{ key: 'intro', type: 'section', label: { en: 'See {{port:web}} on {{gladys_host}}' } }],
            },
          ]);
          manifest.containers = [
            {
              name: 'ui',
              docker_image: 'nginx:1.27',
              ports: [{ container_port: 80, name: 'web', label: { en: 'Web' } }],
            },
          ];
          expect(validateManifest(manifest).errors).to.deep.equal([
            `manifest.${listName}.0.fields.0.label.en: {{port:web}} is not available in the scene editor`,
          ]);

          const hostOnly = withDeclarations([
            {
              key: 'a',
              label: { en: 'A' },
              fields: [{ key: 'intro', type: 'section', label: { en: 'Host: {{gladys_host}}' } }],
            },
          ]);
          expect(validateManifest(hostOnly)).to.deep.equal({ valid: true, errors: [] });
        });

        it('should allow the same field key in two different declarations', () => {
          const manifest = withDeclarations([
            { key: 'a', label: { en: 'A' }, fields: [{ key: 'x', type: 'string', label: { en: 'X' } }] },
            { key: 'b', label: { en: 'B' }, fields: [{ key: 'x', type: 'string', label: { en: 'X' } }] },
          ]);
          expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
        });
      });
    });

    it('should allow the same key in the triggers and in the actions (two namespaces)', () => {
      const manifest = buildProviderManifest();
      expect(manifest.scene_triggers.map((entry) => entry.key)).to.include('echo');
      expect(manifest.scene_actions.map((entry) => entry.key)).to.include('echo');
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject a boolean trigger filter but accept a boolean action parameter', () => {
      const field = { key: 'flag', type: 'boolean', label: { en: 'Flag' } };
      const trigger = buildProviderManifest();
      trigger.scene_triggers = [{ key: 'a', label: { en: 'A' }, fields: [field] }];
      expect(validateManifest(trigger).errors).to.deep.equal([
        'manifest.scene_triggers.0.fields.0.type: must be equal to one of the allowed values',
      ]);
      const action = buildProviderManifest();
      action.scene_actions = [{ key: 'a', label: { en: 'A' }, fields: [field] }];
      expect(validateManifest(action)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject timeout_seconds and outputs on a trigger, variables on an action', () => {
      const trigger = buildProviderManifest();
      trigger.scene_triggers = [{ key: 'a', label: { en: 'A' }, timeout_seconds: 10 }];
      expect(validateManifest(trigger).valid).to.equal(false);
      trigger.scene_triggers = [{ key: 'a', label: { en: 'A' }, outputs: [] }];
      expect(validateManifest(trigger).valid).to.equal(false);
      const action = buildProviderManifest();
      action.scene_actions = [{ key: 'a', label: { en: 'A' }, variables: [] }];
      expect(validateManifest(action).valid).to.equal(false);
    });

    it('should reject an action timeout outside the 5-120 seconds bounds', () => {
      [4, 121, '30'].forEach((timeout) => {
        const manifest = buildProviderManifest();
        manifest.scene_actions = [{ key: 'a', label: { en: 'A' }, timeout_seconds: timeout }];
        expect(validateManifest(manifest).valid, String(timeout)).to.equal(false);
      });
    });

    [
      ['scene_triggers', 'variables'],
      ['scene_actions', 'outputs'],
    ].forEach(([listName, variablesName]) => {
      describe(`${listName}[].${variablesName}`, () => {
        /**
         * Provider manifest whose first declaration carries the given whitelist.
         * @param {object[]} variables - Variables or outputs.
         * @returns {object} Manifest.
         */
        function withVariables(variables) {
          const manifest = buildProviderManifest();
          manifest[listName] = [{ key: 'a', label: { en: 'A' }, [variablesName]: variables }];
          return manifest;
        }

        it('should accept the three scalar types', () => {
          const manifest = withVariables([
            { key: 's', type: 'string', label: { en: 'S' } },
            { key: 'n', type: 'number', label: { en: 'N' }, description: { en: 'A number' } },
            { key: 'b', type: 'boolean', label: { en: 'B' } },
          ]);
          expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
        });

        it('should reject more than 20 entries', () => {
          const variables = Array.from({ length: 21 }, (unused, i) => ({
            key: `v${i}`,
            type: 'string',
            label: { en: 'V' },
          }));
          expect(validateManifest(withVariables(variables)).valid).to.equal(false);
        });

        it('should reject a non-scalar type, a missing label and an invalid key', () => {
          expect(validateManifest(withVariables([{ key: 'v', type: 'image', label: { en: 'V' } }])).valid).to.equal(
            false,
          );
          expect(validateManifest(withVariables([{ key: 'v', type: 'string' }])).valid).to.equal(false);
          expect(validateManifest(withVariables([{ key: 'Bad', type: 'string', label: { en: 'V' } }])).valid).to.equal(
            false,
          );
        });

        it('should reject an unknown field', () => {
          const manifest = withVariables([{ key: 'v', type: 'string', label: { en: 'V' }, default: 'x' }]);
          expect(validateManifest(manifest).valid).to.equal(false);
        });

        it('should reject duplicate keys within the list', () => {
          const manifest = withVariables([
            { key: 'v', type: 'string', label: { en: 'V' } },
            { key: 'v', type: 'number', label: { en: 'V again' } },
          ]);
          expect(validateManifest(manifest).errors).to.deep.equal([
            `manifest.${listName}.0.${variablesName}.1.key: duplicate key "v"`,
          ]);
        });
      });
    });
  });
});
