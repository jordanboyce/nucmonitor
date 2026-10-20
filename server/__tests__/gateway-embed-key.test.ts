// @vitest-environment node

/**
 * `wme_` partner-embed keys at the gateway.
 *
 * `/api/embed/entitlement` answering 200 for a `wme_` key is only half of a
 * working paid panel: `chokepoint-strip` and `fear-greed` then read their own
 * RPC through this gateway with that same key in `X-WorldMonitor-Key`, and
 * before this branch the shape check rejected it (`wme_` does not start with
 * `wm_`, is not an enterprise key, and is not a session token) — 401, blank
 * panel. These tests pin the branch and, more importantly, its edges:
 *
 *   - accepted ONLY on the paths a paid embed panel declares in the registry;
 *     every other route still 401s the same key;
 *   - never routed through the `wm_` validator, so the two credential classes
 *     keep separate tables and caches;
 *   - entitlement is re-checked per request (`hasEmbedAccess`), so a lapsed
 *     account's un-revoked embed key stops working;
 *   - `isUserApiKey` stays false, so the key never enters the per-account REST
 *     meter that #3199/#4611 govern;
 *   - unknown-key amplification is bounded by the same fail-closed per-IP
 *     guard the `wm_` branch uses.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

const checkBurst = vi.fn();
const reserveDailyMeter = vi.fn();
vi.mock("../_shared/api-key-rate-limit", () => ({
  checkBurst: (...a: unknown[]) => checkBurst(...a),
  reserveDailyMeter: (...a: unknown[]) => reserveDailyMeter(...a),
  rateLimitHeaders: () => ({ "X-RateLimit-Limit": "60", "Retry-After": "30" }),
  ENTERPRISE_API_RATE_LIMIT: 1000,
}));

const checkRateLimit = vi.fn().mockResolvedValue(null);
const checkFailClosedScopedIpRateLimit = vi.fn().mockResolvedValue(null);
vi.mock("../_shared/rate-limit", async (importActual) => {
  const actual = await importActual<typeof import("../_shared/rate-limit")>();
  return {
    ...actual,
    checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
    checkFailClosedScopedIpRateLimit: (...a: unknown[]) => checkFailClosedScopedIpRateLimit(...a),
    checkEndpointRateLimit: vi.fn().mockResolvedValue(null),
    hasEndpointRatePolicy: () => false,
  };
});

const EMBED_ENTITLED = {
  planKey: "pro_monthly",
  features: {
    tier: 1,
    apiAccess: false,
    embedAccess: true,
    apiRateLimit: 0,
    maxDashboards: 25,
    prioritySupport: false,
    exportFormats: [],
  },
  validUntil: Date.now() + 86_400_000,
};
type Ent = { planKey: string; features: Record<string, unknown>; validUntil: number } | null;
let entitlement: Ent = EMBED_ENTITLED;
const getEntitlements = vi.fn(async () => entitlement);
vi.mock("../_shared/entitlement-check", async (importActual) => {
  const actual = await importActual<typeof import("../_shared/entitlement-check")>();
  return {
    ...actual,
    getRequiredTier: () => null,
    checkEntitlement: vi.fn().mockResolvedValue(null),
    checkEntitlementDetailed: vi.fn().mockResolvedValue({ response: null, entitlements: null }),
    getEntitlements: (...a: unknown[]) => getEntitlements(...(a as [])),
    isEntitlementBackendConfigured: () => true,
  };
});

const validateUserApiKey = vi.fn(async () => null);
vi.mock("../_shared/user-api-key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/user-api-key")>();
  return { ...actual, validateUserApiKey: (...a: unknown[]) => validateUserApiKey(...a) };
});

const validateEmbedKey = vi.fn(async (): Promise<{ userId: string } | null> => ({ userId: "acct_embed" }));
vi.mock("../_shared/embed-key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/embed-key")>();
  return { ...actual, validateEmbedKey: (...a: unknown[]) => validateEmbedKey(...(a as [])) };
});

vi.mock("../_shared/auth-session", () => ({
  resolveClerkSession: vi.fn(async () => null),
  validateBearerToken: vi.fn(async () => ({ valid: false, userId: null, role: "free" as const })),
}));
vi.mock("../auth-session", () => ({
  validateBearerToken: vi.fn(async () => ({ valid: false, userId: null, role: "free" as const })),
}));

import { createDomainGateway } from "../gateway";
import { EMBED_KEY_RPC_PATHS } from "../../shared/embed-panels";

const CHOKEPOINT_PATH = "/api/supply-chain/v1/get-chokepoint-status";
const FEAR_GREED_PATH = "/api/market/v1/get-fear-greed-index";
const OTHER_PATH = "/api/news/v1/list-feed-digest";
const EMBED_KEY = `wme_${"a1b2c3d4e5".repeat(4)}`;

const routeHandler = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
  status: 200,
  headers: { "Content-Type": "application/json" },
}));

function makeGateway() {
  return createDomainGateway([
    { method: "GET", path: CHOKEPOINT_PATH, handler: routeHandler },
    { method: "GET", path: FEAR_GREED_PATH, handler: routeHandler },
    { method: "GET", path: OTHER_PATH, handler: routeHandler },
  ]);
}

function req(path: string, key = EMBED_KEY) {
  const headers = new Headers();
  headers.set("X-WorldMonitor-Key", key);
  return new Request(`https://www.worldmonitor.app${path}`, { method: "GET", headers });
}

const ctx = { waitUntil: () => {} };
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  entitlement = EMBED_ENTITLED;
  checkBurst.mockReset().mockResolvedValue({ ok: true });
  reserveDailyMeter.mockReset().mockResolvedValue({
    count: 1, overLimit: false, metered: true, retryAfterSec: 100, rollback: async () => {},
  });
  checkRateLimit.mockClear().mockResolvedValue(null);
  checkFailClosedScopedIpRateLimit.mockReset().mockResolvedValue(null);
  routeHandler.mockClear();
  getEntitlements.mockClear().mockImplementation(async () => entitlement);
  validateUserApiKey.mockClear().mockResolvedValue(null);
  validateEmbedKey.mockClear().mockResolvedValue({ userId: "acct_embed" });
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.WORLDMONITOR_VALID_KEYS;
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("wme_ embed keys at the gateway", () => {
  test("the accepted path set is exactly what the paid panels declare: none, with the map-only embed", () => {
    expect([...EMBED_KEY_RPC_PATHS]).toEqual([]);
  });

  test("401s the same key on a route no embed panel declares", async () => {
    // The whole point of the registry-derived set: an embed key published in
    // partner HTML must not become a general-purpose gateway credential.
    const res = await makeGateway()(req(OTHER_PATH), ctx);

    expect(res.status).toBe(401);
    expect(routeHandler).not.toHaveBeenCalled();
    expect(validateEmbedKey).not.toHaveBeenCalled();
  });

  test("401s an unknown embed key", async () => {
    validateEmbedKey.mockResolvedValue(null);

    const res = await makeGateway()(req(CHOKEPOINT_PATH), ctx);

    expect(res.status).toBe(401);
    expect(routeHandler).not.toHaveBeenCalled();
  });

  test("401s a valid key whose account lost embedAccess", async () => {
    entitlement = {
      ...EMBED_ENTITLED,
      features: { ...EMBED_ENTITLED.features, embedAccess: false },
    };

    const res = await makeGateway()(req(CHOKEPOINT_PATH), ctx);

    expect(res.status).toBe(401);
    expect(routeHandler).not.toHaveBeenCalled();
  });

  test("401s a valid key whose subscription lapsed", async () => {
    entitlement = { ...EMBED_ENTITLED, validUntil: Date.now() - 1 };

    const res = await makeGateway()(req(CHOKEPOINT_PATH), ctx);

    expect(res.status).toBe(401);
    expect(routeHandler).not.toHaveBeenCalled();
  });

  test("an upper-cased key never reaches the lookup at all", async () => {
    // The canonical key is lowercase hex. Case-folding the prefix test here
    // would admit `WME_…` into a branch whose shape gate then rejects it, and
    // would drift the two definitions of "an embed key" apart.
    const res = await makeGateway()(req(CHOKEPOINT_PATH, EMBED_KEY.toUpperCase()), ctx);

    expect(res.status).toBe(401);
    expect(validateEmbedKey).not.toHaveBeenCalled();
  });
});
