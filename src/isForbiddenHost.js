/**
 * Parse a dotted-quad IPv4 literal.
 * @param {string} hostname - Candidate hostname.
 * @returns {number[]|null} The four octets, or null if not an IPv4 literal.
 */
function parseIpv4(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (match === null) {
    return null;
  }
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/**
 * Tell whether a hostname points to a private, loopback, link-local or
 * otherwise reserved destination the indexer must never fetch (SSRF guard for
 * attacker-controlled cover URLs). Only literal IPs and localhost are checked:
 * the indexer runs on a public CI runner and sends no credentials, so DNS
 * resolution checks (rebinding, etc.) are deliberately out of scope in v1.
 * @param {string} hostname - Hostname from a parsed URL (IPv6 may keep its brackets).
 * @returns {boolean} True when the host must not be fetched.
 */
export function isForbiddenHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  if (host.includes(':')) {
    if (host === '::' || host === '::1') {
      return true;
    }
    if (/^f[cd]/.test(host)) {
      // fc00::/7 unique local
      return true;
    }
    if (/^fe[89ab]/.test(host)) {
      // fe80::/10 link-local
      return true;
    }
    if (host.startsWith('::ffff:')) {
      // IPv4-mapped IPv6
      return isForbiddenHost(host.slice('::ffff:'.length));
    }
    return false;
  }
  const ip = parseIpv4(host);
  if (ip === null) {
    return false;
  }
  const [a, b] = ip;
  return (
    a === 0 || // "this network"
    a === 10 || // 10.0.0.0/8
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata endpoints
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) // 192.168.0.0/16
  );
}
