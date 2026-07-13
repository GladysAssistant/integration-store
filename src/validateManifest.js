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
    // A secret has no meaningful default: it would end up published in the store index.
    default:
      return [`${path}.default: not allowed for secret fields`];
  }
}

/**
 * Rules on config_schema that JSON Schema cannot express: key uniqueness,
 * default/type consistency, min/max consistency.
 * @param {object[]} configSchema - The manifest `config_schema` array.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateConfigSchemaRules(configSchema) {
  const errors = [];
  const seenKeys = new Set();
  configSchema.forEach((field, i) => {
    const path = `manifest.config_schema.${i}`;
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
 * Validate an integration manifest: JSON Schema first, then the rules the
 * schema cannot express (strict semver, semver range, image reference,
 * config_schema consistency). Indexer and Gladys server apply the same rules.
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
    errors.push(...validateConfigSchemaRules(manifest.config_schema));
  }

  return { valid: errors.length === 0, errors };
}
