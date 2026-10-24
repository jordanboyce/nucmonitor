import { consumeSubRequestAdmission } from './_shared/sub-request-admission';
/**
 * Shared gateway logic for per-domain Vercel edge functions.
 *
 * Each domain edge function calls `createDomainGateway(routes)` to get a
 * request handler that applies CORS, API-key validation, rate limiting,
 * POST-to-GET compat, error boundary, and cache-tier headers.
 *
 * Splitting domains into separate edge functions means Vercel bundles only the
 * code for one domain per function, cutting cold-start cost by ~20×.
 */

import { createRouter, toHeadResponse, type RouteDescriptor } from './router';
import { getCorsHeaders, getOriginDeniedCorsHeaders, isDisallowedOrigin, isAllowedOrigin } from './cors';
import { isPublicSharedRpcRequest } from '../src/shared/public-rpc-cache';
// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from '../api/_api-key.js';
import { getBearerToken, isPartnerMode, verifyPartnerRequest } from '../api/_partner-access.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../api/_sentry-edge.js';
import { mapErrorToResponse } from './error-mapper';
import {
  checkRateLimit,
  checkEndpointRateLimit,
  formatTrustedRateLimitPrincipal,
  hasEndpointRatePolicy,
  RATE_LIMIT_DEGRADED_HEADERS,
  TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER,
} from './_shared/rate-limit';
import {
  drainResponseHeaders,
  drainRetryableResponse,
  drainSuccessStatusOverride,
  drainUnservedLlmResponse,
} from './_shared/response-headers';
import {
  appendDeprecationPolicyLink,
  appendDeprecationPolicyLinkToRecord,
  DEPRECATION_POLICY_LINK,
} from './_shared/deprecation-policy';
import {
  REST_ATTRIBUTION_EXPRESSIONS,
  buildAttributionRider,
  mergeAttributionRider,
} from '../shared/attribution-rider';
import {
  enforceRestProjectionOutputLimit,
  projectJsonResponse,
} from './_shared/response-projection';
import { getRpcNoStoreReasonFromJson } from './_shared/cache-contract';
import { TRUSTED_USER_ID_HEADER } from './_shared/request-canonical';
import { buildUsageIdentity, hashKeySync, type UsageIdentityInput } from './_shared/usage-identity';
import { runRedisPipeline } from './_shared/redis';
import {
  beginIdempotency,
  peekIdempotency,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_EXEMPT_RPC_PATHS,
  IDEMPOTENT_REPLAYED_HEADER,
  type IdempotencyOutcome,
} from './_shared/idempotency';
import {
  checkBurst,
  reserveDailyMeter,
  rateLimitHeaders,
  ENTERPRISE_API_RATE_LIMIT,
} from './_shared/api-key-rate-limit';
import {
  DIRECT_LLM_DAILY_QUOTA_LIMIT,
  DIRECT_LLM_GATEWAY_QUOTA_PATHS,
  reserveDirectLlmQuota,
} from './_shared/direct-llm-quota';
import {
  OPERATOR_KEY_DAILY_CEILINGS,
  operatorKeyQuotaPrincipal,
  reportHighUsageIfCrossed,
} from './_shared/high-usage-alarm';
import {
  deliverUsageEvents,
  buildRequestEvent,
  deriveRequestId,
  deriveExecutionRegion,
  deriveCountry,
  deriveIpCity,
  deriveIpRegion,
  deriveReqBytes,
  deriveSentryTraceId,
  deriveOriginKind,
  deriveUaHash,
  deriveIp,
  deriveUserAgent,
  deriveReferer,
  deriveAcceptLanguage,
  deriveHost,
  maybeAttachDevHealthHeader,
  runWithUsageScope,
  type CacheTier as UsageCacheTier,
  type RequestReason,
} from './_shared/usage';
import { timingSafeEqual } from './_shared/internal-auth';
import { getClientIp, rateLimitKeyForIp } from './_shared/client-ip';
import type { ServerOptions } from '../src/generated/server/worldmonitor/seismology/v1/service_server';
import { validateGeneratedRequest } from './request-validator';
import {
  buildMarkdownTwinResponse,
  isMarkdownTwinPath,
} from '../api/_md-url-twin';

export const serverOptions: ServerOptions = {
  onError: mapErrorToResponse,
  validateRequest: validateGeneratedRequest,
};

function getRateLimitTelemetryReason(
  response: Response,
  rejectedReason: RequestReason,
): RequestReason {
  return response.status === 503 &&
    response.headers.get('X-RateLimit-Mode') === 'degraded'
    ? 'rate_limit_degraded'
    : rejectedReason;
}


// --- Edge cache tier definitions ---
// NOTE: This map is shared across all domain bundles (~3KB). Kept centralised for
// single-source-of-truth maintainability; the size is negligible vs handler code.

type CacheTier = 'fast' | 'medium' | 'slow' | 'slow-browser' | 'live-browser' | 'static' | 'daily' | 'no-store' | 'live';

// Three-tier caching: browser (max-age) → CF edge (s-maxage) → Vercel CDN (CDN-Cache-Control).
// CF ignores Vary: Origin so it may pin a single ACAO value, but this is acceptable
// since production traffic is same-origin and preview deployments hit Vercel CDN directly.
//
// 'live' tier (60s) is for endpoints with strict freshness contracts — the
// energy-atlas live-tanker map layer requires position fixes to refresh on
// the order of one minute. Every shorter-than-medium tier is custom; we keep
// the existing tiers untouched so unrelated endpoints aren't impacted.
const TIER_HEADERS: Record<CacheTier, string> = {
  fast: 'public, max-age=60, s-maxage=300, stale-while-revalidate=60, stale-if-error=600',
  medium: 'public, max-age=120, s-maxage=600, stale-while-revalidate=120, stale-if-error=900',
  slow: 'public, max-age=300, s-maxage=1800, stale-while-revalidate=300, stale-if-error=3600',
  'slow-browser': 'max-age=300, stale-while-revalidate=60, stale-if-error=1800',
  'live-browser': 'private, max-age=30, stale-while-revalidate=60, stale-if-error=300',
  static: 'public, max-age=600, s-maxage=3600, stale-while-revalidate=600, stale-if-error=14400',
  daily: 'public, max-age=3600, s-maxage=14400, stale-while-revalidate=7200, stale-if-error=172800',
  'no-store': 'no-store',
  live: 'public, max-age=30, s-maxage=60, stale-while-revalidate=60, stale-if-error=300',
};

// Vercel CDN-specific cache TTLs — CDN-Cache-Control overrides Cache-Control for
// Vercel's own edge cache, so Vercel can still cache aggressively (and respects
// Vary: Origin correctly) while CF sees no public s-maxage and passes through.
const TIER_CDN_CACHE: Record<CacheTier, string | null> = {
  fast: 'public, s-maxage=600, stale-while-revalidate=300, stale-if-error=1200',
  medium: 'public, s-maxage=1200, stale-while-revalidate=600, stale-if-error=1800',
  slow: 'public, s-maxage=3600, stale-while-revalidate=900, stale-if-error=7200',
  'slow-browser': 'public, s-maxage=900, stale-while-revalidate=60, stale-if-error=1800',
  'live-browser': null,
  static: 'public, s-maxage=14400, stale-while-revalidate=3600, stale-if-error=28800',
  daily: 'public, s-maxage=86400, stale-while-revalidate=14400, stale-if-error=172800',
  'no-store': null,
  live: 'public, s-maxage=60, stale-while-revalidate=60, stale-if-error=300',
};

const RPC_CACHE_TIER: Record<string, CacheTier> = {
  // 'live' tier — bbox-quantized + tanker-aware caching upstream of the
  // 60s in-handler cache, absorbing identical-bbox requests at the CDN
  // before they hit this Vercel function. Energy Atlas live-tanker layer.

  '/api/market/v1/list-market-quotes': 'medium',
  '/api/market/v1/list-crypto-quotes': 'medium',
  '/api/market/v1/list-crypto-sectors': 'slow',
  '/api/market/v1/list-defi-tokens': 'slow',
  '/api/market/v1/list-ai-tokens': 'slow',
  '/api/market/v1/list-other-tokens': 'slow',
  '/api/market/v1/list-commodity-quotes': 'medium',
  '/api/market/v1/get-physical-premiums': 'no-store',
  '/api/market/v1/get-physical-divergence-index': 'no-store',
  '/api/market/v1/list-stablecoin-markets': 'medium',
  '/api/market/v1/get-sector-summary': 'medium',
  '/api/market/v1/get-fear-greed-index': 'slow',
  '/api/market/v1/get-market-breadth-history': 'daily',
  '/api/market/v1/list-gulf-quotes': 'medium',
  '/api/market/v1/analyze-stock': 'slow',
  '/api/market/v1/get-stock-analysis-history': 'medium',
  '/api/market/v1/backtest-stock': 'slow',
  '/api/market/v1/list-stored-stock-backtests': 'medium',
  '/api/infrastructure/v1/list-service-statuses': 'slow',
  '/api/seismology/v1/list-earthquakes': 'fast',
  '/api/infrastructure/v1/list-internet-outages': 'slow',
  '/api/infrastructure/v1/list-internet-ddos-attacks': 'slow',
  '/api/infrastructure/v1/list-internet-traffic-anomalies': 'slow',

  '/api/infrastructure/v1/get-temporal-baseline': 'slow',
  '/api/market/v1/get-country-stock-index': 'slow',
  '/api/market/v1/get-price-history': 'static',

  '/api/natural/v1/list-natural-events': 'slow',
  '/api/wildfire/v1/list-fire-detections': 'static',
  '/api/economic/v1/get-fred-series': 'static',
  '/api/economic/v1/get-bls-series': 'daily',
  '/api/economic/v1/get-energy-prices': 'static',
  // The canonical Railway projection refreshes every 15 minutes. Keep the
  // public composition route's Vercel TTL (10m on fast) inside that cadence so
  // the seeder cannot keep re-publishing a two-hour-old medium-tier response.
  '/api/climate/v1/list-climate-anomalies': 'daily',
  '/api/climate/v1/list-climate-disasters': 'daily',
  '/api/climate/v1/get-co2-monitoring': 'daily',
  '/api/climate/v1/get-ocean-ice-data': 'daily',
  '/api/climate/v1/list-air-quality-data': 'fast',
  '/api/climate/v1/list-climate-news': 'slow',
  '/api/radiation/v1/list-radiation-observations': 'slow',
  '/api/economic/v1/get-bis-policy-rates': 'daily',
  '/api/economic/v1/get-bis-exchange-rates': 'daily',
  '/api/economic/v1/get-bis-credit': 'daily',
  '/api/economic/v1/list-world-bank-indicators': 'daily',
  '/api/economic/v1/get-energy-capacity': 'daily',
  '/api/economic/v1/list-grocery-basket-prices': 'daily',
  '/api/economic/v1/list-bigmac-prices': 'daily',
  '/api/economic/v1/list-fuel-prices': 'daily',
  '/api/economic/v1/get-fao-food-price-index': 'daily',
  '/api/economic/v1/get-crude-inventories': 'daily',
  '/api/economic/v1/get-nat-gas-storage': 'daily',
  '/api/economic/v1/get-eu-yield-curve': 'daily',
  // Daily macro seed. A miss returns unavailable:true, which the gateway
  // already keeps out of the shared cache.
  '/api/economic/v1/get-us-cpi-monthly': 'daily',
  '/api/economic/v1/get-us-treasury-par-yield-curve': 'daily',
  '/api/economic/v1/get-us-interest-rates': 'daily',
  '/api/economic/v1/get-world-cpi-monthly': 'daily',
  // Daily yield-curve bundle. A miss returns unavailable:true, which the
  // gateway already keeps out of the shared cache.
  '/api/economic/v1/get-government-yield-curve': 'daily',

  '/api/market/v1/list-etf-flows': 'slow',
  '/api/infrastructure/v1/get-cable-health': 'slow',

  '/api/economic/v1/get-macro-signals': 'medium',
  '/api/economic/v1/get-national-debt': 'daily',
  // Fast, not slow: the digest is rebuilt into Redis every 15 min, and a CDN
  // holding one body for an hour made the CDN the freshness floor.
  '/api/news/v1/list-feed-digest': 'fast',
  '/api/news/v1/list-country-headlines': 'fast',
  '/api/news/v1/list-label-changes': 'fast',
  // #9093 operator queue: never cached, it is gated by a secret header.
  '/api/news/v1/list-error-reports': 'no-store',
  // #9094: per-claim fact-check lookup; the CDN key includes the claim.
  '/api/news/v1/search-fact-checks': 'slow',
  // /verify claim search over the feed caches; the CDN key includes the claim.
  '/api/news/v1/search-claim-headlines': 'fast',
  '/api/news/v1/summarize-article-cache': 'slow',


  '/api/infrastructure/v1/list-temporal-anomalies': 'medium',
  '/api/infrastructure/v1/get-ip-geo': 'no-store',
  '/api/infrastructure/v1/reverse-geocode': 'slow',
  '/api/infrastructure/v1/get-bootstrap-data': 'no-store',
  '/api/webcam/v1/get-webcam-image': 'no-store',
  '/api/webcam/v1/list-webcams': 'no-store',



  '/api/market/v1/list-earnings-calendar': 'slow',
  '/api/market/v1/get-cot-positioning': 'slow',
  '/api/market/v1/get-gold-intelligence': 'slow',
  '/api/market/v1/get-hyperliquid-flow': 'medium',
  '/api/market/v1/get-insider-transactions': 'slow',
  '/api/economic/v1/get-economic-calendar': 'slow',
  '/api/economic/v1/get-china-macro-snapshot': 'slow',
  '/api/economic/v1/get-china-activity-nowcast': 'medium',
  '/api/economic/v1/get-ecb-fx-rates': 'slow',
  '/api/economic/v1/get-eurostat-country-data': 'slow',
  '/api/economic/v1/get-eu-gas-storage': 'slow',
  '/api/economic/v1/get-oil-stocks-analysis': 'static',
  '/api/economic/v1/get-oil-inventories': 'slow',
  '/api/economic/v1/get-energy-crisis-policies': 'static',
  '/api/economic/v1/list-global-tenders': 'medium',
  '/api/economic/v1/get-eu-fsi': 'slow',
  '/api/economic/v1/get-economic-stress': 'slow',
  // These responses differ by caller redistribution rights. The gateway cache
  // key does not vary on session/API-key audience, so they must never be stored.
  '/api/health/v1/list-disease-outbreaks': 'slow',
  '/api/health/v1/list-air-quality-alerts': 'fast',
  // Historical intelligence memory (#5694) — the timeline is a generated GET
  // and therefore requires an explicit gateway cache tier. The two semantic
  // reads are POSTs and cache successful results inside their handlers.


  // Company Monitoring is account-private and remains unrouted until #6003.
  // Keep every generated read no-store so future activation cannot inherit a
  // shared CDN tier before its account isolation is proven end to end.
};

export const PUBLIC_NO_AUTH_RPC_PATHS = new Set<string>([
  // #9093 "Report an error": readers report without an account by design. The
  // gates are the handler's honeypot and validation, a fail-closed per-IP
  // endpoint limit (server/_shared/rate-limit.ts), and a bounded review queue
  // that refuses rather than evicts. Reports are never applied automatically.
  '/api/news/v1/submit-error-report',
  // #9093 /trust page: public label history and today's counts. Read-only,
  // public coverage metadata; a visitor who lands on /trust directly has no
  // session cookie. Bounded by a per-IP endpoint limit and the 'fast' CDN tier.
  '/api/news/v1/list-label-changes',
  // #9093 operator review. The gate is TRUST_REVIEW_SECRET, checked in the
  // handler (X-Trust-Review-Key, constant-time): unset → every call is 401.
  // A browser session would add nothing an operator secret does not already
  // prove, and the standalone review page has none. Fail-closed per-IP limits
  // bound guessing; list-error-reports is no-store.
  '/api/news/v1/list-error-reports',
  '/api/news/v1/review-error-report',
  // #9094 /verify: published fact-checks for a claim, cited with attribution.
  // Free like /verify (owner decision), which needs no account; bounded by a
  // fail-closed per-IP limit and a day-long per-claim cache of the upstream.
  '/api/news/v1/search-fact-checks',
  // /verify: the fresh headlines that share a claim's words, read from the
  // RSS caches the digest already writes (no publisher fetch). Free like
  // /verify; bounded by a per-IP limit and the 'fast' CDN tier.
  '/api/news/v1/search-claim-headlines',
]);

// Cacheable RPC endpoints the Railway relay periodically warm-pings
// to keep their compute caches hot (so the first real user request isn't a cold
// miss). These require a browser session token or an API key in normal traffic;
// the relay is a trusted internal service with neither, so it authenticates as
// itself via WORLDMONITOR_RELAY_KEY (validated below in isRelayWarmPingRequest).
//
// Least privilege: WORLDMONITOR_RELAY_KEY is a DEDICATED relay↔gateway secret —
// it does NOT need to be (and should not be) a WORLDMONITOR_VALID_KEYS enterprise
// key. It unlocks ONLY a cache-warm on these specific free endpoints — exactly
// what any session holder could already trigger — so the blast radius of the
// secret is a recompute on public data, nothing beyond anonymous-equivalent. Mirrors the retired resilience seed-refresh
// internal-auth path below.
export const RELAY_WARM_PING_PATHS = new Set<string>([
  '/api/infrastructure/v1/list-service-statuses',
  '/api/infrastructure/v1/get-cable-health',
  '/api/infrastructure/v1/list-temporal-anomalies',
  // Classify reads the same public digest a session holder can already trigger
  // so self-host / Railway can send WORLDMONITOR_RELAY_KEY instead of an
  // enterprise key (#7437).
  '/api/news/v1/list-feed-digest',
]);

/**
 * Creates a Vercel Edge handler for a single domain's routes.
 *
 * Applies the full gateway pipeline: origin check → CORS → OPTIONS preflight →
 * API key → rate limit → route match (with POST→GET compat) → execute → cache headers.
 */
export type GatewayCtx = { waitUntil: (p: Promise<unknown>) => void };

const POST_TO_GET_MAX_BODY_BYTES = 1_048_576;
const POST_TO_GET_MAX_ARRAY_VALUES_PER_KEY = 200;

export const REQUIRED_BBOX_QUERY_PARAMS = ['sw_lat', 'sw_lon', 'ne_lat', 'ne_lon'] as const;

// Issue #4595 is scoped to military RPCs whose handlers require bbox.
// Other bbox-capable RPCs support lookup/global modes and must not emit this diagnostic.
export const REQUIRED_BBOX_RPC_PATHS = [
] as const;

const REQUIRED_BBOX_RPC_PATH_SET = new Set<string>(REQUIRED_BBOX_RPC_PATHS);
const MILITARY_BBOX_DIAGNOSTIC_PATH_SET = new Set<string>(REQUIRED_BBOX_RPC_PATHS);

function isPostToGetCompatibleBodySize(headers: Headers): boolean {
  const rawContentLength = headers.get('Content-Length');
  if (rawContentLength === null || !/^\d+$/.test(rawContentLength)) return false;

  const contentLength = Number(rawContentLength);
  return Number.isSafeInteger(contentLength) && contentLength < POST_TO_GET_MAX_BODY_BYTES;
}

type PostToGetScalar = string | number | boolean;

function isPostToGetScalar(value: unknown): value is PostToGetScalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isPostToGetPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type PostToGetCompatField =
  | { kind: 'scalar'; name: string; value: string }
  | { kind: 'array'; name: string; values: string[] };

type PostToGetCompatParse =
  | { status: 'ok'; fields: PostToGetCompatField[] }
  | { status: 'too_large' }
  | { status: 'malformed_json' }
  | { status: 'unsupported_body' }
  | { status: 'unsupported_value'; parameter: string }
  | { status: 'oversized_array'; parameter: string };

/**
 * Decode a legacy POST body into GET query fields.
 *
 * Empty / whitespace-only bodies stay on the silent GET fallback for stale
 * clients that POST with no payload. Any other body is all-or-nothing: a
 * JSON object of scalars and scalar arrays becomes query parameters; mixed
 * or nested values, non-object JSON, and malformed JSON return 400 without
 * applying a partial translation. Compatibility-body errors are only
 * returned when a GET handler exists for the path; unknown routes still
 * 404/405. Body-read failures return 400. The 1 MB byte cap and
 * 200-values-per-key cap from #3550 still bound expansion cost.
 */
function parsePostToGetCompatBody(bodyText: string): PostToGetCompatParse {
  if (new TextEncoder().encode(bodyText).byteLength >= POST_TO_GET_MAX_BODY_BYTES) {
    return { status: 'too_large' };
  }
  if (bodyText.trim().length === 0) {
    return { status: 'ok', fields: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 'malformed_json' };
  }

  if (!isPostToGetPlainObject(parsed)) {
    return { status: 'unsupported_body' };
  }

  const fields: PostToGetCompatField[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) {
      if (value.length > POST_TO_GET_MAX_ARRAY_VALUES_PER_KEY) {
        return { status: 'oversized_array', parameter: name };
      }
      const values: string[] = [];
      for (const item of value) {
        if (!isPostToGetScalar(item)) {
          return { status: 'unsupported_value', parameter: name };
        }
        values.push(String(item));
      }
      fields.push({ kind: 'array', name, values });
      continue;
    }
    if (isPostToGetScalar(value)) {
      fields.push({ kind: 'scalar', name, value: String(value) });
      continue;
    }
    return { status: 'unsupported_value', parameter: name };
  }
  return { status: 'ok', fields };
}

function applyPostToGetCompatFields(searchParams: URLSearchParams, fields: PostToGetCompatField[]): void {
  for (const field of fields) {
    if (field.kind === 'scalar') {
      searchParams.set(field.name, field.value);
      continue;
    }
    for (const value of field.values) {
      searchParams.append(field.name, value);
    }
  }
}

function postToGetCompatErrorBody(parsed: Exclude<PostToGetCompatParse, { status: 'ok' }>): Record<string, unknown> {
  if (parsed.status === 'too_large') return { error: 'malformed_request' };
  if (parsed.status === 'malformed_json') return { error: 'Invalid JSON body for POST compatibility' };
  if (parsed.status === 'unsupported_body') return { error: 'Unsupported POST compatibility body' };
  if (parsed.status === 'oversized_array') {
    return {
      error: 'Too many values for POST compatibility parameter',
      parameter: parsed.parameter,
      maxValues: POST_TO_GET_MAX_ARRAY_VALUES_PER_KEY,
    };
  }
  return {
    error: 'Unsupported value for POST compatibility parameter',
    parameter: parsed.parameter,
  };
}

function getRequiredBboxQueryProblems(searchParams: URLSearchParams): { missing: string[]; invalid: string[]; allZero: boolean } {
  const absent: string[] = [];
  const invalid: string[] = [];
  const values: number[] = [];

  for (const param of REQUIRED_BBOX_QUERY_PARAMS) {
    const raw = searchParams.get(param);
    if (raw == null) {
      absent.push(param);
      continue;
    }
    if (raw.trim() === '') {
      invalid.push(param);
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      invalid.push(param);
      continue;
    }
    values.push(value);
  }

  const missing = absent.length === REQUIRED_BBOX_QUERY_PARAMS.length ? [...REQUIRED_BBOX_QUERY_PARAMS] : [];
  return {
    missing,
    invalid,
    allZero: absent.length === 0 && invalid.length === 0 && values.every((value) => value === 0),
  };
}

type RequiredBboxDiagnostic = {
  status: 'missing' | 'invalid';
  missing: string[];
  invalid: string[];
};

function getRequiredBboxDiagnostic(request: Request, pathname: string): RequiredBboxDiagnostic | null {
  if (!REQUIRED_BBOX_RPC_PATH_SET.has(pathname)) return null;

  const { searchParams } = new URL(request.url);
  const { missing, invalid, allZero } = getRequiredBboxQueryProblems(searchParams);
  if (missing.length === 0 && invalid.length === 0 && !allZero) return null;

  return {
    status: missing.length > 0 ? 'missing' : 'invalid',
    missing,
    invalid: allZero ? [...REQUIRED_BBOX_QUERY_PARAMS] : invalid,
  };
}

function attachRequiredBboxDiagnosticHeaders(
  headers: Headers,
  pathname: string,
  diagnostic: RequiredBboxDiagnostic | null,
): void {
  if (!diagnostic) return;
  headers.set('X-WorldMonitor-Bbox', diagnostic.status);
  if (diagnostic.missing.length > 0) headers.set('X-WorldMonitor-Bbox-Missing', diagnostic.missing.join(','));
  if (diagnostic.invalid.length > 0) headers.set('X-WorldMonitor-Bbox-Invalid', diagnostic.invalid.join(','));
  if (MILITARY_BBOX_DIAGNOSTIC_PATH_SET.has(pathname)) {
    // Issue #4595 explicitly requested the military alias; keep it as a stable consumer affordance.
    headers.set('X-Military-Bbox', diagnostic.status);
  }
}

// `TRUSTED_USER_ID_HEADER` (a.k.a. `x-user-id`) and
// `TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER` are gateway-internal: the gateway is
// the ONLY layer permitted to set them, and each must reflect an
// authenticated principal. Inbound client copies are stripped at handler
// entry (see stripClientTrustedHeaders); the authenticated user id is re-
// injected after partner Clerk-bearer auth via
// withAuthenticatedUserId, and the rate-limit principal is stamped once all
// auth has resolved (see withTrustedRateLimitPrincipal).
//
// The sub-request header remains untrusted until its one-use Redis admission
// is consumed. Presence alone never bypasses a gateway limit.
function cloneRequestWithHeaders(request: Request, headers: Headers): Request {
  return new Request(request, { headers });
}

function stripClientTrustedHeaders(request: Request): Request {
  if (
    !request.headers.has(TRUSTED_USER_ID_HEADER) &&
    !request.headers.has(TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER)
  ) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.delete(TRUSTED_USER_ID_HEADER);
  headers.delete(TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER);
  return cloneRequestWithHeaders(request, headers);
}

function withAuthenticatedUserId(request: Request, userId: string): Request {
  const headers = new Headers(request.headers);
  headers.set(TRUSTED_USER_ID_HEADER, userId);
  return cloneRequestWithHeaders(request, headers);
}

// Stamped after auth resolution with the principal the gateway itself charged,
// so a handler that re-dispatches sub-requests (the batch fan-out) charges the
// same bucket a direct call would instead of guessing from raw credentials.
function withTrustedRateLimitPrincipal(
  request: Request,
  userId: string,
  scope: 'session' | 'api_key',
): Request {
  const headers = new Headers(request.headers);
  headers.set(
    TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER,
    formatTrustedRateLimitPrincipal(userId, scope),
  );
  return cloneRequestWithHeaders(request, headers);
}

function normalizeAuthError(error: string | undefined): string {
  if (!error) return 'Invalid API key';
  return error;
}

function createGatewayAuthErrorResponse(
  status: 401 | 403,
  error: string | undefined,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: normalizeAuthError(error) }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders,
      Link: DEPRECATION_POLICY_LINK,
    },
  });
}

const GATEWAY_DIRECT_LLM_QUOTA_METHODS: Record<string, string> = {
  '/api/market/v1/analyze-stock': 'GET',
  '/api/news/v1/summarize-article': 'POST',
};


// A direct-LLM reservation that dispatch() has charged but not yet settled,
// keyed by the request it was charged for. dispatch() releases it itself on
// every unserved outcome it can see; this map exists for the one it cannot:
// a throw after the handler returned (a rejecting response body stream, a
// failed response construction), which leaves dispatch() without a return
// value and the platform answering 500. The outer handler drains it on a
// rejected dispatch and releases the slot there.
const pendingDirectLlmReservations = new WeakMap<Request, () => Promise<void>>();

function methodForGetEquivalentPolicy(method: string): string {
  return method === 'HEAD' ? 'GET' : method;
}

async function shouldReserveGatewayDirectLlmQuota(request: Request, pathname: string): Promise<boolean> {
  if (!DIRECT_LLM_GATEWAY_QUOTA_PATHS.has(pathname)) return false;
  if (GATEWAY_DIRECT_LLM_QUOTA_METHODS[pathname] !== methodForGetEquivalentPolicy(request.method)) return false;
  if (pathname !== '/api/news/v1/summarize-article') return true;

  const contentLength = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength >= POST_TO_GET_MAX_BODY_BYTES) {
    return true;
  }
  try {
    const body = await request.clone().json() as { mode?: unknown };
    return body.mode !== 'translate';
  } catch {
    // Malformed summarize requests cannot reach provider spend; let the handler
    // return the established validation error without charging quota.
    return false;
  }
}

function createDirectLlmQuotaFailureResponse(
  reservation: Awaited<ReturnType<typeof reserveDirectLlmQuota>>,
  corsHeaders: Record<string, string>,
): Response {
  if (reservation.ok) {
    throw new Error('createDirectLlmQuotaFailureResponse called for successful reservation');
  }

  if (reservation.reason === 'cap-exceeded') {
    return new Response(JSON.stringify({
      error: 'Direct LLM daily quota exceeded',
      limit: reservation.floor ?? DIRECT_LLM_DAILY_QUOTA_LIMIT,
      resetsAt: 'next UTC midnight',
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Retry-After': String(reservation.retryAfterSec),
        ...corsHeaders,
      },
    });
  }

  return new Response(JSON.stringify({ error: 'Direct LLM quota unavailable' }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Retry-After': String(reservation.retryAfterSec),
      ...corsHeaders,
    },
  });
}

/**
 * Every request header the gateway or a sibling auth path treats as a
 * credential (#8400). `hasCredentialBearingHeader` consumes this list so a
 * new credential header cannot be added without appearing in the cache-tier
 * guard. Route-scoped verifications (e.g. a single POST RPC's desktop HMAC
 * pair) export their own constants and stay OUT: they are not consumed as a
 * bearer by an auth path — per-principal bodies behind those MUST be no-store
 * at the handler instead of relying on this audience overwrite.
 *
 * Exported so a divergence test can pin the list against the auth-path
 * readers. When adding an entry here, extend the pinned literal in
 * server/__tests__/gateway-credential-headers.test.ts.
 */
export const CREDENTIAL_BEARING_HEADERS = [
  'Authorization',
  'X-WorldMonitor-Key',
  'X-Api-Key',
  'Cookie',
] as const;

export function hasCredentialBearingHeader(request: Request): boolean {
  return CREDENTIAL_BEARING_HEADERS.some((header) => Boolean(request.headers.get(header)));
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}


// Authenticate a relay warm-ping as a trusted internal caller. True only when
// the path is an explicit warm-ping target AND the request carries the dedicated
// relay secret in X-WorldMonitor-Key (timing-safe compared). Returns false when
// the secret is unset so a misconfigured deploy fails CLOSED (no bypass) rather
// than silently opening these paths.
export async function isRelayWarmPingRequest(request: Request, pathname: string): Promise<boolean> {
  if (!RELAY_WARM_PING_PATHS.has(pathname)) return false;
  const expected = process.env.WORLDMONITOR_RELAY_KEY?.trim() ?? '';
  if (!expected) return false;
  const candidate = request.headers.get('X-WorldMonitor-Key') ?? '';
  return timingSafeEqual(candidate, expected);
}

export function createDomainGateway(
  routes: RouteDescriptor[],
): (req: Request, ctx?: GatewayCtx) => Promise<Response> {
  const router = createRouter(routes);

  async function dispatch(originalRequest: Request, ctx?: GatewayCtx): Promise<Response> {
    const originalPathname = new URL(originalRequest.url).pathname;

    // Vercel resolves versioned API paths such as
    // `/api/forecast/v1/get-forecast-scorecard.md` to the more-specific
    // `api/<domain>/v1/[rpc].ts` function before the root API catch-all. Handle
    // markdown probes here, before auth and RPC dispatch, so every dynamic
    // domain gateway follows the same site-wide `.md` twin contract without a
    // broad rewrite that would shadow the real endpoints (#4724).
    if (
      originalPathname.startsWith('/api/') &&
      isMarkdownTwinPath(originalPathname) &&
      (originalRequest.method === 'GET' || originalRequest.method === 'HEAD')
    ) {
      return buildMarkdownTwinResponse(originalRequest, originalPathname);
    }

    let request = stripClientTrustedHeaders(originalRequest);
    const rawPathname = new URL(request.url).pathname;
    const pathname = stripTrailingSlashes(rawPathname);
    const t0 = Date.now();

    // Usage-telemetry identity inputs — accumulated as gateway auth resolution progresses.
    // Read at every return point; null defaults are valid for early returns.
    const usage: UsageIdentityInput = {
      sessionUserId: null,
      enterpriseApiKey: null,
    };
    // Domain segment for telemetry. Path layouts:
    //   /api/<domain>/v1/<rpc>          → parts[2] = domain
    //   /api/v2/<domain>/<rpc>          → parts[2] = "v2", parts[3] = domain
    const _parts = pathname.split('/');
    const domain = (/^v\d+$/.test(_parts[2] ?? '') ? _parts[3] : _parts[2]) ?? '';
    const reqBytes = deriveReqBytes(request);

    // #3199: in shadow mode a per-key limit that WOULD have triggered is
    // recorded on the single terminal success emit (never a second event) so
    // the volume signal is not double-counted. Overrides only a successful
    // terminal reason (status < 400); a real 4xx/5xx outcome wins.
    let pendingShadowReason: RequestReason | null = null;
    function emitRequest(status: number, reason: RequestReason, cacheTier: UsageCacheTier | null, resBytes = 0): void {
      if (!ctx?.waitUntil) return;
      const effectiveReason: RequestReason =
        pendingShadowReason && status < 400 ? pendingShadowReason : reason;
      const identity = buildUsageIdentity(usage);
      // Single ctx.waitUntil() registered synchronously in the request phase.
      // The IIFE awaits ua_hash (SHA-256) then awaits delivery directly via
      // deliverUsageEvents — no nested waitUntil call, which Edge runtimes
      // (Cloudflare/Vercel) may drop after the response phase ends.
      ctx.waitUntil((async () => {
        const uaHash = await deriveUaHash(originalRequest);
        await deliverUsageEvents([
          buildRequestEvent({
            requestId: deriveRequestId(originalRequest),
            domain,
            route: pathname,
            method: originalRequest.method,
            status,
            durationMs: Date.now() - t0,
            reqBytes,
            resBytes,
            customerId: identity.customer_id,
            principalId: identity.principal_id,
            authKind: identity.auth_kind,
            // Telemetry schema columns; NucMonitor has no plans.
            tier: 0,
            planKey: null,
            country: deriveCountry(originalRequest),
            ipCity: deriveIpCity(originalRequest),
            ipRegion: deriveIpRegion(originalRequest),
            executionRegion: deriveExecutionRegion(originalRequest),
            executionPlane: 'vercel-edge',
            originKind: deriveOriginKind(originalRequest),
            cacheTier,
            ip: deriveIp(originalRequest),
            userAgent: deriveUserAgent(originalRequest),
            uaHash,
            referer: deriveReferer(originalRequest),
            acceptLanguage: deriveAcceptLanguage(originalRequest),
            host: deriveHost(originalRequest),
            sentryTraceId: deriveSentryTraceId(originalRequest),
            reason: effectiveReason,
          }),
        ]);
      })());
    }

    // Fail closed on CORS-header generation errors. Previous behaviour fell
    // back to a wildcard ACAO, which converted the allowlist into wildcard
    // CORS on the error path. Now we omit CORS headers and surface a 500
    // so the browser blocks any cross-origin read. See issue #3705.
    let corsHeaders: Record<string, string>;
    try {
      corsHeaders = isDisallowedOrigin(request)
        ? getOriginDeniedCorsHeaders(request)
        : getCorsHeaders(request);
    } catch (err) {
      // Pass the Sentry delivery promise through ctx.waitUntil so the
      // Vercel Edge isolate survives long enough to actually flush the
      // event. (captureSilentError uses keepalive:true as a transport
      // fallback when ctx is absent, but the explicit waitUntil is the
      // documented best practice.)
      const captured = captureSilentError(err, {
        tags: { route: 'gateway', step: 'cors_headers' },
      });
      ctx?.waitUntil(captured);
      emitRequest(500, 'cors_error', null);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          // Prevent CDN/edge from caching the 500 — a transient CORS
          // failure must not be pinned for downstream callers.
          'Cache-Control': 'no-store',
        },
      });
    }

    // RFC 9745 policy discovery on every CORS-bearing response, including
    // 401/403/404/405 early returns. Idempotent if a handler already set
    // rel="deprecation". Absolute URL: api.worldmonitor.app would 404 a
    // root-relative /api-versioning.md.
    appendDeprecationPolicyLinkToRecord(corsHeaders);

    // OPTIONS preflight must succeed even for origins we refuse on the actual
    // request — otherwise the browser never sends POST/GET and origin_403 is
    // an opaque network error (#6411).
    if (request.method === 'OPTIONS') {
      emitRequest(204, 'preflight', null);
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Origin check — refuse with readable CORS so the browser can surface the
    // 403 instead of an opaque network error (#6411).
    if (isDisallowedOrigin(request)) {
      emitRequest(403, 'origin_403', null);
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      });
    }

    // Two high-volume, caller-invariant dashboard reads expose an exact
    // `public=1` URL shape. The marker creates a CDN key separate from the
    // legacy credentialed URL, which remains session/key gated and no-store.
    // Classification ignores attached credentials because a Vercel cache hit
    // happens before this function sees them; the public URL must therefore
    // have one response contract for every caller.
    // Partner deployments serve no shared anonymous reads (docs/partner-access.md);
    // the keyless form endpoints in PUBLIC_NO_AUTH_RPC_PATHS stay open.
    const partnerMode = isPartnerMode();
    const isPublicNoAuthRpc = PUBLIC_NO_AUTH_RPC_PATHS.has(pathname)
      || (!partnerMode && isPublicSharedRpcRequest(request.url, request.method));
    const relayWarmPingVerified = await isRelayWarmPingRequest(request, pathname);
    // Resolve the quota policy against the route POST compatibility will use.
    // Keep body validation after auth and abuse limiting; invalid bodies still
    // return before reservation or dispatch.
    let directLlmPolicyRequest = request;
    if (
      request.method === 'POST'
      && GATEWAY_DIRECT_LLM_QUOTA_METHODS[pathname] === 'GET'
      && isPostToGetCompatibleBodySize(request.headers)
      && !router.match(request)
    ) {
      const getProbe = new Request(request.url, { method: 'GET', headers: request.headers });
      if (router.match(getProbe)) directLlmPolicyRequest = getProbe;
    }
    const requiresDirectLlmQuota = await shouldReserveGatewayDirectLlmQuota(directLlmPolicyRequest, pathname);
    let rateLimitPrincipalUserId: string | undefined;
    let sessionUserId: string | null = null;

    // Every data route requires a browser session token (wms_), an enterprise
    // key (WORLDMONITOR_VALID_KEYS), or — in partner mode — a partner's Clerk
    // bearer. There are no plans: whoever passes this layer has full access.
    let keyCheck: { valid: boolean; required: boolean; error?: string; kind?: 'enterprise' | 'session'; credential?: string } = isPublicNoAuthRpc || relayWarmPingVerified
      ? { valid: true, required: false }
      : ((await validateApiKey(request)) as { valid: boolean; required: boolean; error?: string; kind?: 'enterprise' | 'session'; credential?: string });

    // In partner mode a Clerk session proves identity, not partnership, so it
    // stands in for the session/key only when that account is on the partner
    // list (docs/partner-access.md). An identity-provider or Convex outage is
    // a retryable 503, never a cached refusal.
    if (keyCheck.required && !keyCheck.valid && partnerMode && getBearerToken(request)) {
      const partner = await verifyPartnerRequest(request);
      if (partner.ok) {
        sessionUserId = partner.userId;
        usage.sessionUserId = partner.userId;
        rateLimitPrincipalUserId = partner.userId;
        request = withAuthenticatedUserId(request, partner.userId);
        keyCheck = { valid: true, required: false };
      } else if (partner.status === 503) {
        emitRequest(503, 'auth_unavailable', null);
        return new Response(JSON.stringify({ error: partner.error }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Retry-After': '5',
            ...corsHeaders,
          },
        });
      }
    }

    // Enterprise API key (WORLDMONITOR_VALID_KEYS): require kind === 'enterprise'
    // and use the credential validateApiKey actually selected, never a raw
    // header re-read (a wms_ session token is anonymous, not an operator).
    const isEnterpriseAuth = keyCheck.valid
      && keyCheck.kind === 'enterprise'
      && Boolean(keyCheck.credential);
    const enterpriseCredential = isEnterpriseAuth ? (keyCheck.credential ?? '') : '';
    if (enterpriseCredential) {
      usage.enterpriseApiKey = enterpriseCredential;
    }

    if (keyCheck.required && !keyCheck.valid) {
      emitRequest(401, 'auth_401', null);
      return createGatewayAuthErrorResponse(401, keyCheck.error, corsHeaders);
    }

    // Route matching — if POST doesn't match, convert to GET for stale clients.
    // Strict compatibility 400s stay pending until the normal endpoint/global
    // limiter path runs so malformed or nested bodies still consume the GET
    // route's abuse budget. The pending response is returned before
    // direct-LLM quota and handler dispatch.
    let matchedHandler = router.match(request);
    let pendingPostToGetCompatError: Response | null = null;
    if (!matchedHandler && request.method === 'POST') {
      if (isPostToGetCompatibleBodySize(request.headers)) {
        const url = new URL(request.url);
        const getProbe = new Request(url.toString(), { method: 'GET', headers: request.headers });
        const getProbeHandler = router.match(getProbe);
        if (getProbeHandler) {
          let compatErrorBody: Record<string, unknown> | null = null;
          let compatFields: PostToGetCompatField[] = [];
          try {
            const parsed = parsePostToGetCompatBody(await request.clone().text());
            if (parsed.status === 'ok') {
              compatFields = parsed.fields;
            } else {
              compatErrorBody = postToGetCompatErrorBody(parsed);
            }
          } catch {
            compatErrorBody = { error: 'malformed_request' };
          }
          if (compatErrorBody) {
            pendingPostToGetCompatError = new Response(JSON.stringify(compatErrorBody), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
            matchedHandler = getProbeHandler;
            request = getProbe;
          } else {
            applyPostToGetCompatFields(url.searchParams, compatFields);
            const getReq = new Request(url.toString(), { method: 'GET', headers: request.headers });
            matchedHandler = router.match(getReq);
            if (matchedHandler) request = getReq;
          }
        }
      }
    }
    if (!matchedHandler) {
      const allowed = router.allowedMethods(new URL(request.url).pathname);
      if (allowed.length > 0) {
        emitRequest(405, 'method_not_allowed', null);
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', Allow: allowed.join(', '), ...corsHeaders },
        });
      }
      emitRequest(404, 'unknown_route', null);
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const requiredBboxDiagnostic = getRequiredBboxDiagnostic(request, pathname);
    const identityForScope = buildUsageIdentity(usage);

    // ── Idempotency-Key support (mutation retry-safety) ──────────────────────
    // Opt-in: only a POST carrying the header. POST→GET-converted batch reads
    // (compat block above) are already GET here and are skipped. Scope by the
    // resolved principal so a key can never replay another caller's response.
    // Fail-open: any Redis issue proceeds without idempotency (see the module).
    // Routes in IDEMPOTENCY_EXEMPT_RPC_PATHS own their own retry semantics (per-row
    // outcomes recomputed against current state), so generic whole-response replay would
    // violate their contract. The published OpenAPI already omits the parameter for them;
    // ignore the header here too, otherwise a client that sends it anyway still gets the
    // replay the spec says it cannot.
    let idempotency: IdempotencyOutcome | null = null;
    const hasIdempotencyKey = request.method === 'POST'
      && request.headers.has(IDEMPOTENCY_HEADER)
      && !IDEMPOTENCY_EXEMPT_RPC_PATHS.has(pathname);
    const idScope = identityForScope.principal_id ?? identityForScope.customer_id;
    const idempotencyScope = idScope ? `${identityForScope.auth_kind}:${idScope}` : null;

    // Look up an existing idempotency record before rate-limit/quota counters.
    // This lets a retry of completed work replay without charging a duplicate
    // unit. A miss does NOT claim the key; fresh executions still pass through
    // the normal abuse controls before `beginIdempotency()` below.
    if (hasIdempotencyKey) {
      const peek = await peekIdempotency({
        request,
        pathname,
        scope: idempotencyScope,
        idempotencyKey: request.headers.get(IDEMPOTENCY_HEADER) ?? '',
        corsHeaders,
      });
      switch (peek.kind) {
        case 'invalid':
          emitRequest(400, 'idempotency_invalid', null);
          return peek.response;
        case 'replay':
          emitRequest(peek.response.status, 'idempotent_replay', null);
          return peek.response;
        case 'conflict':
          emitRequest(409, 'idempotency_conflict', null);
          return peek.response;
        case 'mismatch':
          emitRequest(422, 'idempotency_mismatch', null);
          return peek.response;
        // 'miss' proceeds to rate limiting; 'disabled' preserves fail-open behavior.
      }
    }

    // Gateway rate limiting — two-phase: endpoint-specific first, then global fallback.
    // A verified partner account uses a per-user bucket; other traffic uses IP.
    //
    // Only a single-use admission for this exact request waives the prepaid
    // endpoint/global limit. Key meters and auth still run for every call.
    const subRequestAdmission = await consumeSubRequestAdmission(request, rateLimitPrincipalUserId
      ? formatTrustedRateLimitPrincipal(rateLimitPrincipalUserId, 'session')
      : null);
    if (subRequestAdmission === 'unavailable') {
      const response = new Response(JSON.stringify({ error: 'Rate-limit service temporarily unavailable' }), {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...RATE_LIMIT_DEGRADED_HEADERS,
          ...corsHeaders,
        },
      });
      emitRequest(503, 'rate_limit_degraded', null);
      return response;
    }
    const isServerSubRequest = subRequestAdmission === 'admitted';
    {
      // These local provider lookups use the sidecar cache without Upstash.
      // Keep these exceptions exact-path; cloud requests retain the provider cap.
      const isSidecarProviderLookup = process.env.LOCAL_API_MODE === 'tauri-sidecar'
        && pathname === '/api/webcam/v1/get-webcam-image';
      const endpointRlResponse = isServerSubRequest || isSidecarProviderLookup ? null : rateLimitPrincipalUserId
        ? await checkEndpointRateLimit(request, pathname, corsHeaders, {
            principalUserId: rateLimitPrincipalUserId,
            principalScope: 'session',
          })
        : await checkEndpointRateLimit(request, pathname, corsHeaders);
      if (endpointRlResponse) {
        const reason = getRateLimitTelemetryReason(
          endpointRlResponse,
          'rate_limit_429_endpoint',
        );
        emitRequest(endpointRlResponse.status, reason, null);
        return endpointRlResponse;
      }

      // ── Per-key API rate limit for enterprise keys (#3199) ──────────────
      // An enterprise env key (WORLDMONITOR_VALID_KEYS) is governed by a
      // per-key burst + daily circuit-breaker meter instead of the global
      // fallback. In ENFORCE, confirmed burst admission bypasses that
      // fallback; in SHADOW it records telemetry and still falls through to it.
      // Each operator key gets its own budget: these keys carry no shared
      // account, so they do not contend for one bucket.
      let governedByApiKeyLayer = false;
      let rollbackDailyMeter: (() => Promise<void>) | undefined;
      if (isEnterpriseAuth) {
        const enforce = process.env.API_RATE_LIMIT_ENFORCE === 'true';
        const perMinute = ENTERPRISE_API_RATE_LIMIT;
        // A circuit-breaker ceiling, not a plan limit (high-usage-alarm.ts).
        const allowance = OPERATOR_KEY_DAILY_CEILINGS.restRequests;
        const identity = hashKeySync(enterpriseCredential);

        // 1. Per-minute burst (hard limit).
        const burst = await checkBurst(perMinute, identity);
        if (burst.ok === false) {
          if (enforce) {
            const retryAfterSec = Math.max(1, Math.ceil((burst.reset - Date.now()) / 1000));
            emitRequest(429, 'rl_min_429', null);
            return new Response(JSON.stringify({
              error: 'Too many requests',
              limit: burst.limit,
              limit_type: 'per_minute',
              reset: new Date(burst.reset).toISOString(),
            }), {
              status: 429,
              headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
                ...rateLimitHeaders({ limit: burst.limit, remaining: 0, resetMs: burst.reset, retryAfterSec, windowSec: 60 }),
                ...corsHeaders,
              },
            });
          }
          pendingShadowReason = 'rl_min_shadow';
        } else {
          // 2. Daily circuit-breaker meter.
          const meter = await reserveDailyMeter({
            userId: identity,
            allowance,
            pipeline: (cmds) => runRedisPipeline(cmds),
          });
          if (meter.metered) {
            rollbackDailyMeter = meter.rollback;
            // Ceilings are circuit breakers; page well before one trips.
            reportHighUsageIfCrossed({
              meter: 'rest',
              credential: 'operator-key',
              principal: identity,
              newCount: meter.count,
              ceiling: allowance,
              ctx,
            });
          }
          if (meter.overLimit) {
            if (enforce) {
              await meter.rollback();
              emitRequest(429, 'rl_ceiling_429', null);
              return new Response(JSON.stringify({
                error: 'Daily request limit reached',
                limit: allowance,
                limit_type: 'daily',
                reset: new Date(Date.now() + meter.retryAfterSec * 1000).toISOString(),
              }), {
                status: 429,
                headers: {
                  'Content-Type': 'application/json',
                  'Cache-Control': 'no-store',
                  ...rateLimitHeaders({
                    limit: allowance,
                    remaining: 0,
                    resetMs: Date.now() + meter.retryAfterSec * 1000,
                    retryAfterSec: meter.retryAfterSec,
                    // Daily ceiling window (24 h) for the advertised policy.
                    windowSec: 86_400,
                  }),
                  ...corsHeaders,
                },
              });
            }
            pendingShadowReason = 'rl_ceiling_shadow';
          }
        }
        // Confirmed burst admission + enforce ⇒ the per-key layer governs this
        // request and skips the global fallback. If unavailable or in shadow,
        // keep that fallback active with IP attribution.
        if (enforce && burst.ok === true) governedByApiKeyLayer = true;
      }

      if (!isServerSubRequest && !governedByApiKeyLayer && !hasEndpointRatePolicy(pathname)) {
        const rateLimitResponse = rateLimitPrincipalUserId
          ? await checkRateLimit(request, corsHeaders, {
              principalUserId: rateLimitPrincipalUserId,
              principalScope: 'session',
            })
          : await checkRateLimit(request, corsHeaders);
        if (rateLimitResponse) {
          await rollbackDailyMeter?.();
          const reason = getRateLimitTelemetryReason(
            rateLimitResponse,
            'rate_limit_429_global',
          );
          emitRequest(rateLimitResponse.status, reason, null);
          return rateLimitResponse;
        }
      }
    }

    if (pendingPostToGetCompatError) {
      emitRequest(400, 'malformed_request', null);
      return pendingPostToGetCompatError;
    }

    // Held from reservation until the outcome is known. reserveDirectLlmQuota
    // charges the caller's daily allowance up front (INCR before the handler
    // runs); every path below that ends without serving an answer releases
    // it through this handle instead of leaving the slot spent (#5147).
    // rollback is idempotent, so calling it from more than one exit path is
    // safe.
    let directLlmRollback: (() => Promise<void>) | null = null;
    const releaseDirectLlmReservation = async (): Promise<void> => {
      const rollback = directLlmRollback;
      directLlmRollback = null;
      pendingDirectLlmReservations.delete(originalRequest);
      if (rollback) await rollback();
    };

    if (requiresDirectLlmQuota) {
      // One flat daily allowance per principal; there are no plans. Operator
      // keys are metered per key against their circuit-breaker ceiling. A
      // verified partner is metered per account. Everyone else is metered by
      // client address (IPv6 grouped by /64, as the rate limiter does), hashed
      // to keep the raw address out of Redis keys: wms_ sessions are freely
      // mintable, so rotating them must not reset spend.
      const quotaUserId = isEnterpriseAuth
        ? await operatorKeyQuotaPrincipal(enterpriseCredential)
        : sessionUserId ?? `ip:${hashKeySync(rateLimitKeyForIp(getClientIp(request)))}`;
      const directLlmDailyLimit = isEnterpriseAuth
        ? OPERATOR_KEY_DAILY_CEILINGS.directLlmCalls
        : DIRECT_LLM_DAILY_QUOTA_LIMIT;

      const reservation = await reserveDirectLlmQuota({
        userId: quotaUserId,
        limit: directLlmDailyLimit,
        pipeline: (cmds) => runRedisPipeline(cmds, true),
      });
      if (!reservation.ok) {
        const response = createDirectLlmQuotaFailureResponse(reservation, corsHeaders);
        emitRequest(
          response.status,
          response.status === 429 ? 'rate_limit_429_direct_llm' : 'rate_limit_degraded',
          null,
        );
        return response;
      }
      if (isEnterpriseAuth) {
        reportHighUsageIfCrossed({
          meter: 'direct-llm',
          credential: 'operator-key',
          principal: hashKeySync(enterpriseCredential),
          newCount: reservation.newCount,
          ceiling: directLlmDailyLimit,
          ctx,
        });
      }
      directLlmRollback = reservation.rollback;
      pendingDirectLlmReservations.set(originalRequest, reservation.rollback);
    }

    // Gate on presence (not truthiness) so a present-but-empty header is
    // rejected as malformed rather than silently ignored.
    if (hasIdempotencyKey) {
      idempotency = await beginIdempotency({
        request,
        pathname,
        // Tag the scope with the auth kind so value spaces (Clerk id vs hashed
        // key vs customer ref) can never collide across authentication methods.
        scope: idempotencyScope,
        idempotencyKey: request.headers.get(IDEMPOTENCY_HEADER) ?? '',
        corsHeaders,
      });
      // The peek above ran before the reservation, so these short-circuits
      // only fire when a concurrent request for the same key completed in
      // between. None of them executes the handler; give the slot back.
      switch (idempotency.kind) {
        case 'invalid':
          await releaseDirectLlmReservation();
          emitRequest(400, 'idempotency_invalid', null);
          return idempotency.response;
        case 'replay':
          await releaseDirectLlmReservation();
          emitRequest(idempotency.response.status, 'idempotent_replay', null);
          return idempotency.response;
        case 'conflict':
          await releaseDirectLlmReservation();
          emitRequest(409, 'idempotency_conflict', null);
          return idempotency.response;
        case 'mismatch':
          await releaseDirectLlmReservation();
          emitRequest(422, 'idempotency_mismatch', null);
          return idempotency.response;
        // 'disabled' (fail-open) and 'proceed' fall through to execution.
      }
    }

    // Execute handler with top-level error boundary.
    // Wrap in runWithUsageScope so deep fetch helpers (fetchJson,
    // cachedFetchJsonWithMeta) can attribute upstream calls to this customer
    // without leaf handlers having to thread a usage hook through every call.
    let response: Response;
    const handlerCall = matchedHandler;
    // Handlers that re-dispatch sub-requests must charge the caller's own
    // budget; the identity resolved above is the only trustworthy source for
    // it, since raw credential headers are unvalidated at that point. Absent
    // a resolved principal the marker stays unset and handlers fall back to
    // the caller's IP, matching this gateway's own attribution.
    const requestForHandler = rateLimitPrincipalUserId
      ? withTrustedRateLimitPrincipal(
          request,
          rateLimitPrincipalUserId,
          'session',
        )
      : request;
    try {
      response = await runWithUsageScope(
        {
          ctx: ctx ?? { waitUntil: () => {} },
          requestId: deriveRequestId(originalRequest),
          customerId: identityForScope.customer_id,
          route: pathname,
          tier: 0,
        },
        () => handlerCall(requestForHandler),
      );
    } catch (err) {
      console.error('[gateway] Unhandled handler error:', err);
      response = new Response(JSON.stringify({ message: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Merge CORS + handler side-channel headers into response.
    // Every side channel below is keyed by the Request object the handler
    // wrote it on, which is requestForHandler: a stamped principal makes it
    // a clone, so draining the pre-stamp request would silently drop every
    // header, retryable marker and status override set by an authenticated
    // caller's handler.
    const mergedHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders)) {
      mergedHeaders.set(key, value);
    }
    const extraHeaders = drainResponseHeaders(requestForHandler);
    if (extraHeaders) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        mergedHeaders.set(key, value);
      }
    }
    appendDeprecationPolicyLink(mergedHeaders);
    const retryableResponse = drainRetryableResponse(requestForHandler);

    // Release the direct-LLM reservation when the request was not served: the
    // handler threw (500 above), returned any 4xx/5xx, reported a retryable
    // error inside a 200 envelope, or degraded to an empty LLM result and
    // said so via markUnservedLlmResponse. A delivered answer, cached or
    // partial, stays charged. Drained unconditionally so a marker set on a
    // request that carried no reservation cannot leak into a later decision.
    const unservedLlmResponse = drainUnservedLlmResponse(requestForHandler);
    if (directLlmRollback && (response.status >= 400 || retryableResponse || unservedLlmResponse)) {
      await releaseDirectLlmReservation();
    }
    attachRequiredBboxDiagnosticHeaders(mergedHeaders, pathname, requiredBboxDiagnostic);

    // Handler side-channel status override (setSuccessStatusOverride): applied
    // only when the handler actually produced a 200 on a POST — async-enqueue
    // endpoints (run-scenario) upgrade their success to 202 Accepted, while
    // thrown ApiError statuses always win. GET success flows are excluded:
    // the ETag/304 + CDN-cache path below assumes 200. Always drained so a
    // set-but-unapplied override can't leak state.
    const statusOverride = drainSuccessStatusOverride(requestForHandler);
    const finalStatus =
      statusOverride !== undefined && request.method === 'POST' && response.status === 200
        ? statusOverride
        : response.status;

    // For GET 200 responses: read body once for cache-header decisions + ETag
    let resolvedCacheTier: CacheTier | null = null;
    if (response.status === 200 && (request.method === 'GET' || request.method === 'HEAD') && response.body) {
      const bodyBytes = await response.arrayBuffer();

      const bodyStr = new TextDecoder().decode(bodyBytes);
      const noStoreReason = getRpcNoStoreReasonFromJson(bodyStr, { pathname });

      const rpcName = pathname.split('/').pop() ?? '';
      const envOverride = process.env[`CACHE_TIER_OVERRIDE_${rpcName.replace(/-/g, '_').toUpperCase()}`] as CacheTier | undefined;
      const mapTier = RPC_CACHE_TIER[pathname];
      // The route's own declared tier (an env override wins over the map for
      // normal tiers). A route declared no-store is a hard freshness/privacy
      // floor: the audience overwrite below must never upgrade it to a
      // browser-cacheable tier for a credentialed caller — and a map-declared
      // no-store (account-private company-monitoring reads, live feeds) is not
      // even an env override may downgrade (#6771).
      const declaredTier = (envOverride && envOverride in TIER_HEADERS ? envOverride : null) ?? mapTier;

      if (mergedHeaders.get('X-No-Cache') || noStoreReason || declaredTier === 'no-store' || mapTier === 'no-store') {
        mergedHeaders.set('Cache-Control', 'no-store');
        mergedHeaders.delete('CDN-Cache-Control');
        mergedHeaders.delete('Vercel-CDN-Cache-Control');
        mergedHeaders.set('X-Cache-Tier', 'no-store');
        resolvedCacheTier = 'no-store';
      } else {
        const hasCredentialedNonPublicGet = !isPublicNoAuthRpc && hasCredentialBearingHeader(request);
        const tier = hasCredentialedNonPublicGet ? 'slow-browser' as CacheTier
          : declaredTier ?? 'medium';
        resolvedCacheTier = tier;
        // A credentialed non-public response must never be stored by a shared
        // cache, even at a browser tier — mark it private so only the caller's
        // own browser retains it. Vary is Origin-only, so without this a shared
        // proxy could serve one principal's body to another (#6771). (No-store
        // is handled above; anonymous public routes keep their CDN tier.)
        const isPrivateResponse = hasCredentialedNonPublicGet;
        const cacheControl = isPrivateResponse && !TIER_HEADERS[tier].includes('private')
          ? `private, ${TIER_HEADERS[tier]}`
          : TIER_HEADERS[tier];
        mergedHeaders.set('Cache-Control', cacheControl);
        // Only allow Vercel CDN caching for trusted origins (worldmonitor.app, Vercel previews,
        // Tauri). No-origin server-side requests (external scrapers) must always reach the edge
        // function so the auth check in validateApiKey() can run. Without this guard, a cached
        // 200 from a trusted-origin browser request could be served to a no-origin scraper,
        // bypassing auth entirely.
        const reqOrigin = request.headers.get('origin') || '';
        const cdnCache = !hasCredentialedNonPublicGet && isAllowedOrigin(reqOrigin)
          ? TIER_CDN_CACHE[tier]
          : null;
        mergedHeaders.delete('CDN-Cache-Control');
        mergedHeaders.delete('Vercel-CDN-Cache-Control');
        if (cdnCache) mergedHeaders.set('CDN-Cache-Control', cdnCache);
        mergedHeaders.set('X-Cache-Tier', tier);

        // Keep per-origin ACAO (already set from corsHeaders above) and preserve Vary: Origin.
        // ACAO: * with no Vary would collapse all origins into one cache entry, bypassing
        // isDisallowedOrigin() for cache hits — Vercel CDN serves s-maxage responses without
        // re-invoking the function, so a disallowed origin could read a cached ACAO: * response.
      }
      mergedHeaders.delete('X-No-Cache');
      if (!new URL(request.url).searchParams.has('_debug')) {
        mergedHeaders.delete('X-Cache-Tier');
      }

      // Universal optional JMESPath projection (REST parity with the MCP
      // server's `jmespath` tool argument). Applied to the JSON body BEFORE the
      // ETag hash so the ETag reflects the projected payload; the ?jmespath=
      // expression is part of the request URL, so Vercel's CDN keys each
      // projection separately. GET-only: mutating POSTs are already fully typed
      // via their requestBody and their responses are not cached/ETagged here.
      // See server/_shared/response-projection.ts + /docs/mcp-jmespath.
      let responseView = new Uint8Array(bodyBytes);
      const jmespathExpr = new URL(request.url).searchParams.get('jmespath');
      if (jmespathExpr && (mergedHeaders.get('Content-Type') ?? '').includes('application/json')) {
        let projection = projectJsonResponse(bodyStr, jmespathExpr);
        if (projection.ok) {
          // Attribution accompaniment — REST parity with the MCP dispatch rider
          // (shared/attribution-rider.ts). These paths were refused outright
          // before; refusal protected two supply-chain paths that carry no
          // licence field at all while `/api/safety/v1/get-toronto-safety`, which
          // does, was never on the list. The rider replaces the roster: the
          // sources are extracted from the UNPROJECTED body and merged AROUND
          // the projected document, so no expression can reach or remove them.
          //
          // Merged BEFORE the ETag hash below, so the ETag covers the rider.
          // Only the success path carries it: a failed projection is an HTTP 400
          // that serves no data, so there is nothing to accompany.
          const attributionExpr = REST_ATTRIBUTION_EXPRESSIONS[pathname];
          if (attributionExpr !== undefined) {
            let unprojected: unknown;
            try {
              unprojected = JSON.parse(bodyStr);
            } catch {
              unprojected = null;
            }
            const rider = buildAttributionRider(unprojected, attributionExpr);
            if (rider !== null) {
              const projectedBody = mergeAttributionRider(projection.body, rider);
              projection = enforceRestProjectionOutputLimit(projectedBody, unprojected);
            }
          }
        }
        if (!projection.ok) {
          // The handler completed its work. A caller-controlled projection
          // failure must not refund it and bypass the daily provider-spend cap.
          const errorBody = JSON.stringify(projection.envelope);
          emitRequest(400, 'malformed_request', null, errorBody.length);
          maybeAttachDevHealthHeader(mergedHeaders);
          return new Response(errorBody, {
            status: 400,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json; charset=utf-8',
              'X-Content-Type-Options': 'nosniff',
              'Cache-Control': 'no-store',
            },
          });
        }
        responseView = new TextEncoder().encode(projection.body);
        // The projected body has a different length than the handler's — drop any
        // stale Content-Length so the runtime recomputes it (a leftover value
        // would truncate the response).
        mergedHeaders.delete('Content-Length');
      }

      // FNV-1a inspired fast hash — good enough for cache validation
      let hash = 2166136261;
      const view = responseView;
      for (let i = 0; i < view.length; i++) {
        hash ^= view[i]!;
        hash = Math.imul(hash, 16777619);
      }
      const etag = `"${(hash >>> 0).toString(36)}-${view.length.toString(36)}"`;
      mergedHeaders.set('ETag', etag);

      const ifNoneMatch = request.headers.get('If-None-Match');
      if (ifNoneMatch === etag) {
        emitRequest(304, 'ok', resolvedCacheTier, 0);
        maybeAttachDevHealthHeader(mergedHeaders);
        return new Response(null, { status: 304, headers: mergedHeaders });
      }

      emitRequest(response.status, 'ok', resolvedCacheTier, view.length);
      maybeAttachDevHealthHeader(mergedHeaders);
      return new Response(responseView, {
        status: response.status,
        statusText: response.statusText,
        headers: mergedHeaders,
      });
    }

    if (response.status === 200 && (request.method === 'GET' || request.method === 'HEAD')) {
      if (mergedHeaders.get('X-No-Cache')) {
        mergedHeaders.set('Cache-Control', 'no-store');
      }
      mergedHeaders.delete('X-No-Cache');
    }

    // Idempotent POST (opt-in): buffer the body so it can be persisted for
    // replay, then echo the key. Only reached when the client sent a valid
    // Idempotency-Key on a first request; normal POSTs keep the streaming path
    // below untouched.
    if (idempotency?.kind === 'proceed') {
      const bodyBytes = response.body ? await response.arrayBuffer() : new ArrayBuffer(0);
      mergedHeaders.set(IDEMPOTENCY_HEADER, idempotency.key);
      mergedHeaders.set(IDEMPOTENT_REPLAYED_HEADER, 'false');
      // Awaited (not waitUntil'd) so a sub-second retry sees the completed
      // record rather than a lingering 'processing' lock → 409. store() is
      // best-effort/fail-open, so a Redis blip degrades to a re-executable
      // retry, never a failed response.
      // Generated response-envelope RPCs can report a retryable ServiceError
      // inside HTTP 200. Feed store() a retryable status only for its
      // persist-vs-release decision; the client still receives finalStatus.
      await idempotency.store(
        retryableResponse ? 503 : finalStatus,
        bodyBytes,
        response.headers.get('content-type'),
      );
      emitRequest(finalStatus, 'ok', resolvedCacheTier, bodyBytes.byteLength);
      maybeAttachDevHealthHeader(mergedHeaders);
      return new Response(bodyBytes, {
        status: finalStatus,
        statusText: response.statusText,
        headers: mergedHeaders,
      });
    }

    // Streaming/non-GET-200 responses: res_bytes is best-effort 0 (Content-Length
    // is often absent on chunked responses; teeing the stream would add latency).
    const finalContentLen = response.headers.get('content-length');
    const finalResBytes = finalContentLen ? Number(finalContentLen) || 0 : 0;
    emitRequest(finalStatus, 'ok', resolvedCacheTier, finalResBytes);
    maybeAttachDevHealthHeader(mergedHeaders);
    return new Response(response.body, {
      status: finalStatus,
      statusText: response.statusText,
      headers: mergedHeaders,
    });
  }

  return async function handler(originalRequest: Request, ctx?: GatewayCtx): Promise<Response> {
    let response: Response;
    try {
      response = await dispatch(originalRequest, ctx);
    } catch (err) {
      // dispatch() threw after charging a direct-LLM reservation and before
      // producing a response: nothing was served, so the slot goes back.
      const rollback = pendingDirectLlmReservations.get(originalRequest);
      if (rollback) {
        pendingDirectLlmReservations.delete(originalRequest);
        await rollback();
      }
      throw err;
    }
    pendingDirectLlmReservations.delete(originalRequest);
    return originalRequest.method === 'HEAD' ? toHeadResponse(response) : response;
  };
}
