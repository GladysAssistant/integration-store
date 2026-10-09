import { readFileSync } from 'node:fs';

import Ajv from 'ajv';
import { expect } from 'chai';

// The content vocabulary of the integration dashboard widgets
// (capabilities/dashboard-widgets.md §4-8), owned by this repository and
// published next to the manifest schema. The Gladys core enforces it with a
// normalizer that drops what it refuses; the SDK dev mode validates a payload
// against this very file before sending it.
const widgetContentSchema = JSON.parse(
  readFileSync(new URL('../schemas/widget-content.schema.json', import.meta.url), 'utf8'),
);

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(widgetContentSchema);

/**
 * Validate a content made of the given components.
 * @param {object[]} components - Components of the content.
 * @returns {boolean} True when the content matches the vocabulary.
 */
function accepts(components) {
  return validate({ components });
}

describe('widget-content.schema.json', () => {
  it('should expose the canonical vocabulary with its public $id', () => {
    expect(widgetContentSchema.$id).to.equal(
      'https://gladysassistant.github.io/integration-store/widget-content.schema.json',
    );
  });

  it('should accept the reference contents of the spec', () => {
    const cinema = {
      version: 1,
      ttl_seconds: 1800,
      components: [
        { type: 'text', variant: 'caption', text: { en: 'Next 30 days · France', fr: '30 prochains jours · France' } },
        {
          type: 'card-list',
          display: 'grid',
          items: [
            {
              title: "L'Odyssée",
              date: '2026-10-07',
              image: 'poster-20637522',
              badge: { text: { en: 'New', fr: 'Nouveau' }, color: 'info' },
              description: 'Après la mort de son père, …',
              links: [
                { url: 'https://www.youtube.com/watch?v=abc', label: { en: 'Trailer', fr: 'Bande-annonce' } },
                { url: 'https://www.themoviedb.org/movie/20637522', label: 'TMDB' },
              ],
            },
          ],
        },
      ],
    };
    expect(validate(cinema), JSON.stringify(validate.errors)).to.equal(true);

    const vacuum = {
      version: 1,
      components: [
        { type: 'value', label: { en: 'Battery', fr: 'Batterie' }, device_feature: 'ext:ext-roborock:s7:battery' },
        {
          type: 'status',
          items: [{ label: { en: 'State', fr: 'État' }, value: { en: 'Docked', fr: 'Sur la base' }, color: 'success' }],
        },
        {
          type: 'image',
          key: 'cleaning-map-3f9a2c',
          alt: { en: 'Last cleaning map', fr: 'Carte du dernier nettoyage' },
        },
        {
          type: 'button',
          label: { en: 'Start', fr: 'Démarrer' },
          style: 'primary',
          action: { key: 'start', params: { mode: 'full' } },
        },
        { type: 'button', label: { en: 'Dock', fr: 'Base' }, device_feature: 'ext:ext-roborock:s7:dock', value: 1 },
      ],
    };
    expect(validate(vacuum), JSON.stringify(validate.errors)).to.equal(true);
  });

  it('should accept an empty components list (the empty state is a valid state)', () => {
    expect(accepts([])).to.equal(true);
  });

  it('should reject more than 8 components, an unsupported version and a ttl outside 10-3600', () => {
    const text = { type: 'text', text: 'Hello' };
    expect(accepts(Array.from({ length: 9 }, () => text))).to.equal(false);
    expect(validate({ version: 2, components: [] })).to.equal(false);
    expect(validate({ version: 0, components: [] })).to.equal(false);
    expect(validate({ ttl_seconds: 5, components: [] })).to.equal(false);
    expect(validate({ ttl_seconds: 3601, components: [] })).to.equal(false);
    expect(validate({})).to.equal(false);
  });

  it('should reject a component of unknown type or with an unknown field', () => {
    expect(accepts([{ type: 'map' }])).to.equal(false);
    expect(accepts([{ type: 'text', text: 'Hello', color: 'primary' }])).to.equal(false);
  });

  it('should bound a text by its variant', () => {
    expect(accepts([{ type: 'text', variant: 'heading', text: 'x'.repeat(40) }])).to.equal(true);
    expect(accepts([{ type: 'text', variant: 'heading', text: 'x'.repeat(41) }])).to.equal(false);
    expect(accepts([{ type: 'text', variant: 'caption', text: { en: 'x'.repeat(81) } }])).to.equal(false);
    expect(accepts([{ type: 'text', text: 'x'.repeat(300) }])).to.equal(true);
    expect(accepts([{ type: 'text', variant: 'body', text: 'x'.repeat(301) }])).to.equal(false);
    expect(accepts([{ type: 'text', text: { fr: 'Sans anglais' } }])).to.equal(false);
  });

  it('should require exactly one of an inline value and a device binding on tiles', () => {
    expect(accepts([{ type: 'value', value: 21.5, unit: '°C', label: 'Living room' }])).to.equal(true);
    expect(accepts([{ type: 'value', value: 'x'.repeat(13) }])).to.equal(false);
    expect(accepts([{ type: 'value', label: 'No value' }])).to.equal(false);
    expect(accepts([{ type: 'value', value: 1, device_feature: 'ext:a:b' }])).to.equal(false);
    expect(accepts([{ type: 'value', device_feature: 'ext:a:b', unit: '%' }])).to.equal(false);
    expect(accepts([{ type: 'gauge', value: 42, min: 0, max: 100 }])).to.equal(true);
    expect(accepts([{ type: 'gauge', value: 42 }])).to.equal(false);
    expect(accepts([{ type: 'gauge', device_feature: 'ext:a:b', color: 'warning' }])).to.equal(true);
  });

  it('should bound the status rows', () => {
    const row = { label: 'State', value: 'Docked' };
    expect(accepts([{ type: 'status', items: Array.from({ length: 10 }, () => row) }])).to.equal(true);
    expect(accepts([{ type: 'status', items: Array.from({ length: 11 }, () => row) }])).to.equal(false);
    expect(accepts([{ type: 'status', items: [] }])).to.equal(false);
    expect(accepts([{ type: 'status', items: [{ label: 'State' }] }])).to.equal(false);
  });

  it('should accept the two chart forms and reject their mix', () => {
    const series = [{ name: 'Forecast', points: [{ t: '2026-09-18T10:00:00Z', v: 1.2 }] }];
    expect(
      accepts([
        {
          type: 'chart',
          series,
          chart_type: 'area',
          annotations: [{ t: '2026-09-19T07:48:00Z', value: 10.69, label: 'PM 10,69 m', color: 'primary' }],
          now_marker: true,
        },
      ]),
    ).to.equal(true);
    expect(accepts([{ type: 'chart', device_features: ['ext:solar:power'], interval: 'last-week' }])).to.equal(true);
    expect(accepts([{ type: 'chart', series, device_features: ['ext:solar:power'] }])).to.equal(false);
    expect(accepts([{ type: 'chart', series, interval: 'last-day' }])).to.equal(false);
    expect(accepts([{ type: 'chart', series: [{ points: [{ t: 'yesterday', v: 1 }] }] }])).to.equal(false);
    expect(accepts([{ type: 'chart', device_features: Array.from({ length: 5 }, () => 'ext:a:b') }])).to.equal(false);
  });

  it('should bound a card list by its display', () => {
    const items = (length) => Array.from({ length }, (unused, i) => ({ title: `Title ${i}` }));
    expect(accepts([{ type: 'card-list', display: 'grid', items: items(12) }])).to.equal(true);
    expect(accepts([{ type: 'card-list', display: 'grid', items: items(13) }])).to.equal(false);
    expect(accepts([{ type: 'card-list', items: items(8) }])).to.equal(true);
    expect(accepts([{ type: 'card-list', display: 'list', items: items(9) }])).to.equal(false);
    expect(accepts([{ type: 'card-list', items: [{ subtitle: 'No title' }] }])).to.equal(false);
    expect(accepts([{ type: 'card-list', items: [{ title: 'T', links: [{ url: 'http://a.com' }] }] }])).to.equal(false);
    expect(accepts([{ type: 'card-list', items: [{ title: 'T', image: 'Poster 1' }] }])).to.equal(false);
  });

  it('should require an image key and exactly one kind per button', () => {
    expect(accepts([{ type: 'image', key: 'map-3f9a2c', fit: 'contain' }])).to.equal(true);
    expect(accepts([{ type: 'image', alt: 'No key' }])).to.equal(false);
    expect(accepts([{ type: 'button', label: 'Open', link: { url: 'https://example.com' } }])).to.equal(true);
    expect(accepts([{ type: 'button', label: 'Start', action: { key: 'start', confirm: true } }])).to.equal(true);
    expect(accepts([{ type: 'button', label: 'Start', action: { key: 'S' } }])).to.equal(false);
    expect(accepts([{ type: 'button', label: 'Dock', device_feature: 'ext:a:b' }])).to.equal(false);
    expect(
      accepts([{ type: 'button', label: 'Both', action: { key: 'start' }, link: { url: 'https://a.com' } }]),
    ).to.equal(false);
    expect(accepts([{ type: 'button', action: { key: 'start' } }])).to.equal(false);
  });

  describe('action fields (the form behind a button)', () => {
    const button = (fields) => [
      { type: 'button', label: { en: 'Pallet delivered' }, action: { key: 'delivery', fields } },
    ];
    const field = (extra) => ({ key: 'bags', type: 'number', label: { en: 'Bags delivered' }, ...extra });

    it('should accept the reference form of the spec, and an empty list (no form at all)', () => {
      const content = {
        components: [
          {
            type: 'button',
            label: { en: 'Pallet delivered', fr: 'Palette livrée' },
            icon: 'truck',
            action: {
              key: 'delivery',
              fields: [
                {
                  key: 'bags',
                  type: 'number',
                  required: true,
                  min: 1,
                  max: 200,
                  default: 72,
                  label: { en: 'Bags delivered', fr: 'Sacs livrés' },
                },
                {
                  key: 'price_per_bag',
                  type: 'number',
                  required: true,
                  min: 0,
                  max: 50,
                  default: 7.3,
                  label: { en: 'Price per bag', fr: 'Prix par sac' },
                },
              ],
            },
          },
        ],
      };
      expect(validate(content), JSON.stringify(validate.errors)).to.equal(true);
      expect(accepts(button([]))).to.equal(true);
      expect(
        accepts(
          button([
            { key: 'note', type: 'string', label: { en: 'Note' }, placeholder: { en: 'Delivery note' }, default: 'x' },
            { key: 'paid', type: 'boolean', label: { en: 'Paid' }, default: true },
            {
              key: 'supplier',
              type: 'select',
              label: { en: 'Supplier' },
              display: 'radio',
              default: 'acme',
              options: [{ value: 'acme', label: { en: 'Acme', fr: 'Acme' } }],
              description: { en: 'Who delivered.' },
            },
          ]),
        ),
      ).to.equal(true);
    });

    it('should bound the form to 4 fields of the restricted grammar', () => {
      expect(accepts(button([1, 2, 3, 4, 5].map((i) => field({ key: `f${i}` }))))).to.equal(false);
      expect(accepts(button([field({ type: 'section' })]))).to.equal(false);
      expect(
        accepts(button([field({ type: 'multi_select', options: [{ value: 'a', label: { en: 'A' } }] })])),
      ).to.equal(false);
      expect(accepts(button([field({ type: 'secret' })]))).to.equal(false);
      expect(accepts(button([field({ key: 'Bad-Key' })]))).to.equal(false);
      expect(accepts(button([field({ nope: 1 })]))).to.equal(false);
      expect(accepts(button([field({ label: 'Bags' })]))).to.equal(false);
    });

    it('should refuse a dynamic source: the options are written in the content', () => {
      expect(accepts(button([field({ type: 'select', source: 'devices' })]))).to.equal(false);
      expect(accepts(button([field({ type: 'select' })]))).to.equal(false);
      expect(accepts(button([field({ options: [{ value: 'a', label: { en: 'A' } }] })]))).to.equal(false);
      expect(accepts(button([field({ display: 'radio' })]))).to.equal(false);
    });

    it('should apply the per-type rules of min/max, placeholder and default', () => {
      expect(accepts(button([field({ type: 'string', min: 1 })]))).to.equal(false);
      expect(accepts(button([field({ type: 'boolean', placeholder: { en: 'x' } })]))).to.equal(false);
      expect(accepts(button([field({ default: 'many' })]))).to.equal(false);
      expect(accepts(button([field({ type: 'string', default: 1 })]))).to.equal(false);
      expect(accepts(button([field({ type: 'boolean', default: 'yes' })]))).to.equal(false);
      expect(
        accepts(button([field({ type: 'select', options: [{ value: 'a', label: { en: 'A' } }], default: 1 })])),
      ).to.equal(false);
      expect(accepts(button([field({ type: 'string', default: 'x'.repeat(1001) })]))).to.equal(false);
      expect(accepts(button([field({ type: 'string', default: 'x'.repeat(1000) })]))).to.equal(true);
    });

    it('should bound the texts like every widget string', () => {
      expect(accepts(button([field({ label: { en: 'x'.repeat(41) } })]))).to.equal(false);
      expect(accepts(button([field({ description: { en: 'x'.repeat(201) } })]))).to.equal(false);
      expect(accepts(button([field({ placeholder: { en: 'x'.repeat(41) } })]))).to.equal(false);
      expect(
        accepts(button([field({ type: 'select', options: [{ value: 'a', label: { en: 'x'.repeat(41) } }] })])),
      ).to.equal(false);
      expect(accepts(button([field({ label: { en: 'x'.repeat(40), fr: 'Sacs' } })]))).to.equal(true);
    });
  });
});
