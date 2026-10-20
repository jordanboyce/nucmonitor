import { IS_PARTNER_MODE } from '@/config/access-mode';
import { addPublicSharedRpcMarker } from '@/shared/public-rpc-cache';

const CREDENTIAL_HEADERS = ['Authorization', 'X-WorldMonitor-Key', 'X-Api-Key', 'Cookie'];

/**
 * Fetch one of the explicitly caller-invariant dashboard RPCs through its
 * isolated public CDN cache key. The legacy URL remains session/key gated.
 */
export const publicRpcFetch: typeof fetch = async (input, init) => {
  // Partner deployments serve no anonymous shape: take the ordinary
  // session-carrying path (docs/partner-access.md).
  if (IS_PARTNER_MODE) return globalThis.fetch(input, init);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (method.toUpperCase() !== 'GET') {
    throw new Error('public RPC fetch only supports GET');
  }

  const rawUrl = input instanceof Request ? input.url : String(input);
  const url = addPublicSharedRpcMarker(rawUrl);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  for (const name of CREDENTIAL_HEADERS) headers.delete(name);

  return globalThis.fetch(url, {
    ...init,
    method: 'GET',
    headers,
    credentials: 'omit',
  });
};
