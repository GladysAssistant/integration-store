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
      manifest.config_schema[0].icon = 'map-pin';
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
      manifest.config_schema[0].placeholder = '48.85';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a placeholder without english value', () => {
      const manifest = buildManifest();
      manifest.config_schema[0].placeholder = { fr: '48,85' };
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
      manifest.config_schema[2].placeholder = { en: 'Pick a unit' };
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
        'manifest.config_schema.3.default: must be an array of the multi_select option values',
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
        'manifest.config_schema.3.default: must be an array of the multi_select option values',
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
        'manifest.config_schema.3.default: not allowed for oauth2 fields',
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

    it('should accept a display on a select field', () => {
      const manifest = buildManifest();
      manifest.config_schema[2].display = 'radio';
      expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    });

    it('should reject an unknown display value', () => {
      const manifest = buildManifest();
      manifest.config_schema[2].display = 'checkbox';
      expect(validateManifest(manifest).valid).to.equal(false);
    });

    it('should reject a display on a non-select field', () => {
      const manifest = buildManifest();
      manifest.config_schema[0].display = 'radio';
      expect(validateManifest(manifest).valid).to.equal(false);
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
        'manifest.actions.0.fields.1.key: duplicate key "host"',
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
});
