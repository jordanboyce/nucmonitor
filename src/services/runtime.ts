import { SITE_VARIANT } from '@/config/variant';
import { safeStorageGet } from '@/utils/safe-storage';
import { hasExplicitDesktopSignals, isDesktopRuntime } from './desktop-runtime';

// The detector lives in a dependency-free leaf (#5911) so consumers that need
// only the boolean do not pull this module's variant/Clerk graph. Re-exported
// here because every existing caller imports it from `@/services/runtime`.
export { detectDesktopRuntime, isDesktopRuntime, type RuntimeProbe } from './desktop-runtime';

function sleepBeforeRetry(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const ENV = (() => {
  try {
    return {
      VITE_TAURI_API_BASE_URL: import.meta.env.VITE_TAURI_API_BASE_URL,
      VITE_TAURI_REMOTE_API_BASE_URL: import.meta.env.VITE_TAURI_REMOTE_API_BASE_URL,
      VITE_WS_API_URL: import.meta.env.VITE_WS_API_URL,
      VITE_WS_RELAY_URL: import.meta.env.VITE_WS_RELAY_URL,
    };
  } catch {
    return {} as Record<string, string | undefined>;
  }
})();

const WS_API_URL = ENV.VITE_WS_API_URL || '';
const DEFAULT_WEB_API_URL = 'https://api.worldmonitor.app';

const DEFAULT_REMOTE_HOSTS: Record<string, string> = {
  tech: WS_API_URL,
  full: WS_API_URL,
  finance: WS_API_URL,
  world: WS_API_URL,
  happy: WS_API_URL,
};

const DEFAULT_LOCAL_API_PORT = 46123;

let _resolvedPort: number | null = null;
let _portPromise: Promise<number> | null = null;

export async function resolveLocalApiPort(): Promise<number> {
  if (_resolvedPort !== null) return _resolvedPort;
  if (_portPromise) return _portPromise;
  _portPromise = (async () => {
    try {
      const { tryInvokeTauri } = await import('@/services/tauri-bridge');
      const port = await tryInvokeTauri<number>('get_local_api_port');
      if (port && port > 0) {
        _resolvedPort = port;
        return port;
      }
    } catch {
      // IPC failed — allow retry on next call
    } finally {
      _portPromise = null;
    }
    return DEFAULT_LOCAL_API_PORT;
  })();
  return _portPromise;
}

export function getLocalApiPort(): number {
  return _resolvedPort ?? DEFAULT_LOCAL_API_PORT;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

/**
 * Whether /api/ traffic should take the desktop sidecar path.
 *
 * Same predicate as `suppressesRemoteBase`: a bare `https://localhost` origin
 * is not enough. `isDesktopRuntime()` treats that origin as desktop, which
 * would install the sidecar fetch patch and skip the same-origin web path —
 * the exact HTTPS-dev failure `hasExplicitDesktopSignals()` exists to stop.
 */
function routesApiViaDesktop(): boolean {
  return hasExplicitDesktopSignals();
}

export function getApiBaseUrl(): string {
  if (!routesApiViaDesktop()) {
    return '';
  }

  const configuredBaseUrl = ENV.VITE_TAURI_API_BASE_URL;
  if (configuredBaseUrl) {
    return normalizeBaseUrl(configuredBaseUrl);
  }

  return `http://127.0.0.1:${getLocalApiPort()}`;
}

function isWorldMonitorWebHost(hostname: string): boolean {
  return hostname === 'worldmonitor.app'
    || hostname === 'www.worldmonitor.app'
    || hostname.endsWith('.worldmonitor.app');
}

// Loopback page origins the API deliberately refuses in production. Keep in
// step with the bare-localhost entries in api/_cors.js and server/cors.ts.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * A page on loopback may not send /api/ to a remote origin.
 *
 * `api/_cors.js` and `server/cors.ts` both drop bare localhost/127.0.0.1 from
 * the allow-list in production, so every such call returns 403 and the whole
 * dashboard renders unavailable. `VITE_WS_API_URL=https://api.worldmonitor.app`
 * in a developer's .env.local used to do exactly that to `npm run dev`, where
 * the Vite sebuf plugin serves those routes same-origin anyway.
 *
 * Deliberately narrow. The Tauri shell is exempt: its tauri:// and asset://
 * origins are allow-listed by name and it has no same-origin API to fall back
 * to. A loopback base stays honoured, so pointing dev at a local API on another
 * port still works. Deployed and self-hosted pages are untouched — and the
 * self-hosted image proxies /api/ server-side (docker/nginx.conf.template).
 *
 * The exemption tests `hasExplicitDesktopSignals()`, NOT `isDesktopRuntime()`:
 * the latter counts a bare `https://localhost` origin as desktop, so a dev
 * server running over HTTPS would inherit the exemption and keep 403ing —
 * the exact failure this guard exists to stop.
 */
function suppressesRemoteBase(configuredBaseUrl: string): boolean {
  if (typeof window === 'undefined') return false;
  if (hasExplicitDesktopSignals()) return false;
  if (!isLoopbackHostname(window.location?.hostname ?? '')) return false;
  return !isLoopbackHostname(hostnameOf(configuredBaseUrl));
}

export function getConfiguredWebApiBaseUrl(): string {
  if (WS_API_URL) {
    const configured = normalizeBaseUrl(WS_API_URL);
    return suppressesRemoteBase(configured) ? '' : configured;
  }

  if (typeof window === 'undefined') {
    return '';
  }

  if (isDesktopRuntime()) {
    return '';
  }

  const hostname = window.location?.hostname ?? '';
  if (!isWorldMonitorWebHost(hostname)) {
    return '';
  }

  return DEFAULT_WEB_API_URL;
}

export function getCanonicalApiOrigin(): string {
  return getConfiguredWebApiBaseUrl() || DEFAULT_WEB_API_URL;
}

export function getRemoteApiBaseUrl(): string {
  const configuredRemoteBase = ENV.VITE_TAURI_REMOTE_API_BASE_URL;
  if (configuredRemoteBase) {
    return normalizeBaseUrl(configuredRemoteBase);
  }

  const webApiBase = getConfiguredWebApiBaseUrl();
  if (webApiBase) {
    return webApiBase;
  }

  const fromHosts = DEFAULT_REMOTE_HOSTS[SITE_VARIANT] ?? DEFAULT_REMOTE_HOSTS.full ?? '';
  if (fromHosts) return fromHosts;

  // Desktop builds may not set VITE_WS_API_URL; default to production.
  if (isDesktopRuntime()) return 'https://worldmonitor.app';
  return '';
}

export function toRuntimeUrl(path: string): string {
  if (!path.startsWith('/')) {
    return path;
  }

  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    return path;
  }

  return `${baseUrl}${path}`;
}

export function toApiUrl(path: string): string {
  if (!path.startsWith('/')) {
    return path;
  }

  if (routesApiViaDesktop()) {
    return toRuntimeUrl(path);
  }

  const webApiBase = getConfiguredWebApiBaseUrl();
  if (!webApiBase) {
    return path;
  }

  return `${webApiBase}${path}`;
}

function extractHostnames(...urls: (string | undefined)[]): string[] {
  const hosts: string[] = [];
  for (const u of urls) {
    if (!u) continue;
    try { hosts.push(new URL(u).hostname); } catch {}
  }
  return hosts;
}

const APP_HOSTS = new Set([
  'worldmonitor.app',
  'www.worldmonitor.app',
  'tech.worldmonitor.app',
  'api.worldmonitor.app',
  'localhost',
  '127.0.0.1',
  ...extractHostnames(WS_API_URL, ENV.VITE_WS_RELAY_URL),
]);

function isAppOriginUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const host = u.hostname;
    return APP_HOSTS.has(host) || host.endsWith('.worldmonitor.app');
  } catch {
    return false;
  }
}

function getApiTargetFromRequestInput(input: RequestInfo | URL): string | null {
  if (typeof input === 'string') {
    if (input.startsWith('/')) return input;
    if (isAppOriginUrl(input)) {
      const u = new URL(input);
      return `${u.pathname}${u.search}`;
    }
    return null;
  }

  if (input instanceof URL) {
    if (isAppOriginUrl(input.href)) {
      return `${input.pathname}${input.search}`;
    }
    return null;
  }

  if (isAppOriginUrl(input.url)) {
    const u = new URL(input.url);
    return `${u.pathname}${u.search}`;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  startSmartPollLoop,
  VisibilityHub,
} from './smart-poll-loop';
export type {
  SmartPollContext,
  SmartPollLoopHandle,
  SmartPollOptions,
  SmartPollReason,
} from './smart-poll-loop';

export async function waitForSidecarReady(timeoutMs = 3000): Promise<boolean> {
  // Resolve the Tauri-confirmed port first. The main app window otherwise never
  // calls resolveLocalApiPort, so getApiBaseUrl would fall back to the guessed
  // default port and could report not-ready for a sidecar that is actually up
  // on an EADDRINUSE-fallback port — a false alarm now that the caller acts on
  // the result (#6779).
  await resolveLocalApiPort();
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) return false;
  const pollInterval = 200;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Probe the sidecar's own dependency-free liveness endpoint, not the
      // generic /api/service-status page — /api/sidecar-health is served only
      // by the local Node sidecar, so a 200 confirms *this* process is up on
      // the resolved port rather than something else answering on it (#6779).
      const res = await fetch(`${baseUrl}/api/sidecar-health`, { method: 'GET' });
      if (res.ok) return true;
    } catch {
      // sidecar not ready yet
    }
    await sleep(pollInterval);
  }
  return false;
}

function isLocalOnlyApiTarget(target: string): boolean {
  // Security boundary: endpoints that can carry local secrets must use the
  // `/api/local-*` prefix so cloud fallback is automatically blocked.
  return target.startsWith('/api/local-');
}

function isKeyFreeApiTarget(target: string): boolean {
  return target.startsWith('/api/register-interest')
    || target.startsWith('/api/leads/v1/register-interest')
    || target.startsWith('/api/leads/v1/submit-contact')
    || target.startsWith('/api/version');
}

function canRetryRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const request = input instanceof Request ? input : undefined;
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  const signal = init?.signal === undefined ? request?.signal : init.signal;
  return (method === 'GET' || method === 'HEAD') && !signal?.aborted;
}

async function fetchLocalWithStartupRetry(
  target: string,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const maxAttempts = 4;
  let lastError: unknown = null;
  const signal = init?.signal === undefined ? (input instanceof Request ? input.signal : undefined) : init.signal;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const { proxyLocalApiRequest } = await import('@/services/tauri-bridge');
      return await proxyLocalApiRequest(target, input, init);
    } catch (error) {
      lastError = error;

      if (!canRetryRequest(input, init)) {
        throw error;
      }

      if (attempt === maxAttempts) {
        break;
      }

      await sleepBeforeRetry(125 * attempt, signal ?? null);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Local API unavailable');
}

// ── Security threat model for the fetch patch ──────────────────────────
// The native process exclusively owns LOCAL_API_TOKEN. Renderer API calls are
// proxied through a narrow native command that rejects sidecar configuration
// routes, so a compromised page cannot read the token or mutate the secret
// cache through the local HTTP control plane.

export function installRuntimeFetchPatch(): void {
  if (!routesApiViaDesktop() || typeof window === 'undefined' || (window as unknown as Record<string, unknown>).__wmFetchPatched) {
    return;
  }

  const nativeFetch = window.fetch.bind(window);
  const dispatch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = getApiTargetFromRequestInput(input);
    const debug = safeStorageGet('wm-debug-log') === '1';

    if (!target?.startsWith('/api/')) {
      if (debug) {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        console.log(`[fetch] passthrough → ${raw.slice(0, 120)}`);
      }
      return nativeFetch(input, init);
    }

    if (debug) console.log(`[fetch] intercept → ${target}`);
    let allowCloudFallback = !isLocalOnlyApiTarget(target) && canRetryRequest(input, init);

    if (allowCloudFallback && !isKeyFreeApiTarget(target)) {
      try {
        const { getSecretState, secretsReady } = await import('@/services/runtime-config');
        await Promise.race([secretsReady, new Promise<void>(r => setTimeout(r, 2000))]);
        const wmKeyState = getSecretState('WORLDMONITOR_API_KEY');
        if (!wmKeyState.present || !wmKeyState.valid) {
          allowCloudFallback = false;
        }
      } catch {
        allowCloudFallback = false;
      }
    }

    const cloudFallback = async () => {
      if (!allowCloudFallback || !canRetryRequest(input, init)) {
        throw new Error(`Cloud fallback blocked for ${target}`);
      }
      const cloudUrl = `${getRemoteApiBaseUrl()}${target}`;
      if (debug) console.log(`[fetch] cloud fallback → ${cloudUrl}`);
      return nativeFetch(input instanceof Request ? new Request(cloudUrl, input) : cloudUrl, init);
    };

    try {
      const t0 = performance.now();
      const response = await fetchLocalWithStartupRetry(target, input, init);
      if (debug) console.log(`[fetch] ${target} → ${response.status} (${Math.round(performance.now() - t0)}ms)`);

      if (!response.ok) {
        if (!allowCloudFallback) {
          if (debug) console.log(`[fetch] local-only endpoint ${target} returned ${response.status}; skipping cloud fallback`);
          return response;
        }
        if (debug) console.log(`[fetch] local ${response.status}, falling back to cloud`);
        return cloudFallback();
      }
      return response;
    } catch (error) {
      if (debug) console.warn(`[runtime] Local API unavailable for ${target}`, error);
      if (!allowCloudFallback || !canRetryRequest(input, init)) {
        throw error;
      }
      return cloudFallback();
    }
  };
  window.fetch = dispatch;

  (window as unknown as Record<string, unknown>).__wmFetchPatched = true;
}

const ALLOWED_REDIRECT_HOSTS = /^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*worldmonitor\.app(:\d+)?$/;

function isAllowedRedirectTarget(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_REDIRECT_HOSTS.test(parsed.origin) || isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function installWebApiRedirect(): void {
  if (routesApiViaDesktop() || typeof window === 'undefined') return;
  if ((window as unknown as Record<string, unknown>).__wmWebRedirectPatched) return;

  const apiBase = getConfiguredWebApiBaseUrl();
  const hasRedirect = !!apiBase && isAllowedRedirectTarget(apiBase);
  if (apiBase && !hasRedirect) {
    console.warn('[runtime] web API base blocked — not in hostname allowlist:', apiBase);
  }

  const nativeFetch = window.fetch.bind(window);
  const shouldRedirectPath = (pathWithQuery: string): boolean => pathWithQuery.startsWith('/api/');
  const withCredentials = (init?: RequestInit): RequestInit => (
    { ...(init ?? {}), credentials: init?.credentials ?? 'include' }
  );

  if (hasRedirect) {
    const API_BASE = apiBase;
    const shouldFallbackToOrigin = (status: number): boolean => (
      status === 404 || status === 405 || status === 501 || status === 502 || status === 503
    );
    const fetchWithRedirectFallback = async (
      redirectedInput: RequestInfo | URL,
      originalInput: RequestInfo | URL,
      originalInit?: RequestInit,
    ): Promise<Response> => {
      try {
        const redirectedResponse = await nativeFetch(redirectedInput, originalInit);
        if (!canRetryRequest(originalInput, originalInit) || !shouldFallbackToOrigin(redirectedResponse.status)) return redirectedResponse;
        return nativeFetch(originalInput, originalInit);
      } catch (error) {
        if (!canRetryRequest(originalInput, originalInit)) throw error;
        try {
          return await nativeFetch(originalInput, originalInit);
        } catch {
          throw error;
        }
      }
    };

    const dispatch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (typeof input === 'string') {
        if (shouldRedirectPath(input)) {
          // Relative /api/... path — redirect to API base.
          return fetchWithRedirectFallback(`${API_BASE}${input}`, input, withCredentials(init));
        }
        // Generated clients construct an absolute API-base URL, so they cannot
        // rely on the relative-path branch above for origin recovery. Keep the
        // same fallback here: browser extensions and network policy can block
        // api.worldmonitor.app while the page's own /api/ route remains usable.
        if (input.startsWith(`${API_BASE}/api/`)) {
          const pathAndSearch = input.slice(API_BASE.length);
          return fetchWithRedirectFallback(input, pathAndSearch, withCredentials(init));
        }
      }
      if (input instanceof URL) {
        const pathAndSearch = `${input.pathname}${input.search}`;
        if (input.origin === window.location.origin && shouldRedirectPath(pathAndSearch)) {
          return fetchWithRedirectFallback(new URL(`${API_BASE}${pathAndSearch}`), input, withCredentials(init));
        }
        // URL object already targeting the API base.
        if (input.origin === API_BASE && pathAndSearch.startsWith('/api/')) {
          return nativeFetch(input, withCredentials(init));
        }
      }
      if (input instanceof Request) {
        const u = new URL(input.url);
        const pathAndSearch = `${u.pathname}${u.search}`;
        if (u.origin === window.location.origin && shouldRedirectPath(pathAndSearch)) {
          return fetchWithRedirectFallback(
            new Request(`${API_BASE}${pathAndSearch}`, input),
            input.clone(),
            withCredentials(init),
          );
        }
        // Request object already targeting the API base.
        if (u.origin === API_BASE && pathAndSearch.startsWith('/api/')) {
          return nativeFetch(new Request(input, withCredentials(init)));
        }
      }
      return nativeFetch(input, init);
    };
    window.fetch = dispatch;
  } else {
    // No API base redirect — send same-origin API calls with credentials.
    const dispatch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (typeof input === 'string') {
        if (shouldRedirectPath(input)) {
          return nativeFetch(input, withCredentials(init));
        }
        if (input.startsWith(`${DEFAULT_WEB_API_URL}/api/`)) {
          return nativeFetch(input, withCredentials(init));
        }
      }
      if (input instanceof URL) {
        const pathAndSearch = `${input.pathname}${input.search}`;
        if ((input.origin === window.location.origin || input.origin === DEFAULT_WEB_API_URL)
            && (shouldRedirectPath(pathAndSearch) || pathAndSearch.startsWith('/api/'))) {
          return nativeFetch(input, withCredentials(init));
        }
      }
      if (input instanceof Request) {
        const u = new URL(input.url);
        const pathAndSearch = `${u.pathname}${u.search}`;
        if ((u.origin === window.location.origin || u.origin === DEFAULT_WEB_API_URL)
            && (shouldRedirectPath(pathAndSearch) || pathAndSearch.startsWith('/api/'))) {
          return nativeFetch(new Request(input, withCredentials(init)));
        }
      }
      return nativeFetch(input, init);
    };
    window.fetch = dispatch;
  }

  (window as unknown as Record<string, unknown>).__wmWebRedirectPatched = true;
}
