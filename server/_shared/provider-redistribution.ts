// @ts-expect-error — JS module, no declaration file
import { getHeaderApiKey } from '../../api/_api-key.js';
export {
  hasRedistributableProviderAttribution,
  isOpenSkyProvider,
} from '../../shared/provider-redistribution';

/**
 * True for programmatic API-key calls. Browser sessions use a `wms_` token and
 * remain on the dashboard product path, where providers that are licensed for
 * display can still be used.
 */
export function requiresRedistributableProviders(request: Request | undefined): boolean {
  if (!request) return false;
  const apiKey = getHeaderApiKey(request);
  return apiKey.length > 0 && !apiKey.startsWith('wms_');
}

/**
 * Direct RPC responses are programmatic surfaces even when the caller presents
 * a browser-session token. Anonymous clients can mint and replay `wms_` tokens,
 * so that prefix cannot grant access to display-only provider values.
 */
export function requiresRedistributableProvidersForDirectRpc(
  request: Request | undefined,
): boolean {
  return request !== undefined;
}
