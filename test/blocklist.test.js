import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

import {
  BLOCKLIST_SCOPES,
  EMPTY_BLOCKLIST,
  blocklistRejectionReason,
  findBlocklistEntry,
  loadBlocklist,
  validateBlocklist,
} from '../src/blocklist.js';

const ENTRY = {
  reason: 'Impersonates the official Philips Hue integration; the Docker image exfiltrates credentials',
  reference: 'https://github.com/GladysAssistant/integration-store/issues/42',
  blocked_at: '2026-10-06',
};

/**
 * Build a blocklist document from partial sections.
 * @param {object} overrides - Sections to override.
 * @returns {object} Blocklist document.
 */
function blocklist(overrides = {}) {
  return { repositories: {}, owners: {}, ...overrides };
}

describe('loadBlocklist', () => {
  it('should load the committed data/blocklist.json, which must be valid', () => {
    const loaded = loadBlocklist();
    expect(loaded).to.have.all.keys('repositories', 'owners');
    expect(validateBlocklist(loaded)).to.deep.equal([]);
  });

  it('should abort on an invalid file rather than silently re-admit a blocked integration', () => {
    const filePath = fileURLToPath(new URL('./fixtures/invalid-blocklist.json', import.meta.url));
    expect(() => loadBlocklist({ filePath }))
      .to.throw(Error, 'invalid blocklist')
      .with.property('message')
      .that.includes('repositories.evil-corp/gladys-philips-hue.reason')
      .and.includes('repositories.evil-corp/gladys-philips-hue.reference')
      .and.includes('repositories.evil-corp/gladys-philips-hue.blocked_at');
  });
});

describe('validateBlocklist', () => {
  it('should accept a well-formed document', () => {
    expect(
      validateBlocklist(
        blocklist({
          repositories: { 'evil-corp/gladys-philips-hue': ENTRY },
          owners: { 'another-evil': { ...ENTRY, reference: 'https://example.com/report' } },
        }),
      ),
    ).to.deep.equal([]);
  });

  it('should accept the empty blocklist', () => {
    expect(validateBlocklist(EMPTY_BLOCKLIST)).to.deep.equal([]);
  });

  it('should reject a document that is not an object', () => {
    expect(validateBlocklist(null)).to.deep.equal([
      'blocklist: must be a JSON object with "repositories" and "owners"',
    ]);
    expect(validateBlocklist([])).to.have.lengthOf(1);
  });

  it('should reject sections that are not objects', () => {
    expect(validateBlocklist({ repositories: [], owners: null })).to.deep.equal([
      'repositories: must be an object keyed by store_slug (owner/repo)',
      'owners: must be an object keyed by GitHub owner login',
    ]);
  });

  it('should reject malformed keys', () => {
    const errors = validateBlocklist(
      blocklist({
        repositories: { 'not a slug': ENTRY, 'too/many/parts': ENTRY },
        owners: { 'evil/corp': ENTRY },
      }),
    );
    expect(errors).to.deep.equal([
      'repositories.not a slug: key must be a store_slug (owner/repo)',
      'repositories.too/many/parts: key must be a store_slug (owner/repo)',
      'owners.evil/corp: key must be a GitHub owner login',
    ]);
  });

  it('should reject keys differing only by case (GitHub names are case-insensitive)', () => {
    const errors = validateBlocklist(
      blocklist({ repositories: { 'Evil-Corp/gladys-hue': ENTRY, 'evil-corp/Gladys-Hue': ENTRY } }),
    );
    expect(errors).to.deep.equal([
      'repositories.evil-corp/Gladys-Hue: duplicate of another key differing only by case',
    ]);
  });

  it('should reject an entry that is not an object', () => {
    expect(validateBlocklist(blocklist({ owners: { evil: 'because' } }))).to.deep.equal([
      'owners.evil: must be an object with reason, reference, blocked_at',
    ]);
  });

  it('should reject unknown and malformed entry fields', () => {
    const errors = validateBlocklist(
      blocklist({
        owners: {
          evil: { reason: '   ', reference: 'http://insecure.example', blocked_at: '2026-02-31', note: 'x' },
        },
      }),
    );
    expect(errors).to.deep.equal([
      'owners.evil: unknown field "note" (allowed: reason, reference, blocked_at)',
      'owners.evil.reason: must be a non-empty string (it is published verbatim in rejected.json)',
      'owners.evil.reference: must be an https URL (the public issue documenting the case)',
      'owners.evil.blocked_at: must be a calendar date in YYYY-MM-DD form',
    ]);
  });

  it('should reject missing entry fields and a non-ISO date', () => {
    const errors = validateBlocklist(blocklist({ owners: { evil: { blocked_at: '06/10/2026' } } }));
    expect(errors).to.deep.equal([
      'owners.evil.reason: must be a non-empty string (it is published verbatim in rejected.json)',
      'owners.evil.reference: must be an https URL (the public issue documenting the case)',
      'owners.evil.blocked_at: must be a calendar date in YYYY-MM-DD form',
    ]);
  });

  it('should reject a repository entry made redundant by a blocked owner', () => {
    const errors = validateBlocklist(
      blocklist({ repositories: { 'Evil-Corp/gladys-hue': ENTRY }, owners: { 'evil-corp': ENTRY } }),
    );
    expect(errors).to.deep.equal([
      'repositories.Evil-Corp/gladys-hue: redundant, owner "Evil-Corp" is already blocked',
    ]);
  });
});

describe('findBlocklistEntry', () => {
  const loaded = {
    repositories: { 'evil-corp/gladys-philips-hue': ENTRY },
    owners: { 'another-evil': { ...ENTRY, reason: 'Keeps republishing malicious integrations' } },
  };

  it('should return null when neither the repository nor its owner is blocked', () => {
    expect(findBlocklistEntry({ storeSlug: 'john/gladys-demo', owner: 'john', blocklist: loaded })).to.equal(null);
    expect(findBlocklistEntry({ storeSlug: 'john/gladys-demo', owner: 'john', blocklist: EMPTY_BLOCKLIST })).to.equal(
      null,
    );
  });

  it('should match a blocked repository, case-insensitively, keeping the key as written in the file', () => {
    expect(
      findBlocklistEntry({ storeSlug: 'Evil-Corp/Gladys-Philips-Hue', owner: 'Evil-Corp', blocklist: loaded }),
    ).to.deep.equal({ scope: BLOCKLIST_SCOPES.REPOSITORY, key: 'evil-corp/gladys-philips-hue', entry: ENTRY });
  });

  it('should match a blocked owner whatever the repository name', () => {
    expect(
      findBlocklistEntry({ storeSlug: 'Another-Evil/brand-new-repo', owner: 'Another-Evil', blocklist: loaded }),
    ).to.deep.equal({ scope: BLOCKLIST_SCOPES.OWNER, key: 'another-evil', entry: loaded.owners['another-evil'] });
  });

  it('should prefer the repository entry over the owner entry', () => {
    const both = {
      repositories: { 'evil/repo': { ...ENTRY, reason: 'specific' } },
      owners: { evil: { ...ENTRY, reason: 'generic' } },
    };
    expect(findBlocklistEntry({ storeSlug: 'evil/repo', owner: 'evil', blocklist: both }).entry.reason).to.equal(
      'specific',
    );
  });
});

describe('blocklistRejectionReason', () => {
  it('should prefix the public reason and reference with "blocklist:" for a blocked repository', () => {
    expect(
      blocklistRejectionReason({
        scope: BLOCKLIST_SCOPES.REPOSITORY,
        key: 'evil-corp/gladys-philips-hue',
        entry: ENTRY,
      }),
    ).to.equal(
      'blocklist: repository is blocked — Impersonates the official Philips Hue integration; the Docker image' +
        ' exfiltrates credentials (see https://github.com/GladysAssistant/integration-store/issues/42)',
    );
  });

  it('should name the blocked owner', () => {
    expect(blocklistRejectionReason({ scope: BLOCKLIST_SCOPES.OWNER, key: 'evil-corp', entry: ENTRY })).to.equal(
      'blocklist: owner "evil-corp" is blocked — Impersonates the official Philips Hue integration; the Docker image' +
        ' exfiltrates credentials (see https://github.com/GladysAssistant/integration-store/issues/42)',
    );
  });
});
