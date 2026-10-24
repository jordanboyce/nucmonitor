import { bucketPanelKeyForAnalytics } from '@/utils/analytics-panel-key';
export { bucketPanelKeyForAnalytics } from '@/utils/analytics-panel-key';
/**
 * Analytics facade — wired to Umami.
 *
 * Dashboard analytics load after first paint; calls made before the script
 * arrives are kept in a small bounded queue and replayed on script load.
 */

import { scheduleAfterFirstPaint } from '@/utils/after-paint';
import { subscribeAuthState, type AuthSession } from './auth-state';
import { getClerkUserCreatedAt } from './clerk';
import { SITE_VARIANT } from '@/config/variant';
import {
  collectorFailureFromError,
  configureCollectorTransport,
  installCollectorFetchGate,
  isRetryableIdentityFailure,
  observeCollectorDelivery,
  resetCollectorTransportForTesting,
} from './analytics-collector-transport';
import {
  getContentAttributionAnalyticsFields,
  getContentAttributionForAnalytics,
  withContentAttribution,
} from '../../shared/content-attribution';
import { MISSION_PRESET_IDS } from '../../shared/mission-domain';
import { redactSensitiveUrl } from '../../shared/sensitive-url-params';
// Umami is opt-in: a deployment sets VITE_UMAMI_SCRIPT_URL (the tracker
// script on its own Umami host) and VITE_UMAMI_WEBSITE_ID. Without both, no
// analytics script is ever loaded and track() calls are dropped on the floor.
// Node test runners have no import.meta.env; they configure the tracker
// through process.env instead (scripts/run-data-tests.mjs).
const ANALYTICS_ENV: Partial<ImportMetaEnv> = import.meta.env
  ?? ((typeof process !== 'undefined' ? process.env : {}) as Partial<ImportMetaEnv>);
const UMAMI_SCRIPT_SRC = String(ANALYTICS_ENV.VITE_UMAMI_SCRIPT_URL ?? '').trim();
const UMAMI_COLLECTOR_ENDPOINT = (() => {
  try { return UMAMI_SCRIPT_SRC ? new URL('/api/send', UMAMI_SCRIPT_SRC).href : ''; } catch { return ''; }
})();
const UMAMI_WEBSITE_ID = String(ANALYTICS_ENV.VITE_UMAMI_WEBSITE_ID ?? '').trim();
export const ANALYTICS_CONFIGURED = Boolean(UMAMI_SCRIPT_SRC && UMAMI_WEBSITE_ID);
// data-domains is temporarily reduced to the worldmonitor.app and nuclear hosts
// while upstream Umami issue #4183 (https://github.com/umami-software/umami/issues/4183)
// is open — v3.1.0 has a race in prisma.sessionData.updateMany() that returns HTTP 500
// from /api/send for 4-8% of requests across all listed hosts. Self-hosted Umami has no
// fix tag yet (master since 2026-04-17 has 22 commits but none touch sessionData). The
// tracker self-disables when the current hostname isn't in data-domains — the same
// mechanism that keeps energy.worldmonitor.app silent. Restore tech, finance, and
// commodity once #4183 ships in a tagged release.
//
// www.worldmonitor.app MUST be listed alongside the apex (#4931): the apex 301s
// to www in production, and the tracker's data-domains check is an EXACT
// hostname match (`!domains.includes(hostname)` → disabled) — with only the
// apex listed, every event from the canonical host was silently dropped.
// finance re-added 2026-09-04 (option 2, mission-funnel measurement): the
// finance-only nq-day-trader mission was invisible to the funnel with the
// tracker self-disabled there. Upstream #4183 still drops 4-8% of /api/send
// on affected hosts — accepted noise. tech/commodity stay out until #4183 ships.
// Optional exact-hostname list the tracker self-limits to (VITE_UMAMI_DOMAINS,
// comma-separated). Empty means the tracker runs on whatever host serves it.
const UMAMI_DOMAINS = String(ANALYTICS_ENV.VITE_UMAMI_DOMAINS ?? '').trim();
const UMAMI_QUEUE_LIMIT = 50;
const UMAMI_BEFORE_SEND_HOOK = '__wmUmamiBeforeSend';

/** Umami `data-before-send` hook: strip the shared sensitive-param list from
 * the payload's url and referrer. Returns the payload itself when clean. */
function redactUmamiPayload(_type: string, payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const record = payload as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  for (const field of ['url', 'referrer'] as const) {
    const raw = record[field];
    if (typeof raw !== 'string') continue;
    const redacted = redactSensitiveUrl(raw, window.location?.origin);
    if (redacted !== raw) {
      next ??= { ...record };
      next[field] = redacted;
    }
  }
  return next ?? payload;
}
const UMAMI_LOAD_ATTEMPT_LIMIT = 2;
const UMAMI_LOAD_RETRY_DELAY_MS = 5_000;
const UMAMI_IDENTIFY_RETRY_LIMIT = 2;
const UMAMI_IDENTIFY_RETRY_BASE_DELAY_MS = 1_000;
type QueuedUmamiCall =
  | { kind: 'track'; event: UmamiEvent; data?: Record<string, unknown> }
  | {
      kind: 'identify';
      data: Record<string, unknown>;
      revision: number;
      retryAttempt: number;
    };
type IdentifyCall = Extract<QueuedUmamiCall, { kind: 'identify' }>;

const pendingUmamiCalls: QueuedUmamiCall[] = [];
let umamiLoadScheduled = false;
let umamiLoadStarted = false;
let umamiLoadAttempts = 0;
let latestIdentityRevision = 0;
let identifyRetryTimer: ReturnType<typeof setTimeout> | null = null;
let identifyInFlight = false;
let pendingIdentityCall: IdentifyCall | null = null;
let identifyDeliveryGeneration = 0;

// ---------------------------------------------------------------------------
// Type-safe event catalog — every event name lives here.
// Typo in an event string = compile error.
// ---------------------------------------------------------------------------

const EVENTS = {
  // Search
  'search-open': true,
  'search-used': true,
  'search-result-selected': true,
  // Country / map
  'country-selected': true,
  'country-brief-opened': true,
  'map-layer-toggle': true,
  // Panels
  'panel-toggle': true,
  'layout-customize': true,
  // Settings
  'settings-open': true,
  'variant-switch': true,
  'theme-changed': true,
  'language-change': true,
  'feature-toggle': true,
  // News
  'news-sort-toggle': true,
  'news-summarize': true,
  'live-news-fullscreen': true,
  'live-media-idle-stopped': true,
  'live-media-idle-notice-action': true,
  'live-video-attempt-failed': true,
  'live-video-signal-missing': true,
  'live-video-resolved-applied': true,
  // Webcams
  'webcam-selected': true,
  'webcam-region-filter': true,
  'webcam-fullscreen': true,
  // Downloads / banners
  'download-clicked': true,
  'critical-banner': true,
  // AI widget
  'widget-ai-open': true,
  'widget-ai-generate': true,
  'widget-ai-success': true,
  // WM Analyst dashboard control
  'analyst-control-action': true,
  // MCP
  'mcp-connect-attempt': true,
  'mcp-connect-success': true,
  'mcp-panel-add': true,
  // WebMCP (in-page agent tool surface)
  'webmcp-registered': true,
  'webmcp-registration-failed': true,
  'webmcp-tool-invoked': true,
  // Route Explorer
  'route-explorer:opened': true,
  'route-explorer:query': true,
  'route-explorer:tab-switch': true,
  'route-explorer:alternative-selected': true,
  'route-explorer:impact-viewed': true,
  'route-explorer:share-copied': true,
  'route-explorer:free-cta-click': true,
  'route-explorer:closed': true,
  // Auth (wired in PR #1812 — do not remove)
  'sign-in': true,
  'sign-up': true,
  'sign-out': true,
  'content-handoff': true,
  // Brief — open-rate lift measurement for U10's followed-country bias
  // (followed-countries plan U11). Fired from the dashboard cover card
  // and from the hosted magazine source-link clicks. `followed` flags
  // whether the click target maps to a country the user follows;
  // correlate with non-followed threads to size the bias's effect.
  'brief-thread-open': true,
  // Mission funnel (ONBOARDING_STRATEGY.md, plan 2026-08-30-001).
  // Picker -> selection -> panel views. `panel-viewed` is global (the funnel
  // needs a denominator) but deduped per panel per tab session inside
  // trackPanelView, so volume stays bounded.
  'mission-picker-shown': true,
  'mission-selected': true,
  'panel-viewed': true,
} as const;

export type UmamiEvent = keyof typeof EVENTS;

configureCollectorTransport({
  endpoint: UMAMI_COLLECTOR_ENDPOINT,
  healthEndpoint: '/api/analytics-health',
  isCriticalEvent: () => false,
  onOutcome: () => {},
});

function queueUmamiCall(call: QueuedUmamiCall): void {
  // Identity is a latest-snapshot write, not an append-only event. Auth and
  // billing can both publish before the deferred tracker loads; replaying every
  // intermediate snapshot concurrently is both wasteful and the trigger for
  // Umami #4183's sessionData race. Keep only the newest queued identity.
  if (call.kind === 'identify') {
    for (let index = pendingUmamiCalls.length - 1; index >= 0; index -= 1) {
      if (pendingUmamiCalls[index]?.kind === 'identify') {
        pendingUmamiCalls.splice(index, 1);
      }
    }
  }
  if (pendingUmamiCalls.length >= UMAMI_QUEUE_LIMIT) {
    pendingUmamiCalls.shift();
  }
  pendingUmamiCalls.push(call);
}

function clearScheduledIdentityRetry(): void {
  if (identifyRetryTimer !== null) {
    clearTimeout(identifyRetryTimer);
    identifyRetryTimer = null;
  }
}

function createIdentifyCall(data: Record<string, unknown>): QueuedUmamiCall {
  latestIdentityRevision += 1;
  clearScheduledIdentityRetry();
  return {
    kind: 'identify',
    data,
    revision: latestIdentityRevision,
    retryAttempt: 0,
  };
}

function scheduleIdentityRetry(call: IdentifyCall): void {
  if (call.revision !== latestIdentityRevision) return;
  if (call.retryAttempt >= UMAMI_IDENTIFY_RETRY_LIMIT) return;

  clearScheduledIdentityRetry();
  const generation = identifyDeliveryGeneration;
  const retryCall = {
    ...call,
    retryAttempt: call.retryAttempt + 1,
  };
  const delay = UMAMI_IDENTIFY_RETRY_BASE_DELAY_MS * (2 ** call.retryAttempt);
  identifyRetryTimer = setTimeout(() => {
    identifyRetryTimer = null;
    if (generation !== identifyDeliveryGeneration) return;
    if (retryCall.revision !== latestIdentityRevision) return;
    if (!sendUmamiCall(retryCall)) {
      queueUmamiCall(retryCall);
    }
  }, delay);
}

/**
 * Umami v3.1.0 swallows its own fetch and JSON failures, including HTTP 500s,
 * so its public tracker promises do not tell us whether the collector accepted
 * a write. The installed transport gate reports the real outcome of the beacon
 * the tracker issues; `observeCollectorDelivery` attributes that outcome to
 * this call WITHOUT wrapping `window.fetch` a second time.
 *
 * `observed: false` means no collector write was attributed — the gate is not
 * installed, or the tracker deferred its beacon past the synchronous window.
 * That is an ABSENCE of signal, never a success.
 */
function invokeWithDelivery(
  invoke: () => unknown,
  requestType: 'event' | 'identify',
): { observed: boolean; result: unknown } {
  return observeCollectorDelivery(invoke, requestType);
}

function finishIdentityDelivery(call: IdentifyCall, generation: number, error?: unknown): void {
  if (generation !== identifyDeliveryGeneration) return;

  identifyInFlight = false;
  const nextCall = pendingIdentityCall;
  pendingIdentityCall = null;
  if (nextCall) {
    if (!sendUmamiCall(nextCall)) {
      queueUmamiCall(nextCall);
    }
    return;
  }
  // Identity is an idempotent latest-snapshot write, so it uses the broader
  // retry policy that still covers HTTP 500 — the failure #5715 was opened for.
  // The narrow conversion policy (which excludes 500) exists to avoid
  // double-counting an append-only event and does not apply here.
  if (error && isRetryableIdentityFailure(collectorFailureFromError(error))) {
    scheduleIdentityRetry(call);
  }
}

function sendIdentityCall(
  call: IdentifyCall,
  umami: NonNullable<Window['umami']>,
): boolean {
  // Umami stores each identity field independently with an update-then-create
  // sequence. Keep a single collector write active and retain only the latest
  // snapshot received during that write so auth and billing cannot race the
  // same sessionData key.
  if (identifyInFlight) {
    pendingIdentityCall = call;
    return true;
  }

  identifyInFlight = true;
  const generation = identifyDeliveryGeneration;
  try {
    const { result } = invokeWithDelivery(() => umami.identify(call.data), 'identify');
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).then(
        () => finishIdentityDelivery(call, generation),
        (error) => finishIdentityDelivery(call, generation, error),
      );
    } else {
      finishIdentityDelivery(call, generation);
    }
  } catch (error) {
    finishIdentityDelivery(call, generation, error);
  }
  return true;
}

function sendUmamiCall(call: QueuedUmamiCall): boolean {
  if (typeof window === 'undefined') return false;
  const umami = window.umami;
  if (!umami) return false;
  installCollectorFetchGate();
  if (call.kind === 'identify') {
    return sendIdentityCall(call, umami);
  }
  try {
    const result: unknown = umami.track(call.event, call.data);
    if (result && typeof (result as { catch?: unknown }).catch === 'function') {
      void (result as Promise<unknown>).catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

function flushPendingUmamiCalls(): void {
  if (pendingUmamiCalls.length === 0) return;
  if (typeof window === 'undefined' || !window.umami) return;
  installCollectorFetchGate();
  const calls = pendingUmamiCalls.splice(0, pendingUmamiCalls.length);
  for (const call of calls) sendUmamiCall(call);
}

function loadUmamiScript(): void {
  if (umamiLoadStarted || typeof document === 'undefined') return;
  installCollectorFetchGate();
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${UMAMI_SCRIPT_SRC}"]`);
  if (existing) {
    // A script tag already exists (e.g. re-entry after a soft navigation).
    // Mark load as started so the guard above short-circuits future calls.
    // If Umami already initialised, flush now; otherwise wait for its load
    // event. Flushing unconditionally before window.umami is set is a no-op
    // and a dead {once:true} listener if load already fired.
    umamiLoadStarted = true;
    if (typeof window !== 'undefined' && window.umami) {
      flushPendingUmamiCalls();
    } else {
      existing.addEventListener('load', flushPendingUmamiCalls, { once: true });
    }
    return;
  }

  umamiLoadStarted = true;
  umamiLoadAttempts += 1;
  const script = document.createElement('script');
  script.async = true;
  script.src = UMAMI_SCRIPT_SRC;
  script.dataset.websiteId = UMAMI_WEBSITE_ID;
  if (UMAMI_DOMAINS) script.dataset.domains = UMAMI_DOMAINS;
  // Deferred consumers keep invite, checkout, referral, and Clerk params in
  // the live URL until they read them; Umami payloads must not copy those.
  // Redact per payload rather than data-exclude-search, which would also
  // drop the utm_* params campaign attribution reads.
  (window as unknown as Record<string, unknown>)[UMAMI_BEFORE_SEND_HOOK] = redactUmamiPayload;
  script.dataset.beforeSend = UMAMI_BEFORE_SEND_HOOK;
  script.addEventListener('load', flushPendingUmamiCalls, { once: true });
  script.addEventListener('error', () => {
    umamiLoadStarted = false;
    script.remove();
    if (umamiLoadAttempts < UMAMI_LOAD_ATTEMPT_LIMIT) {
      setTimeout(loadUmamiScript, UMAMI_LOAD_RETRY_DELAY_MS);
    }
  }, { once: true });
  document.head.appendChild(script);
}

/** Type-safe Umami wrapper. Safe to call even if the script hasn't loaded. */
export function track(event: UmamiEvent, data?: Record<string, unknown>): void {
  const enrichedData = withContentAttribution(data, getContentAttributionForAnalytics());
  if (!sendUmamiCall({ kind: 'track', event, data: enrichedData })) {
    queueUmamiCall({ kind: 'track', event, data: enrichedData });
  }
}

/**
 * Sends a deliberately closed telemetry payload without automatic content
 * attribution. Agent search uses this path because #6212 permits only its
 * explicit tool/outcome and aggregate search fields.
 */
export function trackPrivacyRestricted(
  event: UmamiEvent,
  data?: Record<string, unknown>,
): void {
  if (!sendUmamiCall({ kind: 'track', event, data })) {
    queueUmamiCall({ kind: 'track', event, data });
  }
}

/** Fire once for a freshly captured content landing, not on every reload. */
export function trackContentHandoff(): void {
  const attribution = getContentAttributionForAnalytics();
  if (!attribution) return;
  track('content-handoff', getContentAttributionAnalyticsFields(attribution));
}

export function initAnalytics(): void {
  if (!ANALYTICS_CONFIGURED) return;
  if (umamiLoadScheduled || typeof window === 'undefined' || typeof document === 'undefined') return;
  umamiLoadScheduled = true;
  scheduleAfterFirstPaint(loadUmamiScript, 3000);
}

// ---------------------------------------------------------------------------
// User identity — call after auth state resolves so Umami can segment events
// by user. Safe to call before Umami script loads.
// ---------------------------------------------------------------------------

export function identifyUser(userId: string): void {
  const call = createIdentifyCall({ userId });
  if (!sendUmamiCall(call)) {
    queueUmamiCall(call);
  }
}

export function clearIdentity(): void {
  const call = createIdentifyCall({});
  if (!sendUmamiCall(call)) {
    queueUmamiCall(call);
  }
}

let _unsubAuth: (() => void) | null = null;

let _lastAuth: AuthSession | null = null;

function _syncIdentity(): void {
  const user = _lastAuth?.user;
  if (user) {
    identifyUser(user.id);
  } else {
    clearIdentity();
  }
}

/**
 * Call once after initAuthState() to keep Umami identity in sync with
 * the authenticated user.
 * Re-entrant safe: subsequent calls are no-ops.
 */
export function initAuthAnalytics(): void {
  if (_unsubAuth) return;

  _unsubAuth = subscribeAuthState((state) => {
    const prevUserId = _lastAuth?.user?.id ?? null;
    const nextUserId = state.user?.id ?? null;
    if (prevUserId !== nextUserId) {
      // Detect a genuine sign-UP (not a sign-in). Null→non-null id transition
      // plus a createdAt within FRESH_SIGNUP_WINDOW_MS of now means Clerk
      // just created this account. Firing trackSignUp on the button click
      // would conflate "opened the sign-up modal" with "completed the flow";
      // gating on createdAt freshness captures the successful-completion
      // signal we actually want to measure.
      //
      // Durable fire-once guard: `_lastAuth` resets to null on every page
      // load, so without a persisted marker the null→user transition looks
      // identical on the completion reload and on any reload within the
      // 60s freshness window. We'd re-fire trackSignUp on every tab
      // refresh until createdAt ages out, inflating the signup count.
      // sessionStorage scopes the marker to the browser tab — tight enough
      // that re-install / new session reliably re-counts, wide enough that
      // a reload mid-signup doesn't double-count.
      if (
        nextUserId !== null &&
        !hasTrackedSignupInSession(nextUserId) &&
        isLikelyFreshSignup(prevUserId, nextUserId, getClerkUserCreatedAt(), Date.now())
      ) {
        trackSignUp('clerk');
        markSignupTrackedInSession(nextUserId);
      }
    }
    _lastAuth = state;
    _syncIdentity();
  });
}

/** Tear down the auth listener. Symmetric with initAuthAnalytics(). */
export function destroyAuthAnalytics(): void {
  _unsubAuth?.();
  _unsubAuth = null;
  _lastAuth = null;
  clearIdentity();
}

// ---------------------------------------------------------------------------
// Auth events
// ---------------------------------------------------------------------------

export function trackSignIn(method: string): void {
  track('sign-in', { method });
}

export function trackSignUp(method: string): void {
  track('sign-up', { method });
}

export function trackAnalystControlAction(actionType: string, status: string, reason?: string): void {
  track('analyst-control-action', {
    actionType,
    status,
    ...(reason ? { reason } : {}),
  });
}

/**
 * Window during which a freshly-observed Clerk `createdAt` is treated
 * as "this user just signed up." 60s is conservative enough to survive
 * network jitter between Clerk's user.created and the client seeing
 * the auth-state transition, while staying tight enough to reject
 * returning-user sign-ins on accounts created weeks ago.
 */
export const FRESH_SIGNUP_WINDOW_MS = 60_000;

/**
 * Pure predicate: was the just-observed auth transition a fresh sign-up?
 *
 * Exported for testability. Do not read Date.now() or Clerk state from
 * inside this function — callers pass both, so tests can pin time and
 * user state.
 */
/**
 * Lower bound for clock skew. A createdAt earlier-than-now by up to
 * this amount is treated as "now" for freshness purposes — tolerates
 * client clocks that lag the server. Bigger negatives (createdAt
 * unrealistically far in the future) are rejected as malformed.
 */
const FRESH_SIGNUP_CLOCK_SKEW_MS = 5_000;

/**
 * localStorage-backed fire-once guard, keyed by user id. Originally used
 * sessionStorage but sessionStorage is per-TAB — a user who signs up and
 * then opens a second tab on the app within the 60s createdAt freshness
 * window would fire a second trackSignUp from that fresh tab's
 * `_lastAuth=null → user` transition. localStorage is shared across
 * tabs in the same browser profile, so once any tab marks the user as
 * tracked, no other tab for the same user will re-fire.
 *
 * Keyed per user id so account switches within the same browser still
 * correctly track each user's first signup (rare but valid). The key
 * never needs to be cleaned up because Clerk user ids are effectively
 * unique forever — a deleted user's key is harmless and the storage
 * footprint is trivial (one byte per user who ever signed up here).
 *
 * Read/write are try/catched because storage throws in private-mode /
 * quota-exceeded / disabled scenarios; we fail open (track, don't
 * persist) rather than swallow signups.
 */
const SIGNUP_TRACKED_KEY_PREFIX = 'wm-signup-tracked:';

export function hasTrackedSignupInSession(userId: string): boolean {
  try {
    return window.localStorage.getItem(SIGNUP_TRACKED_KEY_PREFIX + userId) === '1';
  } catch {
    return false;
  }
}

export function markSignupTrackedInSession(userId: string): void {
  try {
    window.localStorage.setItem(SIGNUP_TRACKED_KEY_PREFIX + userId, '1');
  } catch {
    // Storage unavailable — we'll just risk a single double-count on
    // reload instead of crashing analytics init.
  }
}

export function isLikelyFreshSignup(
  prevUserId: string | null,
  nextUserId: string | null,
  createdAtMs: number | null,
  nowMs: number,
): boolean {
  if (prevUserId !== null) return false;
  if (nextUserId === null) return false;
  if (createdAtMs === null) return false;
  const age = nowMs - createdAtMs;
  // Accept:   -5s  ≤ age ≤ 60s  (brief clock skew tolerance + fresh window)
  // Reject: < -5s (createdAt unrealistically far in the future — malformed)
  //         > 60s (returning user, not a fresh signup)
  return age >= -FRESH_SIGNUP_CLOCK_SKEW_MS && age <= FRESH_SIGNUP_WINDOW_MS;
}

export function trackSignOut(): void {
  track('sign-out');
}

/**
 * Test-only: reset module-level deferred-load state so each test starts from
 * a clean slate. The queue and load guards are module singletons that persist
 * across the shared module import in tests/secondary-startup.test.mts.
 */
export function resetAnalyticsForTesting(): void {
  resetCollectorTransportForTesting();
  clearScheduledIdentityRetry();
  identifyDeliveryGeneration += 1;
  identifyInFlight = false;
  pendingIdentityCall = null;
  pendingUmamiCalls.length = 0;
  umamiLoadScheduled = false;
  umamiLoadStarted = false;
  umamiLoadAttempts = 0;
  latestIdentityRevision = 0;
  layoutCustomizationsSent.clear();
}

// ---------------------------------------------------------------------------
// Generic (kept as no-ops — too noisy / not useful in Umami)
// ---------------------------------------------------------------------------

export function trackEvent(_name: string, _props?: Record<string, unknown>): void {}
export function trackEventBeforeUnload(_name: string, _props?: Record<string, unknown>): void {}

// ---------------------------------------------------------------------------
// Mission conversion funnel (ONBOARDING_STRATEGY.md, plan 2026-08-30-001)
// ---------------------------------------------------------------------------

/**
 * Keep 768 in sync with MOBILE_BREAKPOINT_PX in src/utils/index.ts (and the
 * matching media query noted in src/styles/main.css). Duplicated literally
 * rather than imported so the analytics module graph stays free of the utils
 * barrel, which is not safely importable under node for tests.
 */
const MISSION_FUNNEL_MOBILE_BREAKPOINT_PX = 768;

function analyticsDeviceClass(): 'mobile' | 'desktop' {
  if (typeof window === 'undefined') return 'desktop';
  return window.innerWidth <= MISSION_FUNNEL_MOBILE_BREAKPOINT_PX ? 'mobile' : 'desktop';
}

/**
 * Mission-id vocabulary and storage key, duplicated literally from
 * src/services/mission-presets.ts and pinned against it by
 * tests/mission-funnel-events.test.mts. Importing mission-presets here would
 * drag config/panels' side-effectful chain (runtime-config registers window
 * listeners at import) into the analytics module graph — the same reason
 * KNOWN_PRODUCT_IDS is a separate generated module (#5165).
 */
const MISSION_PRESET_STORAGE_KEY = 'worldmonitor-mission-preset-v1';
const KNOWN_MISSION_IDS = new Set<string>(MISSION_PRESET_IDS);

/** Unknown mission ids collapse to 'unknown' — closed vocabulary, like productId. */
export function bucketMissionIdForAnalytics(missionId: string): string {
  return KNOWN_MISSION_IDS.has(missionId) ? missionId : 'unknown';
}


/**
 * Shared context fields for every mission-funnel event: the active mission (if
 * any), the site variant, and the device class. The stored mission id is
 * validated against the closed vocabulary, so a corrupted localStorage value
 * reads as absent rather than flowing to Umami.
 */
function missionFunnelFields(): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    variant: SITE_VARIANT,
    deviceClass: analyticsDeviceClass(),
  };
  try {
    const stored = window.localStorage.getItem(MISSION_PRESET_STORAGE_KEY);
    if (stored && KNOWN_MISSION_IDS.has(stored)) fields.missionId = stored;
  } catch {
    // Storage denied — the event still carries variant + device class.
  }
  return fields;
}

/**
 * Session-scoped dedupe for panel-viewed (KTD5): a panel fires once per tab
 * session, not once per page load, so reload-heavy dashboard sessions do not
 * multiply the funnel denominator. sessionStorage is per-tab; when it is
 * unavailable the in-memory set still bounds a single page's emissions.
 */
const PANEL_VIEWED_SESSION_KEY = 'wm-panel-viewed-v1';
const PANEL_VIEWED_SESSION_LIMIT = 400;
let viewedPanelsMemory = new Set<string>();

function readViewedPanelsFromSession(): string[] {
  try {
    const raw = window.sessionStorage.getItem(PANEL_VIEWED_SESSION_KEY);
    if (!raw) return [];
    const items: unknown = JSON.parse(raw);
    return Array.isArray(items) ? items.filter((i): i is string => typeof i === 'string') : [];
  } catch {
    return [];
  }
}

function rememberViewedPanel(panelId: string): void {
  viewedPanelsMemory.add(panelId);
  try {
    const items = readViewedPanelsFromSession();
    items.push(panelId);
    window.sessionStorage.setItem(
      PANEL_VIEWED_SESSION_KEY,
      JSON.stringify(items.slice(-PANEL_VIEWED_SESSION_LIMIT)),
    );
  } catch {
    // Storage denied — the in-memory set still dedupes this page.
  }
}

function hasViewedPanel(panelId: string): boolean {
  if (viewedPanelsMemory.has(panelId)) return true;
  return readViewedPanelsFromSession().includes(panelId);
}

/** `keepSession: true` clears only the in-memory set — simulates a page reload. */
export function resetMissionFunnelAnalyticsForTesting(opts?: { keepSession?: boolean }): void {
  viewedPanelsMemory = new Set();
  if (opts?.keepSession) return;
  try {
    window.sessionStorage.removeItem(PANEL_VIEWED_SESSION_KEY);
  } catch {
    // ignore
  }
}

/**
 * Real emitter for the former no-op: one event per panel per tab session,
 * carrying the funnel context. Callers (the IntersectionObserver in
 * event-handlers) may keep their own cheap in-memory dedupe; the authoritative
 * session dedupe lives here so every caller gets it.
 */
export function trackPanelView(panelId: string): void {
  if (hasViewedPanel(panelId)) return;
  rememberViewedPanel(panelId);
  track('panel-viewed', { panelKey: bucketPanelKeyForAnalytics(panelId), ...missionFunnelFields() });
}

export type MissionPickerTrigger = 'auto' | 'manual' | 'agent';

export function trackMissionPickerShown(
  trigger: MissionPickerTrigger,
  surface: 'desktop' | 'mobile',
): void {
  track('mission-picker-shown', { trigger, surface, ...missionFunnelFields() });
}

/** `source: 'agent'` marks WebMCP-applied presets so the human funnel can be read clean. */
export function trackMissionSelected(missionId: string, source: 'user' | 'agent' = 'user'): void {
  track('mission-selected', {
    ...missionFunnelFields(),
    missionId: bucketMissionIdForAnalytics(missionId),
    source,
  });
}

export function trackUpdateShown(_current: string, _remote: string): void {}
export function trackUpdateClicked(_version: string): void {}
export function trackUpdateDismissed(_version: string): void {}
export function trackDownloadBannerDismissed(): void {}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function trackSearchUsed(queryLength: number, resultCount: number): void {
  track('search-used', { queryLength, resultCount });
}

export function trackSearchResultSelected(
  resultType: string,
  options?: { includeAttribution?: boolean },
): void {
  const tracker = options?.includeAttribution === false ? trackPrivacyRestricted : track;
  tracker('search-result-selected', { type: resultType });
}

// ---------------------------------------------------------------------------
// Country / map
// ---------------------------------------------------------------------------

export function trackCountrySelected(code: string, name: string, source: string): void {
  track('country-selected', { code, name, source });
}

export function trackCountryBriefOpened(countryCode: string): void {
  track('country-brief-opened', { code: countryCode });
}

// ---------------------------------------------------------------------------
// Brief thread-open (followed-countries plan, U11)
// ---------------------------------------------------------------------------

export type BriefThreadOpenSeverity =
  | 'critical'
  | 'high'
  | 'medium'
  | 'low'
  | 'info'
  | null;

export interface BriefThreadOpenProps {
  /** ISO-2 country code, or null when no primary country attaches. */
  country: string | null;
  /** True iff the user follows `country` at click time. */
  followed: boolean;
  severity: BriefThreadOpenSeverity;
  /** Where the click originated. */
  source: 'dashboard' | 'magazine';
}

/**
 * Fire-and-forget: `track` short-circuits when Umami hasn't loaded.
 * Wrap call sites in try/catch anyway so a future regression in
 * `track` (e.g. throwing identify) cannot break navigation UX.
 */
export function trackBriefThreadOpen(props: BriefThreadOpenProps): void {
  track('brief-thread-open', {
    country: props.country,
    followed: props.followed,
    severity: props.severity,
    source: props.source,
  });
}

export function trackMapLayerToggle(layerId: string, enabled: boolean, source: 'user' | 'programmatic'): void {
  if (source !== 'user') return;
  track('map-layer-toggle', { layerId, enabled });
}

export function trackMapViewChange(_view: string): void {
  // No-op: low analytical value.
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

export function trackPanelToggled(panelId: string, enabled: boolean): void {
  track('panel-toggle', { panelId, enabled });
}

export type LayoutCustomizationKind = 'panel-resize' | 'panel-reorder' | 'map-divider';

// Once per page load per kind: the metric is the share of sessions that ever
// customize, and it keeps held arrow keys on a resize handle from spamming.
const layoutCustomizationsSent = new Set<LayoutCustomizationKind>();

export function trackLayoutCustomized(kind: LayoutCustomizationKind): void {
  if (layoutCustomizationsSent.has(kind)) return;
  layoutCustomizationsSent.add(kind);
  track('layout-customize', { kind });
}

// ---------------------------------------------------------------------------
// App-wide settings
// ---------------------------------------------------------------------------

export function trackVariantSwitch(from: string, to: string): void {
  track('variant-switch', { from, to });
}

export function trackThemeChanged(theme: string): void {
  track('theme-changed', { theme });
}

export function trackLanguageChange(language: string): void {
  track('language-change', { language });
}

export function trackFeatureToggle(featureId: string, enabled: boolean): void {
  track('feature-toggle', { featureId, enabled });
}

// ---------------------------------------------------------------------------
// AI / LLM
// ---------------------------------------------------------------------------

export function trackLLMUsage(_provider: string, _model: string, _cached: boolean): void {
  // No-op: per-request noise, not a meaningful user action for analytics.
}

export function trackLLMFailure(_lastProvider: string): void {
  // No-op: per-request noise, not a meaningful user action for analytics.
}

// ---------------------------------------------------------------------------
// Webcams
// ---------------------------------------------------------------------------

export function trackWebcamSelected(webcamId: string, city: string, viewMode: string): void {
  track('webcam-selected', { webcamId, city, viewMode });
}

export function trackWebcamRegionFiltered(region: string): void {
  track('webcam-region-filter', { region });
}

// ---------------------------------------------------------------------------
// Downloads / banners / findings
// ---------------------------------------------------------------------------

export function trackDownloadClicked(platform: string): void {
  track('download-clicked', { platform });
}

export function trackCriticalBannerAction(action: string, theaterId: string): void {
  track('critical-banner', { action, theaterId });
}

export function trackFindingClicked(_id: string, _source: string, _type: string, _priority: string): void {
  // No-op: niche feature, low analytical value.
}

export function trackDeeplinkOpened(_type: string, _target: string): void {
  // No-op: not useful for analytics.
}
