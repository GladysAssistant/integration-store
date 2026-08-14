import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import semver from 'semver';

import { CATEGORIES_MIN_GLADYS_VERSION, SUPPORTED_MANIFEST_VERSION } from './constants.js';
import { isValidDockerImageReference } from './parseDockerImageReference.js';

const schemaPath = fileURLToPath(new URL('../schemas/manifest.schema.json', import.meta.url));
export const manifestSchema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv({ allErrors: true });
const validateAgainstSchema = ajv.compile(manifestSchema);

// {{port:<name>}} placeholder of the section texts, substituted by the Gladys
// frontend with the host port assigned to the named declared port (C.1).
// Strict syntax, no space inside the braces.
const PORT_PLACEHOLDER_REGEX = /\{\{port:([a-z0-9_]+)\}\}/g;

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
    // oauth2 / account_link: the value is the Connect flow, the credentials
    // live off-schema ;
    // section: purely presentational, stores no value (also schema-rejected).
    default:
      return [`${path}.default: not allowed for ${field.type} fields`];
  }
}

/**
 * Run a callback on every {{port:<name>}} placeholder of a multi-language text,
 * with the referenced port name and the language it sits in.
 * @param {object|undefined} text - Multi-language text, already schema-validated.
 * @param {Function} callback - Called with (name, language) per placeholder.
 */
function forEachPortPlaceholder(text, callback) {
  if (text === undefined) {
    return;
  }
  Object.entries(text).forEach(([language, value]) => {
    [...value.matchAll(PORT_PLACEHOLDER_REGEX)].forEach((match) => callback(match[1], language));
  });
}

/**
 * Rules on the {{port:<name>}} placeholders of a `section` text (C.1): every
 * referenced name must be the `name` of a port declared in the manifest — an
 * unknown reference would sit unresolved on screen forever. In the per-user
 * contact schema the placeholder is refused outright: that block is the one
 * screen a non-admin reaches, and their reduced view carries no container
 * state, so the token would resolve for an admin and stay raw for everyone
 * else. `{{gladys_host}}` stays allowed everywhere (the browser resolves it
 * whatever the role), hence no rule here.
 * @param {object} field - A `section` config field.
 * @param {string} path - Dotted path of the field, for error messages.
 * @param {{declaredPortNames: Set<string>, perUser: boolean}} context - Port names declared in the manifest, and whether the list is the per-user contact schema.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateSectionPortPlaceholders(field, path, context) {
  const errors = [];
  const check = (text, textPath) =>
    forEachPortPlaceholder(text, (name, language) => {
      if (context.perUser) {
        errors.push(`${textPath}.${language}: {{port:${name}}} is not available in the per-user contact schema`);
      } else if (!context.declaredPortNames.has(name)) {
        errors.push(`${textPath}.${language}: {{port:${name}}} does not reference any declared port name`);
      }
    });
  check(field.label, `${path}.label`);
  check(field.description, `${path}.description`);
  return errors;
}

/**
 * Rules on a flat list of config fields that JSON Schema cannot express:
 * key uniqueness, default/type consistency, min/max consistency, section
 * placeholder references. Used for the manifest `config_schema`, the
 * `contact_schema` and each action mini form (`fields`).
 * @param {object[]} configSchema - Flat list of config fields.
 * @param {string} basePath - Dotted path of the list, for error messages.
 * @param {{declaredPortNames: Set<string>, perUser: boolean}} context - Port names declared in the manifest, and whether the list is the per-user contact schema.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateConfigSchemaRules(configSchema, basePath, context) {
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
    // Only `section` fields carry texts the frontend substitutes.
    if (field.type === 'section') {
      errors.push(...validateSectionPortPlaceholders(field, path, context));
    }
  });
  return errors;
}

/**
 * Port names declared by the sub-containers, gathered before the rest of the
 * validation: the `section` texts reference them through the {{port:<name>}}
 * placeholder, which carries no container prefix.
 * @param {object[]|undefined} containers - The manifest `containers` array.
 * @returns {Set<string>} Declared port names.
 */
function collectDeclaredPortNames(containers = []) {
  const names = new Set();
  containers.forEach((container) => {
    (container.ports ?? []).forEach((port) => {
      if (port.name !== undefined) {
        names.add(port.name);
      }
    });
  });
  return names;
}

/**
 * Rules on the `containers` list that JSON Schema cannot express: name
 * uniqueness, image reference validity, reserved env keys, volume path
 * traversal, hardware class uniqueness, port name uniqueness.
 * @param {object[]} containers - The manifest `containers` array.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateSubContainerRules(containers) {
  const errors = [];
  const seenNames = new Set();
  // The {{port:<name>}} placeholder references a name without a container
  // prefix: a port name is unique across the whole manifest, not per container.
  const seenPortNames = new Set();
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
    if (container.ports !== undefined) {
      container.ports.forEach((port, portIndex) => {
        if (port.name === undefined) {
          return;
        }
        if (seenPortNames.has(port.name)) {
          errors.push(`${path}.ports.${portIndex}.name: duplicate port name "${port.name}"`);
        }
        seenPortNames.add(port.name);
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
 * @param {{declaredPortNames: Set<string>, perUser: boolean}} context - Port names declared in the manifest, and whether the list is the per-user contact schema.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateActionRules(actions, context) {
  const errors = [];
  const seenKeys = new Set();
  actions.forEach((action, i) => {
    const path = `manifest.actions.${i}`;
    if (seenKeys.has(action.key)) {
      errors.push(`${path}.key: duplicate key "${action.key}"`);
    }
    seenKeys.add(action.key);
    if (action.fields !== undefined) {
      errors.push(...validateConfigSchemaRules(action.fields, `${path}.fields`, context));
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
 * config_schema/contact_schema/containers/actions/webhooks consistency,
 * sub-container port name uniqueness and {{port:<name>}} placeholder
 * references).
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
  } else if (manifest.categories !== undefined) {
    // Older cores validate manifests with a strict field allowlist and reject
    // any unknown top-level field at install/update time: declaring
    // `categories` therefore requires a range no older core satisfies, which
    // turns a cryptic install failure on old instances into the standard
    // "requires Gladys ≥ X" catalog filter.
    const minimumVersion = semver.minVersion(manifest.gladys_version);
    if (minimumVersion === null || semver.lt(minimumVersion, CATEGORIES_MIN_GLADYS_VERSION)) {
      errors.push(
        `manifest.gladys_version: declaring categories requires ">=${CATEGORIES_MIN_GLADYS_VERSION}"` +
          ` at minimum (older Gladys releases reject manifests carrying unknown fields)`,
      );
    }
  }
  if (!isValidDockerImageReference(manifest.docker_image)) {
    errors.push('manifest.docker_image: must be a valid image reference with an explicit tag or digest');
  }
  // Gathered first: the section texts of the config_schema and of the action
  // mini forms may reference these names with a {{port:<name>}} placeholder.
  const declaredPortNames = collectDeclaredPortNames(manifest.containers);
  const adminContext = { declaredPortNames, perUser: false };
  if (manifest.config_schema !== undefined) {
    errors.push(...validateConfigSchemaRules(manifest.config_schema, 'manifest.config_schema', adminContext));
  }
  // The per-user identity fields of a send-only channel share the flat config
  // field format (contract B.15), so they share its code rules too.
  if (manifest.contact_schema !== undefined) {
    errors.push(
      ...validateConfigSchemaRules(manifest.contact_schema, 'manifest.contact_schema', {
        declaredPortNames,
        perUser: true,
      }),
    );
  }
  if (manifest.containers !== undefined) {
    errors.push(...validateSubContainerRules(manifest.containers));
  }
  if (manifest.actions !== undefined) {
    errors.push(...validateActionRules(manifest.actions, adminContext));
  }
  if (manifest.webhooks !== undefined) {
    errors.push(...validateWebhookRules(manifest.webhooks));
  }

  return { valid: errors.length === 0, errors };
}
