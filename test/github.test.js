import { expect } from 'chai';

import { downloadCover, fetchManifestFile, searchRepositoriesByTopic } from '../src/github.js';

/**
 * Build a GitHub search API repository item.
 * @param {string} owner - Owner login.
 * @param {string} repo - Repository name.
 * @returns {object} Search API item.
 */
function searchItem(owner, repo) {
  return {
    full_name: `${owner}/${repo}`,
    name: repo,
    html_url: `https://github.com/${owner}/${repo}`,
    default_branch: 'main',
    stargazers_count: 12,
    pushed_at: '2026-07-10T12:00:00Z',
    owner: { login: owner, avatar_url: `https://avatars.githubusercontent.com/${owner}` },
  };
}

const silentLogger = { warn: () => {} };

describe('searchRepositoriesByTopic', () => {
  it('should query the topic and map repository metadata', async () => {
    const calls = [];
    const fetchFn = async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ total_count: 1, items: [searchItem('john', 'demo')] }));
    };
    const repositories = await searchRepositoriesByTopic({
      topic: 'gladys-assistant-integration',
      token: 'gh-token',
      fetchFn,
    });
    expect(repositories).to.deep.equal([
      {
        storeSlug: 'john/demo',
        owner: 'john',
        repo: 'demo',
        repoUrl: 'https://github.com/john/demo',
        defaultBranch: 'main',
        stars: 12,
        pushedAt: '2026-07-10T12:00:00Z',
        ownerAvatarUrl: 'https://avatars.githubusercontent.com/john',
      },
    ]);
    expect(calls).to.have.lengthOf(1);
    expect(calls[0].url).to.include(encodeURIComponent('topic:gladys-assistant-integration is:public'));
    expect(calls[0].options.headers.Authorization).to.equal('Bearer gh-token');
  });

  it('should not send an Authorization header without a token', async () => {
    let headers;
    const fetchFn = async (_url, options) => {
      headers = options.headers;
      return new Response(JSON.stringify({ total_count: 0, items: [] }));
    };
    await searchRepositoriesByTopic({ topic: 'x', fetchFn });
    expect(headers).to.not.have.property('Authorization');
  });

  it('should paginate until a page is not full', async () => {
    const pages = [{ items: [searchItem('a', 'r1'), searchItem('b', 'r2')] }, { items: [searchItem('c', 'r3')] }];
    const requestedPages = [];
    const fetchFn = async (url) => {
      requestedPages.push(new URL(url).searchParams.get('page'));
      return new Response(JSON.stringify(pages.shift()));
    };
    const repositories = await searchRepositoriesByTopic({ topic: 'x', fetchFn, perPage: 2 });
    expect(repositories.map((r) => r.storeSlug)).to.deep.equal(['a/r1', 'b/r2', 'c/r3']);
    expect(requestedPages).to.deep.equal(['1', '2']);
  });

  it('should stop and warn when the search API result cap is reached', async () => {
    const warnings = [];
    const fetchFn = async () => new Response(JSON.stringify({ items: [searchItem('a', 'r1'), searchItem('b', 'r2')] }));
    const repositories = await searchRepositoriesByTopic({
      topic: 'x',
      fetchFn,
      perPage: 2,
      maxResults: 2,
      logger: { warn: (message) => warnings.push(message) },
    });
    expect(repositories).to.have.lengthOf(2);
    expect(warnings).to.have.lengthOf(1);
    expect(warnings[0]).to.include('cap reached');
  });

  it('should throw when the search request fails', async () => {
    const fetchFn = async () => new Response('rate limited', { status: 403 });
    try {
      await searchRepositoriesByTopic({ topic: 'x', fetchFn, logger: silentLogger });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.message).to.equal('GitHub repository search failed (HTTP 403)');
    }
  });
});

describe('fetchManifestFile', () => {
  const params = { owner: 'john', repo: 'demo', defaultBranch: 'main' };

  it('should fetch the raw manifest on the default branch', async () => {
    let requestedUrl;
    const fetchFn = async (url) => {
      requestedUrl = url;
      return new Response('{"manifest_version":1}');
    };
    const result = await fetchManifestFile({ ...params, fetchFn });
    expect(result).to.deep.equal({ status: 'ok', raw: '{"manifest_version":1}' });
    expect(requestedUrl).to.equal('https://raw.githubusercontent.com/john/demo/main/gladys-assistant-integration.json');
  });

  it('should report a missing manifest as not_found', async () => {
    const fetchFn = async () => new Response('Not Found', { status: 404 });
    expect(await fetchManifestFile({ ...params, fetchFn })).to.deep.equal({ status: 'not_found' });
  });

  it('should report other HTTP failures as errors', async () => {
    const fetchFn = async () => new Response('oops', { status: 500 });
    expect(await fetchManifestFile({ ...params, fetchFn })).to.deep.equal({
      status: 'error',
      reason: 'download failed (HTTP 500)',
    });
  });

  it('should reject a file too large to be a manifest', async () => {
    const fetchFn = async () => new Response('x'.repeat(101 * 1024));
    expect(await fetchManifestFile({ ...params, fetchFn })).to.deep.equal({
      status: 'error',
      reason: 'file too large (> 100 KB)',
    });
  });
});

describe('downloadCover', () => {
  it('should download the cover bytes', async () => {
    const data = Buffer.from('fake-image-bytes');
    const fetchFn = async () => new Response(data);
    const result = await downloadCover({ url: 'https://example.com/cover.jpg', fetchFn });
    expect(result.status).to.equal('ok');
    expect(result.data.equals(data)).to.equal(true);
  });

  it('should report HTTP failures', async () => {
    const fetchFn = async () => new Response('Not Found', { status: 404 });
    expect(await downloadCover({ url: 'https://example.com/cover.jpg', fetchFn })).to.deep.equal({
      status: 'error',
      reason: 'download failed (HTTP 404)',
    });
  });

  it('should report network failures', async () => {
    const fetchFn = async () => {
      throw new Error('getaddrinfo ENOTFOUND example.com');
    };
    expect(await downloadCover({ url: 'https://example.com/cover.jpg', fetchFn })).to.deep.equal({
      status: 'error',
      reason: 'download failed (getaddrinfo ENOTFOUND example.com)',
    });
  });

  it('should stop reading past the download cap', async () => {
    const fetchFn = async () => new Response(Buffer.alloc(2 * 1024 * 1024));
    expect(await downloadCover({ url: 'https://example.com/huge.jpg', fetchFn })).to.deep.equal({
      status: 'error',
      reason: 'expected ≤ 150 KB, got more than 1024 KB',
    });
  });
});
