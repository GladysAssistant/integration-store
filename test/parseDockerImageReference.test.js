import { expect } from 'chai';

import { isValidDockerImageReference, parseDockerImageReference } from '../src/parseDockerImageReference.js';

describe('parseDockerImageReference', () => {
  it('should parse a registry + name + tag reference', () => {
    expect(parseDockerImageReference('ghcr.io/john/gladys-open-meteo-demo:1.2.0')).to.deep.equal({
      name: 'ghcr.io/john/gladys-open-meteo-demo',
      tag: '1.2.0',
      digest: null,
    });
  });

  it('should parse a digest reference', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(parseDockerImageReference(`ghcr.io/john/demo@${digest}`)).to.deep.equal({
      name: 'ghcr.io/john/demo',
      tag: null,
      digest,
    });
  });

  it('should parse a tag + digest reference', () => {
    const digest = `sha256:${'0'.repeat(64)}`;
    expect(parseDockerImageReference(`docker.io/library/nginx:1.27@${digest}`)).to.deep.equal({
      name: 'docker.io/library/nginx',
      tag: '1.27',
      digest,
    });
  });

  it('should parse a registry with a port', () => {
    expect(parseDockerImageReference('registry.example.com:5000/team/app:v1')).to.deep.equal({
      name: 'registry.example.com:5000/team/app',
      tag: 'v1',
      digest: null,
    });
  });

  it('should parse a short official-image style reference', () => {
    expect(parseDockerImageReference('nginx:latest')).to.deep.equal({ name: 'nginx', tag: 'latest', digest: null });
  });

  it('should return null on a non-string input', () => {
    expect(parseDockerImageReference(42)).to.equal(null);
    expect(parseDockerImageReference(undefined)).to.equal(null);
  });

  it('should return null on malformed references', () => {
    expect(parseDockerImageReference('')).to.equal(null);
    expect(parseDockerImageReference('ghcr.io/John/demo:1.0.0')).to.equal(null); // uppercase in path
    expect(parseDockerImageReference('ghcr.io/john/demo:')).to.equal(null); // empty tag
    expect(parseDockerImageReference('ghcr.io/john/demo:tag with space')).to.equal(null);
    expect(parseDockerImageReference('ghcr.io/john/demo@sha256:xyz')).to.equal(null); // bad digest hex
    expect(parseDockerImageReference(`ghcr.io/john/demo:${'t'.repeat(129)}`)).to.equal(null); // tag too long
  });

  it('should return null when the name exceeds 255 characters', () => {
    const longName = `ghcr.io/${'a'.repeat(250)}/demo`;
    expect(parseDockerImageReference(`${longName}:1.0.0`)).to.equal(null);
  });
});

describe('isValidDockerImageReference', () => {
  it('should accept a reference with an explicit tag', () => {
    expect(isValidDockerImageReference('ghcr.io/john/demo:1.2.0')).to.equal(true);
  });

  it('should accept a reference with a digest', () => {
    expect(isValidDockerImageReference(`ghcr.io/john/demo@sha256:${'b'.repeat(64)}`)).to.equal(true);
  });

  it('should reject a reference without tag nor digest', () => {
    expect(isValidDockerImageReference('ghcr.io/john/demo')).to.equal(false);
  });

  it('should reject a malformed reference', () => {
    expect(isValidDockerImageReference('not a reference')).to.equal(false);
  });
});
