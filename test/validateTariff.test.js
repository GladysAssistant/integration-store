import { expect } from 'chai';

import { substituteInputs, tariffSchema, validateTariff } from '../src/validateTariff.js';

// The tariff definition grammar of the energy contracts (docs/specs/
// energy-contracts.md §4), validated for every `energy_contracts` template:
// the vendored tariff.schema.json is the syntactic contract, the semantic
// rules its description lists are enforced in code. The fixture pack below
// is the one the Gladys core keeps in sync with its own Joi mirror: valid
// tariffs accepted by both, invalid tariffs rejected by both, and the
// semantic-only tariffs the schema accepts and the core rejects.
const consumption = (extra = {}) => ({ key: 'energy', kind: 'consumption', fallback: { price: 0.25 }, ...extra });
const base = (components, calendars) => ({ tariff_version: 1, calendars, components });

const VALID = {
  base: base([consumption()]),
  'catch-all rule': base([
    { key: 'e', kind: 'consumption', rules: [{ when: { time: [['22:00', '06:00']] }, price: 0.1 }, { price: 0.2 }] },
  ]),
  'every condition and component': base(
    [
      {
        key: 'energy',
        kind: 'consumption',
        label: 'Energy',
        rules: [
          { label: 'Red peak', when: { calendar: { tempo: 'red' }, time: [['06:00', '22:00']] }, price: 0.7562 },
          {
            when: { not_calendar: { holidays: ['holiday', 1] } },
            price_from_calendar: 'spot',
            multiplier: 1.1,
            offset: 0.02,
          },
          { when: { tier: { cumulative: 'day', from_kwh: 0, to_kwh: 40 }, weekdays: ['sat', 'sun'] }, price: 0.1 },
          {
            when: {
              season: { from: '11-01', to: '03-31' },
              months: [1],
              dates: { from: '2026-01-01', to: '2026-12-31' },
            },
            price: 0.2,
          },
          { when: { power_threshold: { above_kw: 6 }, time: [['22:00', '24:00']] }, price: 0.3 },
        ],
        fallback: { label: 'Base', price_from_calendar: 'spot' },
      },
      { key: 'sub', kind: 'fixed', amount: 17.11, per: 'month', when: { months: [1, 2], weekdays: ['mon'] } },
      { key: 'vat', kind: 'tax', rate: 20, applies_to: ['energy', 'sub'] },
      {
        key: 'peak',
        kind: 'demand',
        price: 3,
        per: 'billing_period',
        aggregation: 'top3_average',
        when: { season: { from: '06-01', to: '09-30' } },
      },
    ],
    ['tempo', 'holidays', 'spot'],
  ),
  // a delegated contract without fixed fees
  'empty components': base([]),
  'per-day tier with counting conditions': base(
    [
      consumption({
        rules: [
          {
            when: {
              tier: {
                cumulative: 'billing_period',
                from_kwh_per_day: 0,
                to_kwh_per_day: 40,
                counts_when: { not_calendar: { peaks: 'peak' }, time: [['06:00', '22:00']], weekdays: ['mon'] },
              },
            },
            price: 0.05,
          },
          { when: { tier: { cumulative: 'month', from_kwh_per_day: 40 } }, price: 0.09 },
        ],
      }),
    ],
    ['peaks'],
  ),
};

// Rejected by the schema.
const INVALID = {
  'wrong version': { tariff_version: 2, components: [consumption()] },
  'no components': { tariff_version: 1 },
  'unknown kind': base([{ key: 'e', kind: 'magic' }]),
  'unknown key': base([consumption({ foo: 1 })]),
  'bad component key': base([consumption({ key: 'Energy!' })]),
  'price and calendar price': base([consumption({ fallback: { price: 1, price_from_calendar: 'spot' } })], ['spot']),
  'multiplier without calendar price': base([consumption({ fallback: { price: 1, multiplier: 2 } })]),
  'offset without calendar price': base([consumption({ rules: [{ price: 1, offset: 0.1 }] })]),
  'negative price': base([consumption({ fallback: { price: -1 } })]),
  'time 24:00 as a start': base([consumption({ rules: [{ when: { time: [['24:00', '06:00']] }, price: 1 }] })]),
  'time 24:30': base([consumption({ rules: [{ when: { time: [['24:30', '06:00']] }, price: 1 }] })]),
  'time 6:00': base([consumption({ rules: [{ when: { time: [['6:00', '22:00']] }, price: 1 }] })]),
  'time one bound': base([consumption({ rules: [{ when: { time: [['06:00']] }, price: 1 }] })]),
  'bad weekday': base([consumption({ rules: [{ when: { weekdays: ['monday'] }, price: 1 }] })]),
  'duplicate weekday': base([consumption({ rules: [{ when: { weekdays: ['mon', 'mon'] }, price: 1 }] })]),
  'month 13': base([consumption({ rules: [{ when: { months: [13] }, price: 1 }] })]),
  'bad season': base([consumption({ rules: [{ when: { season: { from: '13-01', to: '03-31' } }, price: 1 }] })]),
  'bad date': base([consumption({ rules: [{ when: { dates: { from: '2026/01/01' } }, price: 1 }] })]),
  'empty when': base([consumption({ rules: [{ when: {}, price: 1 }] })]),
  'bad cumulative': base([consumption({ rules: [{ when: { tier: { cumulative: 'week', from_kwh: 0 } }, price: 1 }] })]),
  'negative tier': base([consumption({ rules: [{ when: { tier: { cumulative: 'day', from_kwh: -1 } }, price: 1 }] })]),
  'tier without bounds': base([consumption({ rules: [{ when: { tier: { cumulative: 'day' } }, price: 1 }] })]),
  'tier with fixed and per-day bounds': base([
    consumption({ rules: [{ when: { tier: { cumulative: 'day', from_kwh: 0, from_kwh_per_day: 0 } }, price: 1 }] }),
  ]),
  'tier to_kwh with per-day from': base([
    consumption({ rules: [{ when: { tier: { cumulative: 'day', from_kwh_per_day: 0, to_kwh: 40 } }, price: 1 }] }),
  ]),
  'tier to_kwh_per_day with fixed from': base([
    consumption({ rules: [{ when: { tier: { cumulative: 'day', from_kwh: 0, to_kwh_per_day: 40 } }, price: 1 }] }),
  ]),
  'tier empty counts_when': base([
    consumption({ rules: [{ when: { tier: { cumulative: 'day', from_kwh: 0, counts_when: {} } }, price: 1 }] }),
  ]),
  'tier counts_when with a tier': base([
    consumption({
      rules: [
        {
          when: { tier: { cumulative: 'day', from_kwh: 0, counts_when: { tier: { cumulative: 'day', from_kwh: 0 } } } },
          price: 1,
        },
      ],
    }),
  ]),
  'tier counts_when with a power threshold': base([
    consumption({
      rules: [
        {
          when: { tier: { cumulative: 'day', from_kwh: 0, counts_when: { power_threshold: { above_kw: 6 } } } },
          price: 1,
        },
      ],
    }),
  ]),
  'calendar value too long': base(
    [consumption({ rules: [{ when: { calendar: { tempo: 'x'.repeat(65) } }, price: 1 }] })],
    ['tempo'],
  ),
  'calendar value of the wrong type': base(
    [consumption({ rules: [{ when: { calendar: { tempo: { color: 'red' } } }, price: 1 }] })],
    ['tempo'],
  ),
  'bad calendar key': base([consumption()], ['Tempo']),
  'too many calendars': base([consumption()], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']),
  'fixed bad period': base([consumption(), { key: 'sub', kind: 'fixed', amount: 1, per: 'week' }]),
  'fixed without amount': base([consumption(), { key: 'sub', kind: 'fixed', per: 'day' }]),
  'fixed with time condition': base([
    consumption(),
    { key: 'sub', kind: 'fixed', amount: 1, per: 'day', when: { time: [['00:00', '12:00']] } },
  ]),
  'tax without applies_to': base([consumption(), { key: 'vat', kind: 'tax', rate: 20 }]),
  'tax empty applies_to': base([consumption(), { key: 'vat', kind: 'tax', rate: 20, applies_to: [] }]),
  'demand bad period': base([consumption(), { key: 'd', kind: 'demand', price: 1, per: 'day' }]),
  'demand bad aggregation': base([
    consumption(),
    { key: 'd', kind: 'demand', price: 1, per: 'month', aggregation: 'median' },
  ]),
  'too many components': base(
    Array.from({ length: 17 }, (_, i) => ({ key: `c${i}`, kind: 'fixed', amount: 1, per: 'day' })),
  ),
  'too many rules': base([consumption({ rules: Array.from({ length: 65 }, () => ({ price: 1 })) })]),
  'component without kind': base([{ key: 'e' }]),
  'component that is not an object': base(['energy']),
};

// Accepted by the schema (syntactic contract), rejected by the code rules.
const SEMANTIC_ONLY = {
  'no fallback nor catch-all rule': base([
    { key: 'e', kind: 'consumption', rules: [{ when: { time: [['06:00', '22:00']] }, price: 0.1 }] },
  ]),
  'no fallback nor rule at all': base([{ key: 'e', kind: 'consumption' }]),
  'tier to_kwh below from_kwh': base([
    consumption({ rules: [{ when: { tier: { cumulative: 'day', from_kwh: 5, to_kwh: 2 } }, price: 1 }] }),
  ]),
  'tier to_kwh_per_day below from_kwh_per_day': base([
    consumption({
      rules: [{ when: { tier: { cumulative: 'day', from_kwh_per_day: 5, to_kwh_per_day: 2 } }, price: 1 }],
    }),
  ]),
  'duplicate component keys': base([consumption(), { key: 'energy', kind: 'fixed', amount: 1, per: 'day' }]),
  'tax before its component': base([{ key: 'vat', kind: 'tax', rate: 20, applies_to: ['energy'] }, consumption()]),
  'undeclared calendar in a condition': base([
    consumption({ rules: [{ when: { calendar: { tempo: 'red' } }, price: 1 }] }),
  ]),
  'undeclared calendar price': base([consumption({ fallback: { price_from_calendar: 'spot' } })]),
  'undeclared calendar in a counts_when': base([
    consumption({
      rules: [
        { when: { tier: { cumulative: 'day', from_kwh: 0, counts_when: { calendar: { peaks: 'peak' } } } }, price: 1 },
      ],
    }),
  ]),
};

describe('tariffSchema', () => {
  it('should expose the vendored schema with the $id of its canonical owner', () => {
    expect(tariffSchema.$id).to.equal('https://gladysassistant.com/schemas/energy-contracts/tariff.schema.json');
    expect(tariffSchema.$comment).to.include('Vendored copy');
  });
});

describe('validateTariff', () => {
  it('should accept the valid fixtures', () => {
    Object.entries(VALID).forEach(([name, tariff]) => {
      expect(validateTariff(tariff, 'tariff'), name).to.deep.equal([]);
    });
  });

  it('should reject the invalid fixtures through the schema', () => {
    Object.entries(INVALID).forEach(([name, tariff]) => {
      const errors = validateTariff(tariff, 'tariff');
      expect(errors, name).to.not.be.empty;
      errors.forEach((error) => expect(error, name).to.match(/^tariff(\.|:)/));
    });
  });

  it('should reject the semantic-only fixtures through the code rules', () => {
    Object.entries(SEMANTIC_ONLY).forEach(([name, tariff]) => {
      expect(validateTariff(tariff, 'tariff'), name).to.not.be.empty;
    });
  });

  it('should report the semantic rules with the path of the offending node', () => {
    const tariff = base([
      { key: 'vat', kind: 'tax', rate: 20, applies_to: ['e'] },
      {
        key: 'e',
        kind: 'consumption',
        rules: [
          { when: { tier: { cumulative: 'day', from_kwh: 5, to_kwh: 2 }, calendar: { tempo: 'red' } }, price: 1 },
          {
            when: {
              tier: {
                cumulative: 'day',
                from_kwh_per_day: 5,
                to_kwh_per_day: 2,
                counts_when: { not_calendar: { peaks: 'peak' } },
              },
            },
            price_from_calendar: 'spot',
          },
        ],
        fallback: { price_from_calendar: 'spot' },
      },
      { key: 'e', kind: 'fixed', amount: 1, per: 'day' },
    ]);
    expect(validateTariff(tariff, 'manifest.energy_contracts.templates.0.tariff')).to.deep.equal([
      'manifest.energy_contracts.templates.0.tariff.components.0.applies_to.0: component "e" must be declared before the tax that applies to it',
      'manifest.energy_contracts.templates.0.tariff.components.1.rules.0.when.calendar.tempo: calendar "tempo" is not declared in tariff.calendars',
      'manifest.energy_contracts.templates.0.tariff.components.1.rules.0.when.tier.to_kwh: must be greater than from_kwh',
      'manifest.energy_contracts.templates.0.tariff.components.1.rules.1.price_from_calendar: calendar "spot" is not declared in tariff.calendars',
      'manifest.energy_contracts.templates.0.tariff.components.1.rules.1.when.tier.counts_when.not_calendar.peaks: calendar "peaks" is not declared in tariff.calendars',
      'manifest.energy_contracts.templates.0.tariff.components.1.rules.1.when.tier.to_kwh_per_day: must be greater than from_kwh_per_day',
      'manifest.energy_contracts.templates.0.tariff.components.1.fallback.price_from_calendar: calendar "spot" is not declared in tariff.calendars',
      'manifest.energy_contracts.templates.0.tariff.components.2.key: duplicate key "e"',
    ]);
  });

  it('should report a schema error with the path of the offending node', () => {
    expect(validateTariff(INVALID['negative price'], 'tariff')).to.deep.equal([
      'tariff.components.0.fallback.price: must be >= 0',
    ]);
    expect(validateTariff(INVALID['time 6:00'], 'tariff')).to.deep.equal([
      'tariff.components.0.rules.0.when.time.0.0: must match pattern "^([01][0-9]|2[0-3]):[0-5][0-9]$"',
    ]);
    expect(validateTariff(INVALID['too many rules'], 'tariff')).to.deep.equal([
      'tariff.components.0.rules: must NOT have more than 64 items',
    ]);
    expect(validateTariff(INVALID['no components'], 'tariff')).to.deep.equal([
      "tariff: must have required property 'components'",
    ]);
  });

  it('should collapse the component alternatives into the errors of the declared kind', () => {
    expect(validateTariff(INVALID['fixed without amount'], 'tariff')).to.deep.equal([
      "tariff.components.1: must have required property 'amount'",
    ]);
    expect(validateTariff(INVALID['unknown key'], 'tariff')).to.deep.equal([
      'tariff.components.0: must NOT have additional properties',
    ]);
    expect(validateTariff(INVALID['unknown kind'], 'tariff')).to.deep.equal([
      'tariff.components.0.kind: must be one of consumption, fixed, tax, demand',
    ]);
    expect(validateTariff(INVALID['component without kind'], 'tariff')).to.deep.equal([
      "tariff.components.0: must have required property 'kind'",
    ]);
    expect(validateTariff(INVALID['component that is not an object'], 'tariff')).to.deep.equal([
      'tariff.components.0: must be object',
    ]);
    // one message per broken component, the errors of the others untouched
    expect(
      validateTariff(
        base([
          consumption({ fallback: { price: -1 } }),
          { key: 'sub', kind: 'fixed', per: 'day' },
          { key: 'x', kind: 'magic' },
        ]),
        'tariff',
      ),
    ).to.deep.equal([
      'tariff.components.0.fallback.price: must be >= 0',
      "tariff.components.1: must have required property 'amount'",
      'tariff.components.2.kind: must be one of consumption, fixed, tax, demand',
    ]);
  });

  it('should collapse the price, tier and calendar value alternatives into one explicit message', () => {
    const priceMessage =
      'exactly one of price and price_from_calendar is required (multiplier and offset only with price_from_calendar)';
    expect(validateTariff(INVALID['price and calendar price'], 'tariff')).to.deep.equal([
      `tariff.components.0.fallback: ${priceMessage}`,
    ]);
    expect(validateTariff(INVALID['multiplier without calendar price'], 'tariff')).to.deep.equal([
      `tariff.components.0.fallback: ${priceMessage}`,
    ]);
    expect(validateTariff(INVALID['offset without calendar price'], 'tariff')).to.deep.equal([
      `tariff.components.0.rules.0: ${priceMessage}`,
    ]);
    const tierMessage =
      'exactly one of from_kwh and from_kwh_per_day is required' +
      ' (to_kwh only with from_kwh, to_kwh_per_day only with from_kwh_per_day)';
    expect(validateTariff(INVALID['tier without bounds'], 'tariff')).to.deep.equal([
      `tariff.components.0.rules.0.when.tier: ${tierMessage}`,
    ]);
    expect(validateTariff(INVALID['tier to_kwh with per-day from'], 'tariff')).to.deep.equal([
      `tariff.components.0.rules.0.when.tier: ${tierMessage}`,
    ]);
    expect(validateTariff(INVALID['calendar value of the wrong type'], 'tariff')).to.deep.equal([
      'tariff.components.0.rules.0.when.calendar.tempo: must be a string, a number or a list of them',
    ]);
  });
});

describe('substituteInputs', () => {
  it('should replace an exact placeholder by the typed value and an inline one by its text', () => {
    const missing = new Set();
    const tariff = {
      tariff_version: 1,
      components: [
        {
          key: 'energy',
          kind: 'consumption',
          rules: [{ label: 'Night ({{input:slots}})', when: { time: '{{input:slots}}' }, price: '{{input:price}}' }],
          fallback: { price: 0.2 },
        },
        { key: 'power', kind: 'fixed', amount: '{{input:power}}', per: 'month', label: '{{input:power}} kVA' },
      ],
    };
    const substituted = substituteInputs(tariff, { slots: [['22:00', '06:00']], price: 0.12, power: 9 }, missing);
    expect(substituted.components[0].rules[0]).to.deep.equal({
      label: 'Night (22:00,06:00)',
      when: { time: [['22:00', '06:00']] },
      price: 0.12,
    });
    expect(substituted.components[1]).to.deep.equal({
      key: 'power',
      kind: 'fixed',
      amount: 9,
      per: 'month',
      label: '9 kVA',
    });
    expect(missing.size).to.equal(0);
    // the original is left untouched
    expect(tariff.components[0].rules[0].price).to.equal('{{input:price}}');
    expect(validateTariff(substituted, 'tariff')).to.deep.equal([]);
  });

  it('should collect the placeholders naming no input and leave them in place', () => {
    const missing = new Set();
    const substituted = substituteInputs(
      { price: '{{input:a}}', label: 'x {{input:b}} {{input:c}}', n: null },
      { c: 1 },
      missing,
    );
    expect(substituted).to.deep.equal({ price: '{{input:a}}', label: 'x {{input:b}} 1', n: null });
    expect([...missing]).to.deep.equal(['a', 'b']);
  });
});
