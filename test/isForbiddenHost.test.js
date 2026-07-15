import { expect } from 'chai';

import { isForbiddenHost } from '../src/isForbiddenHost.js';

describe('isForbiddenHost', () => {
  const forbidden = [
    'localhost',
    'LOCALHOST',
    'foo.localhost',
    '127.0.0.1',
    '127.255.255.255',
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '100.127.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.10',
    '[::1]',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:192.168.0.1',
  ];

  const allowed = [
    'example.com',
    'raw.githubusercontent.com',
    '8.8.8.8',
    '100.63.0.1',
    '100.128.0.1',
    '172.15.0.1',
    '172.32.0.1',
    '192.167.0.1',
    '169.253.0.1',
    '2606:4700::6810:84e5',
    '::ffff:8.8.8.8',
    '999.1.1.1', // not a valid IPv4 literal → treated as a DNS name
  ];

  forbidden.forEach((host) => {
    it(`should forbid ${host}`, () => {
      expect(isForbiddenHost(host)).to.equal(true);
    });
  });

  allowed.forEach((host) => {
    it(`should allow ${host}`, () => {
      expect(isForbiddenHost(host)).to.equal(false);
    });
  });
});
