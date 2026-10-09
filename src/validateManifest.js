import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import semver from 'semver';

import {
  CAPABILITY_MANIFEST_FIELDS,
  CONFIG_FIELD_PROPERTY_MIN_GLADYS_VERSION,
  CORE_SERVICE_VARIABLES,
  MANIFEST_FIELD_MIN_GLADYS_VERSION,
  MANIFEST_TYPE_MIN_GLADYS_VERSION,
  SUPPORTED_MANIFEST_VERSION,
} from './constants.js';
import { isValidDockerImageReference } from './parseDockerImageReference.js';

const schemaPath = fileURLToPath(new URL('../schemas/manifest.schema.json', import.meta.url));
export const manifestSchema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv({ allErrors: true });
const validateAgainstSchema = ajv.compile(manifestSchema);

// {{port:<name>}} placeholder of the section texts, substituted by the Gladys
// frontend with the host port assigned to the named declared port (C.1).
// Strict syntax, no space inside the braces.
const PORT_PLACEHOLDER_REGEX = /\{\{port:([a-z0-9_]+)\}\}/g;

// Scene declarations share one shape (key, label, description, fields) and
// differ by the name of their whitelist list: `variables` an event exposes to
// the scene, `outputs` an action returns to it.
const SCENE_DECLARATION_LISTS = {
  scene_triggers: 'variables',
  scene_actions: 'outputs',
};

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
 * Format the AJV errors of a rejected manifest. The generic "must match a
 * schema in anyOf" the provider rule produces at the manifest root — with one
 * "must have required property" sibling per capability field — would not tell
 * the developer what to do: that cluster is collapsed into the explicit rule
 * (capabilities/provider-type.md).
 * @param {object[]} ajvErrors - Errors produced by AJV.
 * @returns {string[]} Human-readable reasons.
 */
function formatAjvErrors(ajvErrors) {
  const providerRule = ajvErrors.find((ajvError) => ajvError.keyword === 'anyOf' && ajvError.instancePath === '');
  if (providerRule === undefined) {
    return ajvErrors.map(formatAjvError);
  }
  // The rule is an if/then at the manifest root: the `if` error, the `anyOf`
  // error and its `required` siblings all live under that allOf entry.
  const clusterPath = `${providerRule.schemaPath.slice(0, providerRule.schemaPath.indexOf('/then/anyOf'))}/`;
  return [
    ...ajvErrors.filter((ajvError) => !ajvError.schemaPath.startsWith(clusterPath)).map(formatAjvError),
    `manifest.type: a provider integration must declare at least one capability field` +
      ` (${CAPABILITY_MANIFEST_FIELDS.join(', ')})`,
  ];
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
 * unknown reference would sit unresolved on screen forever. Some screens
 * refuse the placeholder outright, declared or not: the per-user contact
 * schema (the one screen a non-admin reaches, whose reduced view carries no
 * container state, so the token would resolve for an admin and stay raw for
 * everyone else), the widget settings (the dashboard editor is reachable by
 * non-admins for the same reason) and the scene editor (which never loads the
 * container detail that resolves it). `{{gladys_host}}` stays allowed
 * everywhere (the browser resolves it whatever the role), hence no rule here.
 * @param {object} field - A `section` config field.
 * @param {string} path - Dotted path of the field, for error messages.
 * @param {{declaredPortNames: Set<string>, portPlaceholdersUnavailableIn?: string}} context - Port names declared in the manifest, and the name of the screen refusing the placeholder outright, if any.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateSectionPortPlaceholders(field, path, context) {
  const errors = [];
  const check = (text, textPath) =>
    forEachPortPlaceholder(text, (name, language) => {
      if (context.portPlaceholdersUnavailableIn !== undefined) {
        errors.push(
          `${textPath}.${language}: {{port:${name}}} is not available in ${context.portPlaceholdersUnavailableIn}`,
        );
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
 * `contact_schema`, each action mini form (`fields`), each widget `settings`
 * list and the `fields` of each scene trigger / action.
 * @param {object[]} configSchema - Flat list of config fields.
 * @param {string} basePath - Dotted path of the list, for error messages.
 * @param {{declaredPortNames: Set<string>, portPlaceholdersUnavailableIn?: string}} context - Port names declared in the manifest, and the name of the screen refusing the {{port:<name>}} placeholder outright, if any.
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
  errors.push(...validateCredentialKeysRules(configSchema, basePath));
  return errors;
}

/**
 * Rules of the `credential_keys` of the account fields the schema cannot
 * express: a key stored next to the user preferences or the core's own
 * variables, a key the user fills in the form (a setting, never a
 * credential) and a key owned by two account fields (one disconnect would
 * log the other account out) are refused.
 * @param {object[]} configSchema - Flat list of config fields.
 * @param {string} basePath - Dotted path of the list, for error messages.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateCredentialKeysRules(configSchema, basePath) {
  const errors = [];
  const schemaKeys = configSchema.map((field) => field.key);
  const owners = new Map();
  configSchema.forEach((field, i) => {
    (field.credential_keys ?? []).forEach((key, keyIndex) => {
      const path = `${basePath}.${i}.credential_keys.${keyIndex}`;
      const storedName = key.toUpperCase();
      if (storedName.startsWith('GLADYS_') || CORE_SERVICE_VARIABLES.includes(storedName)) {
        errors.push(`${path}: "${key}" is reserved`);
      } else if (schemaKeys.includes(key)) {
        errors.push(`${path}: "${key}" is a config_schema key`);
      } else if (owners.has(key)) {
        errors.push(`${path}: "${key}" is already a credential key of ${owners.get(key)}`);
      } else {
        owners.set(key, field.key);
      }
    });
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
 * @param {{declaredPortNames: Set<string>}} context - Port names declared in the manifest.
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
 * Rules on the `widgets` list that JSON Schema cannot express
 * (capabilities/dashboard-widgets.md §1): key uniqueness (the key identifies
 * the widget in the dashboard box, the API and the WebSocket messages) and
 * the config-field rules of each `settings` list — keys unique within the
 * widget, and the {{port:<name>}} placeholder refused in its sections: the
 * dashboard editor is reachable by non-admins, whose reduced view carries no
 * container state.
 * @param {object[]} widgets - The manifest `widgets` array.
 * @param {{declaredPortNames: Set<string>}} context - Port names declared in the manifest.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateWidgetRules(widgets, context) {
  const errors = [];
  const seenKeys = new Set();
  widgets.forEach((widget, i) => {
    const path = `manifest.widgets.${i}`;
    if (seenKeys.has(widget.key)) {
      errors.push(`${path}.key: duplicate key "${widget.key}"`);
    }
    seenKeys.add(widget.key);
    if (widget.settings !== undefined) {
      errors.push(
        ...validateConfigSchemaRules(widget.settings, `${path}.settings`, {
          ...context,
          portPlaceholdersUnavailableIn: 'widget settings',
        }),
      );
    }
  });
  return errors;
}

/**
 * Rules on a `scene_triggers` / `scene_actions` list that JSON Schema cannot
 * express (capabilities/scene-triggers-and-actions.md §3): key uniqueness
 * within the list (triggers and actions are two namespaces — the scenes
 * store the key, which is never renamed once published), the config-field
 * rules of each `fields` mini form — keys unique within the declaration, and
 * the {{port:<name>}} placeholder refused in its sections: the scene editor
 * never loads the container detail that resolves it — and the key uniqueness
 * of the `variables` / `outputs` whitelist.
 * @param {object[]} declarations - The manifest `scene_triggers` or `scene_actions` array.
 * @param {string} listName - "scene_triggers" or "scene_actions".
 * @param {{declaredPortNames: Set<string>}} context - Port names declared in the manifest.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateSceneDeclarationRules(declarations, listName, context) {
  const errors = [];
  const seenKeys = new Set();
  const variablesName = SCENE_DECLARATION_LISTS[listName];
  declarations.forEach((declaration, i) => {
    const path = `manifest.${listName}.${i}`;
    if (seenKeys.has(declaration.key)) {
      errors.push(`${path}.key: duplicate key "${declaration.key}"`);
    }
    seenKeys.add(declaration.key);
    if (declaration.fields !== undefined) {
      errors.push(
        ...validateConfigSchemaRules(declaration.fields, `${path}.fields`, {
          ...context,
          portPlaceholdersUnavailableIn: 'the scene editor',
        }),
      );
    }
    const variables = declaration[variablesName];
    if (variables !== undefined) {
      const seenVariableKeys = new Set();
      variables.forEach((variable, variableIndex) => {
        if (seenVariableKeys.has(variable.key)) {
          errors.push(`${path}.${variablesName}.${variableIndex}.key: duplicate key "${variable.key}"`);
        }
        seenVariableKeys.add(variable.key);
      });
    }
  });
  return errors;
}

/**
 * Compatibility gate of the manifest additions: older Gladys releases
 * validate manifests with a strict field allowlist (and a closed `type` enum)
 * and reject any unknown field or type at install/update time. A manifest
 * declaring one of them must therefore require a range no older core
 * satisfies, which turns a cryptic install failure on old instances into the
 * standard "requires Gladys ≥ X" catalog filter. Only meaningful on a valid
 * range: an invalid `gladys_version` is already reported on its own.
 * @param {object} manifest - Schema-validated manifest with a valid gladys_version range.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateGladysVersionGates(manifest) {
  const minimumVersion = semver.minVersion(manifest.gladys_version);
  const satisfies = (version) => minimumVersion !== null && semver.gte(minimumVersion, version);
  const errors = [];
  const typeMinimum = MANIFEST_TYPE_MIN_GLADYS_VERSION[manifest.type];
  if (typeMinimum !== undefined && !satisfies(typeMinimum)) {
    errors.push(
      `manifest.gladys_version: type "${manifest.type}" requires ">=${typeMinimum}" at minimum` +
        ` (older Gladys releases reject manifests carrying an unknown type)`,
    );
  }
  Object.entries(MANIFEST_FIELD_MIN_GLADYS_VERSION).forEach(([field, fieldMinimum]) => {
    if (manifest[field] !== undefined && !satisfies(fieldMinimum)) {
      errors.push(
        `manifest.gladys_version: declaring ${field} requires ">=${fieldMinimum}" at minimum` +
          ` (older Gladys releases reject manifests carrying unknown fields)`,
      );
    }
  });
  Object.entries(CONFIG_FIELD_PROPERTY_MIN_GLADYS_VERSION).forEach(([property, propertyMinimum]) => {
    const declared = (manifest.config_schema ?? []).some((field) => field[property] !== undefined);
    if (declared && !satisfies(propertyMinimum)) {
      errors.push(
        `manifest.gladys_version: declaring ${property} on a config_schema field requires ` +
          `">=${propertyMinimum}" at minimum (older Gladys releases reject config fields carrying unknown properties)`,
      );
    }
  });
  return errors;
}

/**
 * Validate an integration manifest: JSON Schema first, then the rules the
 * schema cannot express (strict semver, semver range and its compatibility
 * gates, image references, config_schema/contact_schema/containers/actions/
 * webhooks/widgets/scene declarations consistency, sub-container port name
 * uniqueness and {{port:<name>}} placeholder references).
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
    return { valid: false, errors: formatAjvErrors(validateAgainstSchema.errors) };
  }

  const errors = [];
  if (semver.valid(manifest.version) !== manifest.version) {
    errors.push('manifest.version: must be valid semver');
  }
  if (semver.validRange(manifest.gladys_version) === null) {
    errors.push('manifest.gladys_version: must be a valid semver range');
  } else {
    errors.push(...validateGladysVersionGates(manifest));
  }
  if (!isValidDockerImageReference(manifest.docker_image)) {
    errors.push('manifest.docker_image: must be a valid image reference with an explicit tag or digest');
  }
  // Gathered first: the section texts of the config_schema and of the action
  // mini forms may reference these names with a {{port:<name>}} placeholder.
  const declaredPortNames = collectDeclaredPortNames(manifest.containers);
  const adminContext = { declaredPortNames };
  if (manifest.config_schema !== undefined) {
    errors.push(...validateConfigSchemaRules(manifest.config_schema, 'manifest.config_schema', adminContext));
  }
  // The per-user identity fields of a send-only channel share the flat config
  // field format (contract B.15), so they share its code rules too.
  if (manifest.contact_schema !== undefined) {
    errors.push(
      ...validateConfigSchemaRules(manifest.contact_schema, 'manifest.contact_schema', {
        declaredPortNames,
        portPlaceholdersUnavailableIn: 'the per-user contact schema',
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
  if (manifest.widgets !== undefined) {
    errors.push(...validateWidgetRules(manifest.widgets, adminContext));
  }
  Object.keys(SCENE_DECLARATION_LISTS).forEach((listName) => {
    if (manifest[listName] !== undefined) {
      errors.push(...validateSceneDeclarationRules(manifest[listName], listName, adminContext));
    }
  });

  return { valid: errors.length === 0, errors };
}
