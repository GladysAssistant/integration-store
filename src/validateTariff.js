import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';

const schemaPath = fileURLToPath(new URL('../schemas/tariff.schema.json', import.meta.url));
// Vendored copy of the tariff definition schema (canonical owner
// GladysAssistant/energy-contracts, the same copy the Gladys core embeds):
// the syntactic contract of the `tariff` of an energy contract template.
export const tariffSchema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv({ allErrors: true });
const validateAgainstSchema = ajv.compile(tariffSchema);

// {{input:<key>}} placeholder of a template tariff, substituted with the
// user's inputs when a contract is created — and with the declared defaults
// (or a sample of the right type) when the manifest is validated.
const INPUT_PLACEHOLDER_REGEX = /\{\{input:([a-z0-9_]+)\}\}/g;
const EXACT_INPUT_PLACEHOLDER_REGEX = /^\{\{input:([a-z0-9_]+)\}\}$/;

// The `component` definition of the schema is a oneOf discriminated by `kind`,
// in this order: the raw AJV errors of the three branches that cannot match
// are noise, only the errors of the declared kind's branch are reported.
const COMPONENT_KIND_BRANCHES = ['consumption', 'fixed', 'tax', 'demand'];

// Explicit messages for the other oneOf constructs of the schema, whose raw
// AJV errors ("must match exactly one schema in oneOf" plus one line per
// branch) would not tell the developer what to do.
const ONE_OF_MESSAGES = [
  {
    matches: (instancePath) => /\/(rules\/\d+|fallback)$/.test(instancePath),
    message:
      'exactly one of price and price_from_calendar is required (multiplier and offset only with price_from_calendar)',
  },
  {
    matches: (instancePath) => /\/tier$/.test(instancePath),
    message:
      'exactly one of from_kwh and from_kwh_per_day is required' +
      ' (to_kwh only with from_kwh, to_kwh_per_day only with from_kwh_per_day)',
  },
  {
    // the calendar value alternatives — the last oneOf of the schema, hence
    // the catch-all; review this list when the vendored schema is resynced
    matches: () => true,
    message: 'must be a string, a number or a list of them',
  },
];

/**
 * Replace the {{input:<key>}} placeholders of a template tariff with input
 * values: a string that is exactly a placeholder takes the value whatever its
 * JSON type (a number, an array of time intervals), a placeholder inside a
 * longer string is replaced by its text. The keys of the placeholders naming
 * no input are collected instead of substituted.
 * @param {*} node - Any JSON value of the tariff.
 * @param {object} inputs - Input values by key.
 * @param {Set<string>} missingInputs - Keys of the placeholders naming no input, filled along the way.
 * @returns {*} A deep copy with the placeholders substituted.
 */
export function substituteInputs(node, inputs, missingInputs) {
  if (typeof node === 'string') {
    const exact = node.match(EXACT_INPUT_PLACEHOLDER_REGEX);
    if (exact !== null) {
      if (!Object.hasOwn(inputs, exact[1])) {
        missingInputs.add(exact[1]);
        return node;
      }
      return inputs[exact[1]];
    }
    return node.replace(INPUT_PLACEHOLDER_REGEX, (match, key) => {
      if (!Object.hasOwn(inputs, key)) {
        missingInputs.add(key);
        return match;
      }
      return String(inputs[key]);
    });
  }
  if (Array.isArray(node)) {
    return node.map((item) => substituteInputs(item, inputs, missingInputs));
  }
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, substituteInputs(value, inputs, missingInputs)]),
    );
  }
  return node;
}

/**
 * Format the AJV errors of a tariff refused by the schema, collapsing the
 * oneOf constructs into explicit messages: the component errors of the
 * branches that cannot match the declared `kind` are dropped (an unknown kind
 * gets one message), and the price / tier / calendar value alternatives get
 * one sentence each instead of a line per branch.
 * @param {object[]} ajvErrors - Errors produced by AJV.
 * @param {object} tariff - The validated tariff.
 * @param {string} basePath - Dotted path of the tariff, for error messages.
 * @returns {string[]} Human-readable reasons.
 */
function formatTariffErrors(ajvErrors, tariff, basePath) {
  const format = (instancePath, message) => `${basePath}${instancePath.replaceAll('/', '.')}: ${message}`;
  const explicit = [];
  let remaining = ajvErrors;
  // Innermost constructs first: a rule's alternatives sit inside a component.
  const groups = ajvErrors
    .filter((ajvError) => ajvError.keyword === 'oneOf')
    .sort((a, b) => b.instancePath.length - a.instancePath.length);
  groups.forEach((group) => {
    const inGroup = (ajvError) =>
      ajvError.instancePath === group.instancePath || ajvError.instancePath.startsWith(`${group.instancePath}/`);
    const componentMatch = group.instancePath.match(/^\/components\/(\d+)$/);
    if (componentMatch !== null) {
      const component = tariff.components[Number(componentMatch[1])];
      const isObject = component !== null && typeof component === 'object';
      const branch = isObject ? COMPONENT_KIND_BRANCHES.indexOf(component.kind) : -1;
      if (isObject && branch === -1) {
        explicit.push(format(`${group.instancePath}/kind`, `must be one of ${COMPONENT_KIND_BRANCHES.join(', ')}`));
      }
      remaining = remaining.filter((ajvError) => {
        if (!inGroup(ajvError)) {
          return true;
        }
        if (branch === -1) {
          // an unknown kind: the branch errors are moot until it is fixed;
          // not an object at all: only that error matters
          return !isObject && ajvError.keyword === 'type';
        }
        const branchMatch = ajvError.schemaPath.match(/^#\/oneOf\/(\d+)\//);
        return ajvError !== group && (branchMatch === null || Number(branchMatch[1]) === branch);
      });
      return;
    }
    const { message } = ONE_OF_MESSAGES.find(({ matches }) => matches(group.instancePath));
    explicit.push(format(group.instancePath, message));
    remaining = remaining.filter((ajvError) => !(inGroup(ajvError) && /\/oneOf(\/\d+\/|$)/.test(ajvError.schemaPath)));
  });
  return [...new Set([...remaining.map((ajvError) => format(ajvError.instancePath, ajvError.message)), ...explicit])];
}

/**
 * Calendar keys a rule or a fallback reads: its `price_from_calendar`, the
 * `calendar` / `not_calendar` conditions of its `when`, and those of the
 * `counts_when` of its tier (the conditions deciding what feeds the
 * accumulation read calendars too).
 * @param {object} spec - A schema-validated rule or fallback.
 * @param {string} path - Dotted path of the spec, for error messages.
 * @returns {{key: string, path: string}[]} Referenced calendar keys with their path.
 */
function collectCalendarReferences(spec, path) {
  const references = [];
  if (spec.price_from_calendar !== undefined) {
    references.push({ key: spec.price_from_calendar, path: `${path}.price_from_calendar` });
  }
  const collectConditions = (when, whenPath) => {
    ['calendar', 'not_calendar'].forEach((conditionKey) => {
      if (when !== undefined && when[conditionKey] !== undefined) {
        Object.keys(when[conditionKey]).forEach((key) => {
          references.push({ key, path: `${whenPath}.${conditionKey}.${key}` });
        });
      }
    });
  };
  collectConditions(spec.when, `${path}.when`);
  if (spec.when !== undefined && spec.when.tier !== undefined) {
    collectConditions(spec.when.tier.counts_when, `${path}.when.tier.counts_when`);
  }
  return references;
}

/**
 * Rules of a tier condition the schema cannot express: an upper bound must be
 * greater than the lower bound of its kind.
 * @param {object} tier - A schema-validated tier condition.
 * @param {string} path - Dotted path of the tier, for error messages.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateTierBounds(tier, path) {
  const errors = [];
  if (tier.to_kwh !== undefined && tier.to_kwh <= tier.from_kwh) {
    errors.push(`${path}.to_kwh: must be greater than from_kwh`);
  }
  if (tier.to_kwh_per_day !== undefined && tier.to_kwh_per_day <= tier.from_kwh_per_day) {
    errors.push(`${path}.to_kwh_per_day: must be greater than from_kwh_per_day`);
  }
  return errors;
}

/**
 * Semantic rules of the tariff grammar the schema cannot express (listed in
 * the schema description, mirrored from the core validator): unique component
 * keys, a consumption component priced in every case (fallback or catch-all
 * last rule), tier upper bounds above their lower bounds, a tax applying to
 * components declared before it, and every referenced calendar listed in
 * `tariff.calendars`.
 * @param {object} tariff - A schema-validated tariff.
 * @param {string} basePath - Dotted path of the tariff, for error messages.
 * @returns {string[]} Reasons, empty when valid.
 */
function validateTariffSemantics(tariff, basePath) {
  const errors = [];
  const declaredCalendars = tariff.calendars ?? [];
  const seenKeys = new Set();
  const checkCalendarReferences = (spec, specPath) => {
    collectCalendarReferences(spec, specPath).forEach(({ key, path }) => {
      if (!declaredCalendars.includes(key)) {
        errors.push(`${path}: calendar "${key}" is not declared in tariff.calendars`);
      }
    });
  };
  tariff.components.forEach((component, i) => {
    const path = `${basePath}.components.${i}`;
    if (seenKeys.has(component.key)) {
      errors.push(`${path}.key: duplicate key "${component.key}"`);
    }
    if (component.kind === 'consumption') {
      const rules = component.rules ?? [];
      const lastRule = rules[rules.length - 1];
      if (component.fallback === undefined && (lastRule === undefined || lastRule.when !== undefined)) {
        errors.push(`${path}: a consumption component needs a fallback or a last rule without "when"`);
      }
      rules.forEach((rule, ruleIndex) => {
        const rulePath = `${path}.rules.${ruleIndex}`;
        checkCalendarReferences(rule, rulePath);
        if (rule.when !== undefined && rule.when.tier !== undefined) {
          errors.push(...validateTierBounds(rule.when.tier, `${rulePath}.when.tier`));
        }
      });
      if (component.fallback !== undefined) {
        checkCalendarReferences(component.fallback, `${path}.fallback`);
      }
    }
    if (component.kind === 'tax') {
      component.applies_to.forEach((key, keyIndex) => {
        if (!seenKeys.has(key)) {
          errors.push(
            `${path}.applies_to.${keyIndex}: component "${key}" must be declared before the tax that applies to it`,
          );
        }
      });
    }
    seenKeys.add(component.key);
  });
  return errors;
}

/**
 * Validate a tariff definition (the `tariff` of an energy contract template,
 * placeholders already substituted): the JSON Schema first, then the semantic
 * rules of the core engine. Indexer and Gladys server apply the same rules.
 * @param {object} tariff - The tariff definition.
 * @param {string} basePath - Dotted path of the tariff, for error messages.
 * @returns {string[]} Reasons, empty when valid.
 */
export function validateTariff(tariff, basePath) {
  if (!validateAgainstSchema(tariff)) {
    return formatTariffErrors(validateAgainstSchema.errors, tariff, basePath);
  }
  return validateTariffSemantics(tariff, basePath);
}
