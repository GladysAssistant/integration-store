import { expect } from 'chai';

import { checkDockerImage } from '../src/checkDockerImage.js';

/**
 * Fake fetch returning canned responses in order, recording every call.
 * @param {...(Response|Error)} responses - Responses to return (an Error is thrown).
 * @returns {{fetchFn: Function, calls: {url: string, options: object}[]}} Fake fetch and recorded calls.
 */
function fakeFetch(...responses) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    const response = responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    return response;
  };
  return { fetchFn, calls };
}

/**
 * Build a 401 response carrying a WWW-Authenticate challenge.
 * @param {string} challenge - Header value.
 * @returns {Response} Response.
 */
function unauthorized(challenge) {
  return new Response(null, { status: 401, headers: { 'www-authenticate': challenge } });
}

const HUB_CHALLENGE = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"';

describe('checkDockerImage', () => {
  it('should confirm an image served without authentication', async () => {
    const { fetchFn, calls } = fakeFetch(new Response(null, { status: 200 }));
    const result = await checkDockerImage({ reference: 'ghcr.io/john/demo:1.2.0', fetchFn });
    expect(result).to.deep.equal({ status: 'ok' });
    expect(calls).to.have.lengthOf(1);
    expect(calls[0].url).to.equal('https://ghcr.io/v2/john/demo/manifests/1.2.0');
    expect(calls[0].options.method).to.equal('HEAD');
    expect(calls[0].options.headers.Accept).to.include('application/vnd.oci.image.index.v1+json');
    expect(calls[0].options.headers).to.not.have.property('Authorization');
    expect(calls[0].options.signal).to.be.instanceOf(AbortSignal);
  });

  it('should fetch an anonymous token when the registry sends a Bearer challenge', async () => {
    const { fetchFn, calls } = fakeFetch(
      unauthorized(HUB_CHALLENGE),
      new Response(JSON.stringify({ token: 'anon-token' })),
      new Response(null, { status: 200 }),
    );
    const result = await checkDockerImage({ reference: 'john/demo:1.2.0', fetchFn });
    expect(result).to.deep.equal({ status: 'ok' });
    expect(calls).to.have.lengthOf(3);
    expect(calls[0].url).to.equal('https://registry-1.docker.io/v2/john/demo/manifests/1.2.0');
    const tokenUrl = new URL(calls[1].url);
    expect(tokenUrl.origin + tokenUrl.pathname).to.equal('https://auth.docker.io/token');
    expect(tokenUrl.searchParams.get('service')).to.equal('registry.docker.io');
    expect(tokenUrl.searchParams.get('scope')).to.equal('repository:john/demo:pull');
    expect(calls[2].url).to.equal(calls[0].url);
    expect(calls[2].options.headers.Authorization).to.equal('Bearer anon-token');
  });

  it('should accept a token under the OAuth2 access_token key and a challenge without service', async () => {
    const { fetchFn, calls } = fakeFetch(
      unauthorized('Bearer realm="https://example.com/token"'),
      new Response(JSON.stringify({ access_token: 'oauth-token' })),
      new Response(null, { status: 200 }),
    );
    const result = await checkDockerImage({ reference: 'example.com/john/demo:1.2.0', fetchFn });
    expect(result).to.deep.equal({ status: 'ok' });
    expect(new URL(calls[1].url).searchParams.has('service')).to.equal(false);
    expect(calls[2].options.headers.Authorization).to.equal('Bearer oauth-token');
  });

  it('should prefix official Docker Hub images with library/', async () => {
    const { fetchFn, calls } = fakeFetch(new Response(null, { status: 200 }));
    await checkDockerImage({ reference: 'redis:7', fetchFn });
    expect(calls[0].url).to.equal('https://registry-1.docker.io/v2/library/redis/manifests/7');
  });

  it('should resolve docker.io aliases to the real Docker Hub API host', async () => {
    const { fetchFn, calls } = fakeFetch(new Response(null, { status: 200 }));
    await checkDockerImage({ reference: 'docker.io/redis:7', fetchFn });
    expect(calls[0].url).to.equal('https://registry-1.docker.io/v2/library/redis/manifests/7');
  });

  it('should keep the namespace of a docker.io image untouched', async () => {
    const { fetchFn, calls } = fakeFetch(new Response(null, { status: 200 }));
    await checkDockerImage({ reference: 'index.docker.io/john/demo:7', fetchFn });
    expect(calls[0].url).to.equal('https://registry-1.docker.io/v2/john/demo/manifests/7');
  });

  it('should query a registry on a custom port', async () => {
    const { fetchFn, calls } = fakeFetch(new Response(null, { status: 200 }));
    const result = await checkDockerImage({ reference: 'registry.example.com:5000/john/demo:1.0.0', fetchFn });
    expect(result).to.deep.equal({ status: 'ok' });
    expect(calls[0].url).to.equal('https://registry.example.com:5000/v2/john/demo/manifests/1.0.0');
  });

  it('should check a digest reference, which wins over a tag', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const { fetchFn, calls } = fakeFetch(new Response(null, { status: 200 }));
    await checkDockerImage({ reference: `ghcr.io/john/demo:1.2.0@${digest}`, fetchFn });
    expect(calls[0].url).to.equal(`https://ghcr.io/v2/john/demo/manifests/${digest}`);
  });

  it('should reject an image the registry does not know', async () => {
    const { fetchFn } = fakeFetch(new Response(null, { status: 404 }));
    const result = await checkDockerImage({ reference: 'ghcr.io/john/gone:1.0.0', fetchFn });
    expect(result).to.deep.equal({ status: 'error', reason: 'image not found on registry "ghcr.io" (HTTP 404)' });
  });

  it('should reject an image that stays denied after the anonymous token', async () => {
    const { fetchFn } = fakeFetch(
      unauthorized(HUB_CHALLENGE),
      new Response(JSON.stringify({ token: 'anon-token' })),
      new Response(null, { status: 403 }),
    );
    const result = await checkDockerImage({ reference: 'john/private:1.0.0', fetchFn });
    expect(result).to.deep.equal({ status: 'error', reason: 'image is not publicly pullable (HTTP 403)' });
  });

  it('should reject an image whose registry denies the anonymous token', async () => {
    const { fetchFn } = fakeFetch(unauthorized(HUB_CHALLENGE), new Response(null, { status: 401 }));
    const result = await checkDockerImage({ reference: 'john/private:1.0.0', fetchFn });
    expect(result).to.deep.equal({
      status: 'error',
      reason: 'image is not publicly pullable (registry auth denied, HTTP 401)',
    });
  });

  it('should reject an image behind a non-Bearer authentication scheme', async () => {
    const { fetchFn } = fakeFetch(unauthorized('Basic realm="corp registry"'));
    const result = await checkDockerImage({ reference: 'registry.example.com/john/demo:1.0.0', fetchFn });
    expect(result).to.deep.equal({
      status: 'error',
      reason: 'image is not publicly pullable (registry requires credentials)',
    });
  });

  it('should reject a 401 without any WWW-Authenticate challenge', async () => {
    const { fetchFn } = fakeFetch(new Response(null, { status: 401 }));
    const result = await checkDockerImage({ reference: 'registry.example.com/john/demo:1.0.0', fetchFn });
    expect(result).to.deep.equal({
      status: 'error',
      reason: 'image is not publicly pullable (registry requires credentials)',
    });
  });

  it('should reject a Bearer challenge without realm', async () => {
    const { fetchFn } = fakeFetch(unauthorized('Bearer service="x"'));
    const result = await checkDockerImage({ reference: 'registry.example.com/john/demo:1.0.0', fetchFn });
    expect(result).to.deep.equal({
      status: 'error',
      reason: 'image is not publicly pullable (registry requires credentials)',
    });
  });

  it('should reject an auth realm that is not a valid URL', async () => {
    const { fetchFn } = fakeFetch(unauthorized('Bearer realm="not a url"'));
    const result = await checkDockerImage({ reference: 'registry.example.com/john/demo:1.0.0', fetchFn });
    expect(result).to.deep.equal({ status: 'error', reason: 'registry sent an invalid auth realm' });
  });

  it('should reject an auth realm that is not public https', async () => {
    const { fetchFn } = fakeFetch(unauthorized('Bearer realm="http://169.254.169.254/token"'));
    const result = await checkDockerImage({ reference: 'registry.example.com/john/demo:1.0.0', fetchFn });
    expect(result).to.deep.equal({ status: 'error', reason: 'registry auth realm is not a public https URL' });
  });

  it('should reject a private or reserved registry host', async () => {
    const { fetchFn, calls } = fakeFetch();
    const result = await checkDockerImage({ reference: 'localhost:5000/john/demo:1.0.0', fetchFn });
    expect(result).to.deep.equal({ status: 'error', reason: 'forbidden registry host (private or reserved address)' });
    expect(calls).to.deep.equal([]);
  });

  it('should reject a malformed reference or one without explicit tag or digest', async () => {
    const { fetchFn } = fakeFetch();
    expect(await checkDockerImage({ reference: 'ghcr.io/john/demo', fetchFn })).to.deep.equal({
      status: 'error',
      reason: 'malformed image reference',
    });
    expect(await checkDockerImage({ reference: '///', fetchFn })).to.deep.equal({
      status: 'error',
      reason: 'malformed image reference',
    });
  });

  it('should leave an integration unverified on an anonymous 403 without auth challenge', async () => {
    // Without the token flow a 403 can come from a middlebox (proxy, WAF...),
    // not from the registry: never a definitive rejection.
    const { fetchFn } = fakeFetch(new Response(null, { status: 403 }));
    const result = await checkDockerImage({ reference: 'quay.io/john/demo:1.0.0', fetchFn });
    expect(result).to.deep.equal({ status: 'unverified', reason: 'registry check failed (HTTP 403)' });
  });

  it('should leave an integration unverified when the registry fails transiently', async () => {
    const { fetchFn } = fakeFetch(new Response(null, { status: 503 }));
    const result = await checkDockerImage({ reference: 'ghcr.io/john/demo:1.0.0', fetchFn });
    expect(result).to.deep.equal({ status: 'unverified', reason: 'registry check failed (HTTP 503)' });
  });

  it('should leave an integration unverified when the token endpoint fails transiently', async () => {
    const { fetchFn } = fakeFetch(unauthorized(HUB_CHALLENGE), new Response(null, { status: 500 }));
    const result = await checkDockerImage({ reference: 'john/demo:1.0.0', fetchFn });
    expect(result).to.deep.equal({ status: 'unverified', reason: 'registry token request failed (HTTP 500)' });
  });

  it('should leave an integration unverified when the token response has no token', async () => {
    const { fetchFn } = fakeFetch(unauthorized(HUB_CHALLENGE), new Response(JSON.stringify({})));
    const result = await checkDockerImage({ reference: 'john/demo:1.0.0', fetchFn });
    expect(result).to.deep.equal({ status: 'unverified', reason: 'registry token response has no token' });
  });

  it('should leave an integration unverified when the registry is unreachable', async () => {
    const { fetchFn } = fakeFetch(new Error('getaddrinfo ENOTFOUND ghcr.io'));
    const result = await checkDockerImage({ reference: 'ghcr.io/john/demo:1.0.0', fetchFn });
    expect(result).to.deep.equal({
      status: 'unverified',
      reason: 'registry check failed (getaddrinfo ENOTFOUND ghcr.io)',
    });
  });
});
