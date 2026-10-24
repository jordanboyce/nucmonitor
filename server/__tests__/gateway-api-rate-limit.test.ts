// @vitest-environment node

/**
 * U4 (#3199) — gateway wiring for the per-key API rate-limit layer.
 *
 * The only credential this layer governs is an enterprise env key
 * (WORLDMONITOR_VALID_KEYS): a per-key burst plus a daily circuit-breaker
 * meter. The burst/meter math is unit-tested in tests/api-key-rate-limit.test.mts;
 * here we STUB that module and assert only the GATEWAY wiring:
 *   - the global fallback bypass is ENFORCE-only (shadow keeps it active)
 *   - ordering + 429 shape
 *   - an unavailable burst keeps the IP fallback and the daily meter
 *   - anonymous sessions never enter the per-key layer
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// --- Stub the per-key module: control the burst/meter decisions -------------
const checkBurst = vi.fn();
const reserveDailyMeter = vi.fn();
vi.mock("../_shared/api-key-rate-limit", () => ({
  checkBurst: (...a: unknown[]) => checkBurst(...a),
  reserveDailyMeter: (...a: unknown[]) => reserveDailyMeter(...a),
  rateLimitHeaders: () => ({ "X-RateLimit-Limit": "60", "Retry-After": "30" }),
  ENTERPRISE_API_RATE_LIMIT: 1000,
  API_DAILY_TTL_SECONDS: 172_800,
  secondsUntilUtcMidnight: () => 3600,
}));

// --- Stub the global fallback layer: spy whether checkRateLimit runs --------
let endpointPolicy = false;
const checkRateLimit = vi.fn().mockResolvedValue(null);
vi.mock("../_shared/rate-limit", async (importActual) => {
  const actual = await importActual<typeof import("../_shared/rate-limit")>();
  return {
    ...actual,
    checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
    checkEndpointRateLimit: vi.fn().mockResolvedValue(null),
    hasEndpointRatePolicy: () => endpointPolicy,
  };
});

import { createDomainGateway } from "../gateway";
import { hashKeySync } from "../_shared/usage-identity";
import { OPERATOR_KEY_DAILY_CEILINGS } from "../_shared/high-usage-alarm";

const ENTERPRISE_KEY = "enterprise-operator-key";

function makeGateway() {
  return createDomainGateway([
    {
      method: "GET",
      path: "/api/news/v1/list-feed-digest",
      handler: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
  ]);
}

function enterpriseRequest(headers: Record<string, string> = {}) {
  return new Request("https://www.worldmonitor.app/api/news/v1/list-feed-digest", {
    method: "GET",
    headers: { "X-Api-Key": ENTERPRISE_KEY, ...headers },
  });
}

const ctx = { waitUntil: () => {} };
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  endpointPolicy = false;
  process.env.WORLDMONITOR_VALID_KEYS = ENTERPRISE_KEY;
  checkBurst.mockReset().mockResolvedValue({ ok: true });
  reserveDailyMeter.mockReset().mockResolvedValue({
    count: 1,
    overLimit: false,
    metered: true,
    retryAfterSec: 100,
    rollback: async () => {},
  });
  checkRateLimit.mockClear().mockResolvedValue(null);
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("#3199 U4 — gateway per-key rate-limit wiring", () => {
  test("an enterprise key engages the per-key layer, keyed by the hashed key", async () => {
    const res = await makeGateway()(enterpriseRequest(), ctx);
    expect(res.status).toBe(200);
    expect(checkBurst).toHaveBeenCalledWith(1000, hashKeySync(ENTERPRISE_KEY));
    expect(reserveDailyMeter).toHaveBeenCalledWith(expect.objectContaining({
      userId: hashKeySync(ENTERPRISE_KEY),
      allowance: OPERATOR_KEY_DAILY_CEILINGS.restRequests,
    }));
  });

  test("the explicit key header wins over a rotating wms_ session cookie", async () => {
    process.env.API_RATE_LIMIT_ENFORCE = "true";
    const gateway = makeGateway();
    const first = await gateway(enterpriseRequest({ Cookie: "wm-session=wms_first" }), ctx);
    const second = await gateway(enterpriseRequest({ Cookie: "wm-session=wms_second" }), ctx);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(checkBurst.mock.calls.map(([, identity]) => identity)).toEqual([
      hashKeySync(ENTERPRISE_KEY),
      hashKeySync(ENTERPRISE_KEY),
    ]);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  test("ENFORCE + burst trip → 429 and per-IP checkRateLimit is BYPASSED", async () => {
    process.env.API_RATE_LIMIT_ENFORCE = "true";
    checkBurst.mockResolvedValue({ ok: false, limit: 1000, reset: Date.now() + 30_000 });

    const res = await makeGateway()(enterpriseRequest(), ctx);
    expect(res.status).toBe(429);
    expect(checkRateLimit).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body).toMatchObject({ limit: 1000, limit_type: "per_minute" });
    expect(body).not.toHaveProperty("plan");
    expect(body).not.toHaveProperty("upgrade_url");
    expect(typeof body.reset).toBe("string");
  });

  test("SHADOW + burst trip → served (200) and the IP global fallback still runs", async () => {
    delete process.env.API_RATE_LIMIT_ENFORCE; // shadow (default)
    checkBurst.mockResolvedValue({ ok: false, limit: 1000, reset: Date.now() + 30_000 });

    const res = await makeGateway()(enterpriseRequest(), ctx);
    expect(res.status).toBe(200);
    expect(checkRateLimit).toHaveBeenCalledWith(expect.any(Request), expect.any(Object));
  });

  test("ENFORCE + over daily ceiling → 429, meter rolled back, per-IP bypassed", async () => {
    process.env.API_RATE_LIMIT_ENFORCE = "true";
    const rollback = vi.fn(async () => {});
    reserveDailyMeter.mockResolvedValue({
      count: OPERATOR_KEY_DAILY_CEILINGS.restRequests + 1,
      overLimit: true,
      metered: true,
      retryAfterSec: 100,
      rollback,
    });

    const res = await makeGateway()(enterpriseRequest(), ctx);
    expect(res.status).toBe(429);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({
      limit: OPERATOR_KEY_DAILY_CEILINGS.restRequests,
      limit_type: "daily",
    });
  });

  test("ENFORCE + within limits → served, per-IP bypassed", async () => {
    process.env.API_RATE_LIMIT_ENFORCE = "true";
    const res = await makeGateway()(enterpriseRequest(), ctx);
    expect(res.status).toBe(200);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  test.each(["timeout", "not_configured", "error"])("unavailable burst (%s) retains daily metering and IP fallback", async (reason) => {
    process.env.API_RATE_LIMIT_ENFORCE = "true";
    checkBurst.mockResolvedValue({ ok: null, reason });
    const res = await makeGateway()(enterpriseRequest(), ctx);
    expect(res.status).toBe(200);
    expect(reserveDailyMeter).toHaveBeenCalledTimes(1);
    expect(checkRateLimit).toHaveBeenCalledWith(expect.any(Request), expect.any(Object));
  });

  test("unavailable burst still rejects and rolls back an exceeded daily ceiling", async () => {
    process.env.API_RATE_LIMIT_ENFORCE = "true";
    checkBurst.mockResolvedValue({ ok: null, reason: "timeout" });
    const rollback = vi.fn();
    reserveDailyMeter.mockResolvedValue({ overLimit: true, retryAfterSec: 100, rollback });
    const res = await makeGateway()(enterpriseRequest(), ctx);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ limit_type: "daily" });
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  test.each(["true", "false"])("fallback rejection releases a metered daily unit (enforce=%s)", async (enforce) => {
    process.env.API_RATE_LIMIT_ENFORCE = enforce;
    checkBurst.mockResolvedValue({ ok: null, reason: "timeout" });
    const rollback = vi.fn(async () => {});
    reserveDailyMeter.mockResolvedValue({ overLimit: false, metered: true, rollback });
    const rejection = new Response("fallback", { status: 429 });
    checkRateLimit.mockResolvedValue(rejection);

    const res = await makeGateway()(enterpriseRequest(), ctx);
    expect(res).toBe(rejection);
    expect(reserveDailyMeter).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  test("fallback admission keeps the daily reservation", async () => {
    process.env.API_RATE_LIMIT_ENFORCE = "true";
    checkBurst.mockResolvedValue({ ok: null, reason: "timeout" });
    const rollback = vi.fn(async () => {});
    reserveDailyMeter.mockResolvedValue({ overLimit: false, metered: true, rollback });
    expect((await makeGateway()(enterpriseRequest(), ctx)).status).toBe(200);
    expect(reserveDailyMeter).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
  });

  test("shadow unavailable burst meters without enforcing daily denial", async () => {
    checkBurst.mockResolvedValue({ ok: null, reason: "timeout" });
    const rollback = vi.fn();
    reserveDailyMeter.mockResolvedValue({ overLimit: true, rollback });
    expect((await makeGateway()(enterpriseRequest(), ctx)).status).toBe(200);
    expect(rollback).not.toHaveBeenCalled();
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
  });

  test("an existing endpoint policy still owns fallback protection during burst outage", async () => {
    process.env.API_RATE_LIMIT_ENFORCE = "true";
    endpointPolicy = true;
    checkBurst.mockResolvedValue({ ok: null, reason: "timeout" });
    expect((await makeGateway()(enterpriseRequest(), ctx)).status).toBe(200);
    expect(reserveDailyMeter).toHaveBeenCalledTimes(1);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  test("an unknown wm_ key is rejected as an invalid API key, before any limiter", async () => {
    const res = await makeGateway()(new Request("https://www.worldmonitor.app/api/news/v1/list-feed-digest", {
      headers: { "X-Api-Key": "wm_not_a_configured_key" },
    }), ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid API key" });
    expect(checkBurst).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});
