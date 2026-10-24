// @vitest-environment node

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const checkEndpointRateLimit = vi.fn().mockResolvedValue(null);
const checkRateLimit = vi.fn().mockResolvedValue(null);
vi.mock("../_shared/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/rate-limit")>();
  return {
    ...actual,
    checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
    checkEndpointRateLimit: (...a: unknown[]) => checkEndpointRateLimit(...a),
  };
});

const validateApiKey = vi.fn();
vi.mock("../../api/_api-key.js", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  validateApiKey: (...a: unknown[]) => validateApiKey(...a),
}));

const reserveDirectLlmQuota = vi.fn();
vi.mock("../_shared/direct-llm-quota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/direct-llm-quota")>();
  return {
    ...actual,
    reserveDirectLlmQuota: (...a: unknown[]) => reserveDirectLlmQuota(...a),
  };
});

import { createDomainGateway } from "../gateway";
import { ENDPOINT_RATE_POLICIES } from "../_shared/rate-limit";
import { DIRECT_LLM_DAILY_QUOTA_LIMIT } from "../_shared/direct-llm-quota";
import { OPERATOR_KEY_DAILY_CEILINGS } from "../_shared/high-usage-alarm";
import { hashKeySync } from "../_shared/usage-identity";

const SUMMARIZE_PATH = "/api/news/v1/summarize-article";
const CACHE_PATH = "/api/news/v1/summarize-article-cache";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeRequest(path: string, headers: Record<string, string> = {}, method = "POST", body?: unknown) {
  const init: RequestInit = { method, headers: { "x-real-ip": "203.0.113.9", ...headers } };
  if (method !== "GET" && method !== "HEAD") {
    init.body = JSON.stringify(body ?? { provider: "openrouter", headlines: ["headline"] });
  }
  return new Request(`https://www.worldmonitor.app${path}`, init);
}

function makeGateway(handlerCalls: { summarize: number; cache: number }) {
  return createDomainGateway([
    {
      method: "POST",
      path: SUMMARIZE_PATH,
      handler: async () => {
        handlerCalls.summarize += 1;
        return json({ ok: true, route: "summarize" });
      },
    },
    {
      method: "GET",
      path: CACHE_PATH,
      handler: async () => {
        handlerCalls.cache += 1;
        return json({ ok: true, route: "cache" });
      },
    },
  ]);
}

beforeEach(() => {
  checkEndpointRateLimit.mockReset().mockResolvedValue(null);
  checkRateLimit.mockReset().mockResolvedValue(null);
  validateApiKey.mockReset().mockResolvedValue({
    valid: false,
    required: true,
    error: "API key required",
  });
  reserveDirectLlmQuota.mockReset().mockResolvedValue({
    ok: true,
    newCount: 1,
    rollback: async () => {},
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("summarize-article gateway spend controls", () => {
  test("route keeps its fail-closed endpoint rate limit", () => {
    expect(ENDPOINT_RATE_POLICIES[SUMMARIZE_PATH]).toEqual({ limit: 30, window: "60 s" });
  });

  test("requests without a session or key are refused before any spend", async () => {
    const calls = { summarize: 0, cache: 0 };
    const res = await makeGateway(calls)(makeRequest(SUMMARIZE_PATH), { waitUntil: () => {} });

    expect(res.status).toBe(401);
    expect(calls.summarize).toBe(0);
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
  });

  test("anonymous wms_ sessions reach the handler, metered by hashed client address", async () => {
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(SUMMARIZE_PATH, { "X-WorldMonitor-Key": "wms_anonymous_session" }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(200);
    expect(calls.summarize).toBe(1);
    expect(checkEndpointRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      SUMMARIZE_PATH,
      expect.any(Object),
    );
    expect(reserveDirectLlmQuota).toHaveBeenCalledWith(expect.objectContaining({
      userId: `ip:${hashKeySync("203.0.113.9")}`,
      limit: DIRECT_LLM_DAILY_QUOTA_LIMIT,
    }));
  });

  test("rotating wms_ sessions from one address share one daily quota principal", async () => {
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    const calls = { summarize: 0, cache: 0 };
    const gateway = makeGateway(calls);
    await gateway(makeRequest(SUMMARIZE_PATH, { "X-WorldMonitor-Key": "wms_first" }), { waitUntil: () => {} });
    await gateway(makeRequest(SUMMARIZE_PATH, { "X-WorldMonitor-Key": "wms_second" }), { waitUntil: () => {} });

    const principals = reserveDirectLlmQuota.mock.calls.map(([opts]) => (opts as { userId: string }).userId);
    expect(principals).toHaveLength(2);
    expect(new Set(principals).size).toBe(1);
  });

  test("operator keys are metered per key against their circuit-breaker ceiling", async () => {
    validateApiKey.mockResolvedValue({ valid: true, required: true, kind: "enterprise", credential: "operator-key" });
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(SUMMARIZE_PATH, { "X-Api-Key": "operator-key" }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(200);
    const [opts] = reserveDirectLlmQuota.mock.calls[0]!;
    expect(opts).toMatchObject({ limit: OPERATOR_KEY_DAILY_CEILINGS.directLlmCalls });
    expect((opts as { userId: string }).userId).toMatch(/^wm:[0-9a-f]{32}$/);
  });

  test("an exhausted daily quota answers 429 without running the handler", async () => {
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    reserveDirectLlmQuota.mockResolvedValue({ ok: false, reason: "cap-exceeded", floor: 500, retryAfterSec: 60 });
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(SUMMARIZE_PATH, { "X-WorldMonitor-Key": "wms_anonymous_session" }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(calls.summarize).toBe(0);
  });

  test("translate mode is quota-exempt", async () => {
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(
        SUMMARIZE_PATH,
        { "X-WorldMonitor-Key": "wms_anonymous_session", "Content-Type": "application/json" },
        "POST",
        { provider: "openrouter", mode: "translate", headlines: ["hola"] },
      ),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(200);
    expect(calls.summarize).toBe(1);
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
  });

  test("Redis-degraded endpoint rate limiting fails closed before the provider handler", async () => {
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    checkEndpointRateLimit.mockResolvedValue(json({ error: "Rate-limit service temporarily unavailable" }, 503));
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(SUMMARIZE_PATH, { "X-WorldMonitor-Key": "wms_anonymous_session" }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(503);
    expect(calls.summarize).toBe(0);
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
  });

  test("summarize-article-cache stays a read-only cache lookup with no quota", async () => {
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(`${CACHE_PATH}?cache_key=test-cache-key`, { "X-WorldMonitor-Key": "wms_anonymous_session" }, "GET"),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(200);
    expect(calls.cache).toBe(1);
    expect(calls.summarize).toBe(0);
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
  });
});
