import { substituteInputs, validateTariff } from './validateTariff.js';

// The value substituted for a template input without a default when the
// tariff is checked at publication time: a sample of the right type.
const SAMPLE_INPUT_VALUES = {
  number: 1,
  string: 'sample',
  select: 'sample',
  time_intervals: [['22:00', '06:00']],
};

/**
 * Tell whether a timezone is a name the runtime knows (IANA database).
 * @param {string} timezone - Timezone name, e.g. "Europe/Paris".
 * @returns {boolean} True when the runtime resolves it.
 */
export function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Rules of a template input the schema cannot express: `options` on a
 * `select` input only (1-64 values, declared by the schema), a select
 * `default` among its options, every other `default` matching its input type
 * (a finite number, a string, a list of [start, end] time intervals).
 * @param {object} input - A schema-validated template input.
 * @param {string} path - Dotted path of the input, for error messages.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateInputRules(input, path) {
  const errors = [];
  if (input.type === 'select') {
    if (input.options === undefined) {
      errors.push(`${path}.options: a select input needs 1-64 string or number options`);
    } else if (input.default !== undefined && !input.options.includes(input.default)) {
      errors.push(`${path}.default: must be one of the options`);
    }
  } else if (input.options !== undefined) {
    errors.push(`${path}.options: only a select input has options`);
  }
  if (input.default === undefined) {
    return errors;
  }
  if (input.type === 'number' && !Number.isFinite(input.default)) {
    errors.push(`${path}.default: must be a finite number`);
  }
  if (input.type === 'string' && typeof input.default !== 'string') {
    errors.push(`${path}.default: must be a string`);
  }
  if (
    input.type === 'time_intervals' &&
    (!Array.isArray(input.default) ||
      input.default.some((interval) => !Array.isArray(interval) || interval.length !== 2))
  ) {
    errors.push(`${path}.default: must be a list of [start, end] time intervals`);
  }
  return errors;
}

/**
 * The input values used to check a template tariff at publication time: the
 * declared defaults, the first option of a select (a real value: its options
 * may be numbers feeding a price or an amount), a sample of the right type
 * otherwise. Only inputs with a valid key take part — the others are
 * reported on their own.
 * @param {object[]} inputs - The schema-validated template inputs.
 * @returns {object} Values by input key.
 */
export function sampleInputValues(inputs = []) {
  const values = {};
  inputs.forEach((input) => {
    if (input.default !== undefined) {
      values[input.key] = input.default;
    } else if (input.type === 'select' && input.options !== undefined) {
      [values[input.key]] = input.options;
    } else {
      values[input.key] = SAMPLE_INPUT_VALUES[input.type];
    }
  });
  return values;
}

/**
 * Rules of the `tariff` of a template: the {{input:<key>}} placeholders must
 * name declared inputs, the substituted tariff must pass the tariff schema and
 * its semantic rules, a `rules` template needs at least one component, a
 * `delegated` one only carries `fixed` components (the integration prices the
 * energy, the core adds the subscription at display time), and every calendar
 * the tariff reads is listed in the template `calendars` (resolved at contract
 * creation against the installed providers and the catalogue).
 * @param {object} template - A schema-validated template carrying a tariff.
 * @param {string} path - Dotted path of the template, for error messages.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateTemplateTariff(template, path) {
  const tariffPath = `${path}.tariff`;
  const missingInputs = new Set();
  const tariff = substituteInputs(template.tariff, sampleInputValues(template.inputs), missingInputs);
  if (missingInputs.size > 0) {
    return [...missingInputs].map((key) => `${tariffPath}: missing input "${key}"`);
  }
  const tariffErrors = validateTariff(tariff, tariffPath);
  if (tariffErrors.length > 0) {
    return tariffErrors;
  }
  const errors = [];
  if (template.pricing_mode === 'rules' && tariff.components.length === 0) {
    errors.push(`${tariffPath}.components: at least one component is required in rules mode`);
  }
  if (template.pricing_mode === 'delegated') {
    tariff.components.forEach((component, i) => {
      if (component.kind !== 'fixed') {
        errors.push(
          `${tariffPath}.components.${i}.kind: a delegated template only carries fixed components (found "${component.kind}")`,
        );
      }
    });
  }
  const declaredCalendars = template.calendars ?? [];
  (tariff.calendars ?? []).forEach((key) => {
    if (!declaredCalendars.includes(key)) {
      errors.push(`${path}.calendars: the tariff references calendar "${key}", list it in the template calendars`);
    }
  });
  return errors;
}

/**
 * Rules of a contract template the schema cannot express: a known timezone,
 * unique input keys and the input rules, and the tariff rules above.
 * @param {object} template - A schema-validated template.
 * @param {string} path - Dotted path of the template, for error messages.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateTemplateRules(template, path) {
  const errors = [];
  if (template.timezone !== undefined && !isValidTimezone(template.timezone)) {
    errors.push(`${path}.timezone: must be a known IANA timezone`);
  }
  const seenInputKeys = new Set();
  (template.inputs ?? []).forEach((input, i) => {
    const inputPath = `${path}.inputs.${i}`;
    if (seenInputKeys.has(input.key)) {
      errors.push(`${inputPath}.key: duplicate key "${input.key}"`);
    }
    seenInputKeys.add(input.key);
    errors.push(...validateInputRules(input, inputPath));
  });
  // The tariff is checked once the inputs it is substituted with are sound.
  if (errors.length === 0 && template.tariff !== undefined) {
    errors.push(...validateTemplateTariff(template, path));
  }
  return errors;
}

/**
 * Rules on the `energy_contracts` capability field that JSON Schema cannot
 * express (capabilities/energy-contracts.md §1): template key uniqueness (the
 * key is stored by the contracts and never renamed), the template rules
 * above, calendar key uniqueness and known calendar timezones. Indexer and
 * Gladys server apply the same rules.
 * @param {object} energyContracts - The schema-validated manifest `energy_contracts` object.
 * @returns {string[]} Reasons, empty when valid.
 */
export function validateEnergyContractsRules(energyContracts) {
  const errors = [];
  const seenTemplateKeys = new Set();
  (energyContracts.templates ?? []).forEach((template, i) => {
    const path = `manifest.energy_contracts.templates.${i}`;
    if (seenTemplateKeys.has(template.key)) {
      errors.push(`${path}.key: duplicate key "${template.key}"`);
    }
    seenTemplateKeys.add(template.key);
    errors.push(...validateTemplateRules(template, path));
  });
  const seenCalendarKeys = new Set();
  (energyContracts.calendars ?? []).forEach((calendar, i) => {
    const path = `manifest.energy_contracts.calendars.${i}`;
    if (seenCalendarKeys.has(calendar.key)) {
      errors.push(`${path}.key: duplicate key "${calendar.key}"`);
    }
    seenCalendarKeys.add(calendar.key);
    if (calendar.timezone !== undefined && !isValidTimezone(calendar.timezone)) {
      errors.push(`${path}.timezone: must be a known IANA timezone`);
    }
  });
  return errors;
}
