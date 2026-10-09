import { expect } from 'chai';

import { isValidTimezone, sampleInputValues, validateEnergyContractsRules } from '../src/validateEnergyContracts.js';

describe('isValidTimezone', () => {
  it('should accept the IANA names the runtime knows and refuse the others', () => {
    expect(isValidTimezone('Europe/Paris')).to.equal(true);
    expect(isValidTimezone('Etc/GMT')).to.equal(true);
    expect(isValidTimezone('UTC')).to.equal(true);
    expect(isValidTimezone('Mars/Olympus')).to.equal(false);
    expect(isValidTimezone('')).to.equal(false);
  });
});

describe('sampleInputValues', () => {
  it('should use the declared default, else the first select option, else a sample of the type', () => {
    expect(
      sampleInputValues([
        { key: 'night_price', type: 'number', default: 0.12 },
        { key: 'region', type: 'select', options: ['A', 'B'], default: 'B' },
        { key: 'power', type: 'select', options: [6, 9, 12] },
        { key: 'off_peak_slots', type: 'time_intervals' },
        { key: 'note', type: 'string' },
        { key: 'count', type: 'number' },
        { key: 'kind', type: 'select' },
      ]),
    ).to.deep.equal({
      night_price: 0.12,
      region: 'B',
      power: 6,
      off_peak_slots: [['22:00', '06:00']],
      note: 'sample',
      count: 1,
      kind: 'sample',
    });
  });

  it('should default to no value at all', () => {
    expect(sampleInputValues()).to.deep.equal({});
  });
});

describe('validateEnergyContractsRules', () => {
  it('should accept templates alone, calendars alone, and a template without inputs nor calendars', () => {
    expect(
      validateEnergyContractsRules({
        templates: [
          {
            key: 'flat',
            name: { en: 'Flat' },
            country: 'FR',
            currency: 'EUR',
            pricing_mode: 'rules',
            version: '1',
            tariff: { tariff_version: 1, components: [{ key: 'e', kind: 'consumption', fallback: { price: 0.2 } }] },
          },
        ],
      }),
    ).to.deep.equal([]);
    expect(
      validateEnergyContractsRules({ calendars: [{ key: 'tempo', values: ['blue', 'white', 'red'] }] }),
    ).to.deep.equal([]);
  });
});
