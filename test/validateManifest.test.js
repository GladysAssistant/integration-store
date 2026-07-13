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

  it('should reject an unknown top-level field', () => {
    const manifest = buildManifest();
    manifest.permissions = ['network'];
    const result = validateManifest(manifest);
    expect(result.valid).to.equal(false);
    expect(result.errors.join(' ')).to.include('must NOT have additional properties');
  });

  it('should reject a type other than "device"', () => {
    const manifest = buildManifest();
    manifest.type = 'weather';
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
      manifest.config_schema[0].key = 'Latitude';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject an unknown field type', () => {
      const manifest = buildManifest();
      manifest.config_schema[0].type = 'textarea';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a label without english value', () => {
      const manifest = buildManifest();
      manifest.config_schema[0].label = { fr: 'Latitude' };
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject duplicate keys', () => {
      const manifest = buildManifest();
      manifest.config_schema[1].key = 'latitude';
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.config_schema.1.key: duplicate key "latitude"',
      ]);
    });

    it('should reject a select field without options', () => {
      const manifest = buildManifest();
      delete manifest.config_schema[2].options;
      delete manifest.config_schema[2].default;
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject options on a non-select field', () => {
      const manifest = buildManifest();
      manifest.config_schema[0].options = [{ value: 'a', label: { en: 'A' } }];
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject min/max on a non-number field', () => {
      const manifest = buildManifest();
      manifest.config_schema[1].min = 0;
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject min greater than max', () => {
      const manifest = buildManifest();
      manifest.config_schema[0].min = 90;
      manifest.config_schema[0].max = -90;
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.config_schema.0.min: must be lower than or equal to max',
      ]);
    });

    it('should reject a default not matching a number field', () => {
      const manifest = buildManifest();
      manifest.config_schema[0].default = 'forty-eight';
      expect(validateManifest(manifest).errors).to.deep.equal(['manifest.config_schema.0.default: must be a number']);
    });

    it('should reject a default not matching a string field', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({ key: 'city', type: 'string', label: { en: 'City' }, default: 42 });
      expect(validateManifest(manifest).errors).to.deep.equal(['manifest.config_schema.3.default: must be a string']);
    });

    it('should reject a default not matching a boolean field', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({ key: 'enabled', type: 'boolean', label: { en: 'Enabled' }, default: 'yes' });
      expect(validateManifest(manifest).errors).to.deep.equal(['manifest.config_schema.3.default: must be a boolean']);
    });

    it('should accept a valid string, boolean and select default', () => {
      const manifest = buildManifest();
      manifest.config_schema.push({ key: 'city', type: 'string', label: { en: 'City' }, default: 'Paris' });
      manifest.config_schema.push({ key: 'enabled', type: 'boolean', label: { en: 'Enabled' }, default: true });
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject a select default outside the options', () => {
      const manifest = buildManifest();
      manifest.config_schema[2].default = 'kelvin';
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.config_schema.2.default: must be one of the select options',
      ]);
    });

    it('should reject a default on a secret field', () => {
      const manifest = buildManifest();
      manifest.config_schema[1].default = 's3cr3t';
      expect(validateManifest(manifest).errors).to.deep.equal([
        'manifest.config_schema.1.default: not allowed for secret fields',
      ]);
    });

    it('should reject an unknown property on a field', () => {
      const manifest = buildManifest();
      manifest.config_schema[0].placeholder = '48.85';
      expect(validateManifest(manifest).valid).to.equal(false);
    });
  });
});
