/**
 * Host policy for user-added ("custom") feed URLs.
 *
 * Built-in feeds pass the fixed RSS allowlist in `_rss-allowed-domain-match.js`.
 * Custom feeds are typed in by viewers, so they cannot be listed ahead of time;
 * instead the proxy accepts any public DNS name and refuses anything that names
 * a private, loopback, link-local or metadata target. IP literals are refused
 * outright: a real feed is published under a domain name, and refusing every
 * literal closes the octal/hex/IPv6-mapped spellings of internal addresses
 * without having to parse them.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.internal',
  'instance-data',
  'computemetadata',
  'link-local.s3.amazonaws.com',
]);

// Suffixes reserved for private or local networks (RFC 6761, RFC 6762,
// RFC 8375 and common corporate conventions).
const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.home.arpa',
  '.corp',
  '.private',
  '.test',
  '.invalid',
  '.example',
  '.arpa',
];

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * True when `hostname` is a public DNS name a custom feed may be fetched from.
 * Accepts the `URL#hostname` form (lowercase, IPv6 in brackets).
 */
export function isPublicFeedHostname(hostname) {
  if (typeof hostname !== 'string') return false;
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253) return false;
  // IPv6 literals arrive bracketed; IPv4 literals (and their numeric
  // shorthands such as `2130706433`) end in a digit-only label.
  if (host.includes(':') || host.startsWith('[')) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  if (labels.some((label) => !LABEL.test(label))) return false;
  if (/^\d+$/.test(labels[labels.length - 1])) return false;
  if (BLOCKED_HOSTNAMES.has(host)) return false;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1))) return false;
  return true;
}

/**
 * True when a URL may be fetched as a custom feed: http(s), a public host,
 * the scheme's default port and no embedded credentials.
 */
export function isPublicFeedUrl(url) {
  if (!(url instanceof URL)) return false;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.port !== '' || url.username !== '' || url.password !== '') return false;
  return isPublicFeedHostname(url.hostname);
}

/**
 * True when a response body looks like an RSS, RDF or Atom document.
 *
 * Custom mode turns the proxy into a fetcher for arbitrary public hosts, so it
 * only relays bodies that are feeds. Anything else (HTML pages, JSON APIs,
 * binaries) is refused rather than proxied.
 */
export function looksLikeFeedXml(body) {
  if (typeof body !== 'string') return false;
  // Skip a BOM, the XML declaration, comments, processing instructions and
  // a doctype before the root element.
  // `\s` matches U+FEFF too, so a leading BOM is skipped with whitespace.
  const head = body.slice(0, 4096);
  const rest = head.replace(/^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i, '');
  return /^<(?:rss|feed|rdf:RDF)[\s>/]/i.test(rest);
}
