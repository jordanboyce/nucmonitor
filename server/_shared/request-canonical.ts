/**
 * Request-identity primitives shared by the gateway and the sub-request
 * admission path: the gateway-only trusted user-id header and the canonical
 * query form a one-use admission is bound to.
 */

/** Gateway-only header naming the authenticated user. Inbound client copies
 *  are stripped at gateway entry; only the gateway may set it. */
export const TRUSTED_USER_ID_HEADER = 'x-user-id';

/**
 * Hex-encoded SHA-256 of a UTF-8 string. Edge-runtime safe (uses WebCrypto).
 * Mirror of `api/_crypto.js::sha256Hex` so server/_shared callers don't
 * need to reach into api/.
 */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Canonical query-string form for binding a request to its exact query.
 *
 * Algorithm (deterministic, AWS SigV4-inspired):
 *   1. Parse the query string (with or without leading "?") via URLSearchParams.
 *   2. Sort entries lexicographically by key (stable: equal keys keep insertion order).
 *   3. URL-encode each key and value with encodeURIComponent.
 *   4. Join as `${key}=${value}` pairs separated by `&`.
 *
 * Empty / missing query → empty string (NOT "?", NOT undefined).
 *
 * Both `?a=1&b=2` and `?b=2&a=1` produce the SAME canonical string —
 * documented and tested behavior. Reordering query params at any hop
 * (CDN, proxy, browser) does not change the binding.
 */
export function canonicalQueryString(searchOrUrl: string | URL): string {
  let search: string;
  if (searchOrUrl instanceof URL) {
    search = searchOrUrl.search;
  } else if (typeof searchOrUrl === 'string') {
    // Accept either "?a=1&b=2" or "a=1&b=2" or a full URL.
    if (searchOrUrl.startsWith('http://') || searchOrUrl.startsWith('https://')) {
      try {
        search = new URL(searchOrUrl).search;
      } catch {
        return '';
      }
    } else {
      search = searchOrUrl;
    }
  } else {
    return '';
  }
  if (!search || search === '?') return '';
  const trimmed = search.startsWith('?') ? search.slice(1) : search;
  if (!trimmed) return '';
  const params = new URLSearchParams(trimmed);
  const entries: [string, string][] = [];
  for (const [k, v] of params) entries.push([k, v]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** Canonical query after the gateway router adds its exact rpc path echo. */
export function canonicalGatewayQueryString(input: URL): string {
  const url = new URL(input);
  const pathSegments = url.pathname.split('/').filter(Boolean);
  const lastSegment = pathSegments[pathSegments.length - 1] ?? '';
  const rpcParams = url.searchParams.getAll('rpc');
  if (rpcParams.some((value) => value === lastSegment)) {
    url.searchParams.delete('rpc');
    for (const value of rpcParams) {
      if (value !== lastSegment) url.searchParams.append('rpc', value);
    }
  }
  return canonicalQueryString(url);
}
