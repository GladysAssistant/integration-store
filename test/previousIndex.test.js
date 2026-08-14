import { expect } from 'chai';

import { fetchPreviousIndex } from '../src/previousIndex.js';

const STORE_BASE_URL = 'https://gladysassistant.github.io/integration-store';

describe('fetchPreviousIndex', () => {
  it('should fetch and return the previously published index', async () => {
    const previousIndex = {
      index_format: 1,
      generated_at: '2026-07-13T07:00:00.000Z',
      integrations: [{ store_slug: 'john/demo', first_seen_at: '2026-07-01T00:00:00.000Z' }],
    };
    const calls = [];
    const fetchFn = async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(previousIndex));
    };
    const index = await fetchPreviousIndex({ storeBaseUrl: STORE_BASE_URL, fetchFn });
    expect(index).to.deep.equal(previousIndex);
    expect(calls).to.have.lengthOf(1);
    expect(calls[0].url).to.equal(`${STORE_BASE_URL}/index.json`);
    expect(calls[0].options.signal).to.be.an.instanceOf(AbortSignal);
  });

  it('should return null when no index is published yet (first crawl of a fresh store)', async () => {
    const fetchFn = async () => new Response('not found', { status: 404 });
    expect(await fetchPreviousIndex({ storeBaseUrl: STORE_BASE_URL, fetchFn })).to.equal(null);
  });

  it('should throw on any other HTTP failure: a transient error must not re-seed every first_seen_at', async () => {
    const fetchFn = async () => new Response('oops', { status: 503 });
    try {
      await fetchPreviousIndex({ storeBaseUrl: STORE_BASE_URL, fetchFn });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.message).to.equal('previous index download failed (HTTP 503): refusing to rebuild without it');
    }
  });

  it('should throw when the previous index is not valid JSON', async () => {
    const fetchFn = async () => new Response('<!DOCTYPE html>');
    try {
      await fetchPreviousIndex({ storeBaseUrl: STORE_BASE_URL, fetchFn });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.message).to.equal('previous index is not valid JSON: refusing to rebuild without it');
    }
  });

  it('should throw when the previous index has an unexpected shape', async () => {
    for (const body of ['null', '"index"', '{"integrations": {}}', '{}']) {
      const fetchFn = async () => new Response(body);
      try {
        await fetchPreviousIndex({ storeBaseUrl: STORE_BASE_URL, fetchFn });
        expect.fail('should have thrown');
      } catch (e) {
        expect(e.message).to.equal('previous index has an unexpected shape: refusing to rebuild without it');
      }
    }
  });
});
