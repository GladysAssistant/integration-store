import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import semver from 'semver';

import { SUPPORTED_MANIFEST_VERSION } from './constants.js';
import { isValidDockerImageReference } from './parseDockerImageReference.js';

const schemaPath = fileURLToPath(new URL('../schemas/manifest.schema.json', import.meta.url));
export const manifestSchema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv({ allErrors: true });
const validateAgainstSchema = ajv.compile(manifestSchema);

/**
 * Format an AJV error as a spec-style reason, e.g. "manifest.name: must NOT have more than 30 characters".
 * @param {object} ajvError - Error object produced by AJV.
 * @returns {string} Human-readable reason.
 */
function formatAjvError(ajvError) {
  const path = ajvError.instancePath.replaceAll('/', '.');
  return `manifest${path}: ${ajvError.message}`;
}

/**
 * Validate a `default` value against the type of its config field.
 * @param {object} field - Config schema field.
 * @param {string} path - Dotted path of the field, for error messages.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateConfigFieldDefault(field, path) {
  if (field.default === undefined) {
    return [];
  }
  // A dynamic source has no options to validate a default against (the values
  // are per-user device external_ids, unknown at publication time).
  if (field.source !== undefined) {
    return [`${path}.default: not allowed with a dynamic source`];
  }
  switch (field.type) {
    case 'string':
      return typeof field.default === 'string' ? [] : [`${path}.default: must be a string`];
    case 'number':
      return typeof field.default === 'number' ? [] : [`${path}.default: must be a number`];
    case 'boolean':
      return typeof field.default === 'boolean' ? [] : [`${path}.default: must be a boolean`];
    case 'select':
      return field.options.some((option) => option.value === field.default)
        ? []
        : [`${path}.default: must be one of the select options`];
    case 'multi_select': {
      const validValues = field.options.map((option) => option.value);
      return Array.isArray(field.default) && field.default.every((value) => validValues.includes(value))
        ? []
        : [`${path}.default: must be an array of the multi_select option values`];
    }
    // secret: it would end up published in the store index ;
    // oauth2: the value is the Connect flow, tokens live off-schema ;
    // section: purely presentational, stores no value (also schema-rejected).
    default:
      return [`${path}.default: not allowed for ${field.type} fields`];
  }
}

/**
 * Rules on a flat list of config fields that JSON Schema cannot express:
 * key uniqueness, default/type consistency, min/max consistency. Used for the
 * manifest `config_schema` and for each action mini form (`fields`).
 * @param {object[]} configSchema - Flat list of config fields.
 * @param {string} basePath - Dotted path of the list, for error messages.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateConfigSchemaRules(configSchema, basePath) {
  const errors = [];
  const seenKeys = new Set();
  configSchema.forEach((field, i) => {
    const path = `${basePath}.${i}`;
    if (seenKeys.has(field.key)) {
      errors.push(`${path}.key: duplicate key "${field.key}"`);
    }
    seenKeys.add(field.key);
    errors.push(...validateConfigFieldDefault(field, path));
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      errors.push(`${path}.min: must be lower than or equal to max`);
    }
  });
  return errors;
}

/**
 * Rules on the `containers` list that JSON Schema cannot express: name
 * uniqueness, image reference validity, reserved env keys, volume path
 * traversal, hardware class uniqueness.
 * @param {object[]} containers - The manifest `containers` array.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateSubContainerRules(containers) {
  const errors = [];
  const seenNames = new Set();
  containers.forEach((container, i) => {
    const path = `manifest.containers.${i}`;
    if (seenNames.has(container.name)) {
      errors.push(`${path}.name: duplicate name "${container.name}"`);
    }
    seenNames.add(container.name);
    if (!isValidDockerImageReference(container.docker_image)) {
      errors.push(`${path}.docker_image: must be a valid image reference with an explicit tag or digest`);
    }
    if (container.env !== undefined) {
      // The manifest is public: GLADYS_* is reserved (no token, no identity).
      Object.keys(container.env).forEach((key) => {
        if (key.toUpperCase().startsWith('GLADYS_')) {
          errors.push(`${path}.env.${key}: GLADYS_* keys are reserved`);
        }
      });
    }
    if (container.volumes !== undefined) {
      // The host path is derived from the volume path by the supervisor: no
      // `..` segment that could escape the integration data folder.
      container.volumes.forEach((volume, volumeIndex) => {
        if (volume.split('/').includes('..')) {
          errors.push(`${path}.volumes.${volumeIndex}: must not contain ".." segments`);
        }
      });
    }
    if (container.devices !== undefined) {
      const seenClasses = new Set();
      container.devices.forEach((hardwareClass, classIndex) => {
        if (seenClasses.has(hardwareClass)) {
          errors.push(`${path}.devices.${classIndex}: duplicate class "${hardwareClass}"`);
        }
        seenClasses.add(hardwareClass);
      });
    }
  });
  return errors;
}

/**
 * Rules on the `actions` list that JSON Schema cannot express: key uniqueness
 * and the config-field rules of each mini form (keys unique within an action).
 * @param {object[]} actions - The manifest `actions` array.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateActionRules(actions) {
  const errors = [];
  const seenKeys = new Set();
  actions.forEach((action, i) => {
    const path = `manifest.actions.${i}`;
    if (seenKeys.has(action.key)) {
      errors.push(`${path}.key: duplicate key "${action.key}"`);
    }
    seenKeys.add(action.key);
    if (action.fields !== undefined) {
      errors.push(...validateConfigSchemaRules(action.fields, `${path}.fields`));
    }
  });
  return errors;
}

/**
 * Rules on the `webhooks` list that JSON Schema cannot express: key
 * uniqueness (the key is the last segment of the public relay URL).
 * @param {object[]} webhooks - The manifest `webhooks` array.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateWebhookRules(webhooks) {
  const errors = [];
  const seenKeys = new Set();
  webhooks.forEach((webhook, i) => {
    if (seenKeys.has(webhook.key)) {
      errors.push(`manifest.webhooks.${i}.key: duplicate key "${webhook.key}"`);
    }
    seenKeys.add(webhook.key);
  });
  return errors;
}

/**
 * Validate an integration manifest: JSON Schema first, then the rules the
 * schema cannot express (strict semver, semver range, image references,
 * config_schema/contact_schema/containers/actions/webhooks consistency).
 * Indexer and Gladys server apply the same rules.
 * @param {*} manifest - Parsed content of gladys-assistant-integration.json.
 * @returns {{valid: boolean, errors: string[]}} Validation result.
 */
export function validateManifest(manifest) {
  // Explicit message for future manifest versions: the generic schema error
  // ("must be equal to constant") would not tell the developer what to do.
  if (
    manifest !== null &&
    typeof manifest === 'object' &&
    Number.isInteger(manifest.manifest_version) &&
    manifest.manifest_version > SUPPORTED_MANIFEST_VERSION
  ) {
    return {
      valid: false,
      errors: [
        `manifest.manifest_version: version ${manifest.manifest_version} is not supported` +
          ` (max supported: ${SUPPORTED_MANIFEST_VERSION})`,
      ],
    };
  }

  if (!validateAgainstSchema(manifest)) {
    return { valid: false, errors: validateAgainstSchema.errors.map(formatAjvError) };
  }

  const errors = [];
  if (semver.valid(manifest.version) !== manifest.version) {
    errors.push('manifest.version: must be valid semver');
  }
  if (semver.validRange(manifest.gladys_version) === null) {
    errors.push('manifest.gladys_version: must be a valid semver range');
  }
  if (!isValidDockerImageReference(manifest.docker_image)) {
    errors.push('manifest.docker_image: must be a valid image reference with an explicit tag or digest');
  }
  if (manifest.config_schema !== undefined) {
    errors.push(...validateConfigSchemaRules(manifest.config_schema, 'manifest.config_schema'));
  }
  // The per-user identity fields of a send-only channel share the flat config
  // field format (contract B.15), so they share its code rules too.
  if (manifest.contact_schema !== undefined) {
    errors.push(...validateConfigSchemaRules(manifest.contact_schema, 'manifest.contact_schema'));
  }
  if (manifest.containers !== undefined) {
    errors.push(...validateSubContainerRules(manifest.containers));
  }
  if (manifest.actions !== undefined) {
    errors.push(...validateActionRules(manifest.actions));
  }
  if (manifest.webhooks !== undefined) {
    errors.push(...validateWebhookRules(manifest.webhooks));
  }

  return { valid: errors.length === 0, errors };
}
