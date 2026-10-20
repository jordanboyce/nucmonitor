import { anyApi, httpRouter } from "convex/server";
import type { Infer } from "convex/values";
import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { lookupVerifiedAccountEmail, requireVerifiedAccountEmail } from "./lib/notificationEmail";
import { timingSafeEqualStrings } from "./lib/svixVerify";
import { TOUCH_DEBOUNCE_MS } from "./apiKeys";
import { resendWebhookHandler } from "./resendWebhookHandler";
import { clerkWebhookHandler } from "./accountDeletion/clerkWebhook";
import { channelTypeValidator, USER_PREFS_WRITE_RATE_LIMIT } from "./constants";
import { isPreferenceVariant } from "../shared/cloud-preferences-contract";
import { buildUnsubscribeUrl, EMAIL_UNSUBSCRIBE_PATH, verifyUnsubscribeToken } from "./lib/emailUnsubscribe";

// App-serving hosts only, aligned with api/_cors.js and server/cors.ts.
const APP_ORIGIN = /^https:\/\/(?:(?:www|app|api|nuclear)\.)?worldmonitor\.app$/;
const TRUSTED_ORIGINS = [
  APP_ORIGIN,
  /^https:\/\/worldmonitor-[a-z0-9-]+-eliewm\.vercel\.app$/,
  /^https?:\/\/(?:[a-z0-9-]+\.)?tauri\.localhost(?::\d+)?$/,
  /^(?:tauri|asset):\/\/localhost$/,
];

const EXPOSED_HEADERS = [
  "Retry-After",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
].join(", ");

function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    // An Origin is a scheme/host/port, never a URL with credentials or a path.
    if (url.username || url.password || `${url.protocol}//${url.host}` !== origin) return null;
    url.hostname = url.hostname.replace(/\.+$/, "");
    const candidate = `${url.protocol}//${url.host}`;
    if (TRUSTED_ORIGINS.some(pattern => pattern.test(candidate))) return origin;
    if (process.env.NODE_ENV !== "production" && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(candidate)) return origin;
    if (url.protocol === "https:" && !url.port && url.hostname.endsWith(".translate.goog")) {
      const encoded = url.hostname.slice(0, -".translate.goog".length);
      const decoded = encoded.replace(/--/g, "\0").replace(/-/g, ".").replace(/\0/g, "-");
      if (!encoded.includes(".") && APP_ORIGIN.test(`https://${decoded}`)) return origin;
    }
  } catch {
    // Malformed origins receive no CORS grant.
  }
  return null;
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({ Vary: "Origin" });
  const allowed = allowedOrigin(origin);
  if (allowed) {
    headers.set("Access-Control-Allow-Origin", allowed);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

export async function userPrefsOptionsHttpHandler(
  _ctx: ActionCtx,
  request: Request,
): Promise<Response> {
  const headers = corsHeaders(request.headers.get("Origin"));
  return new Response(null, { status: 204, headers });
}


const tenantRelaySecrets = {
  gateway: "CONVEX_TENANT_RELAY_SECRET",
  delivery: "CONVEX_NOTIFICATION_RELAY_SECRET",
  suppression: "CONVEX_EMAIL_SUPPRESSION_SECRET",
} as const;

async function authorizeTenantRelay(
  request: Request,
  roles: readonly (keyof typeof tenantRelaySecrets)[],
): Promise<Response | null> {
  const provided = /^Bearer\s+(\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  const deny = () => Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  if (!provided) return deny();
  // A copied ingestion key must never acquire tenant authority under a new name.
  const ingestion = process.env.RELAY_SHARED_SECRET;
  if (ingestion && await timingSafeEqualStrings(provided, ingestion)) return deny();
  for (const role of roles) {
    const secret = process.env[tenantRelaySecrets[role]];
    if (!secret || !(await timingSafeEqualStrings(provided, secret))) continue;
    for (const other of Object.keys(tenantRelaySecrets) as (keyof typeof tenantRelaySecrets)[]) {
      const otherSecret = process.env[tenantRelaySecrets[other]];
      if (other !== role && otherSecret && await timingSafeEqualStrings(secret, otherSecret)) return deny();
    }
    return null;
  }
  return deny();
}

/** Parse a request body only when JSON produced an object (never null or an array). */
async function parseJsonObjectBody<T extends object>(request: Request): Promise<T | null> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? body as T
      : null;
  } catch {
    return null;
  }
}

/**
 * Extract a stable error `code` from a thrown ConvexError.
 *
 * Convex's runtime serializes `error.data` to a JSON string before re-throwing
 * across the function boundary (see registration_impl::serializeConvexErrorData),
 * so by the time an http action's catch block sees the error, `err.data` is a
 * JSON-encoded string. Both shapes are handled:
 *   - `throw new ConvexError("PRO_REQUIRED")`  → data = '"PRO_REQUIRED"' → "PRO_REQUIRED"
 *   - `throw new ConvexError({code: "X", ...})` → data = '{"code":"X",…}'  → "X"
 */
function parseConvexErrorData(err: unknown): unknown {
  const raw = (err as { data?: unknown } | undefined)?.data;
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function extractConvexErrorCode(err: unknown): string | null {
  const parsed = parseConvexErrorData(err);
  if (typeof parsed === "string") return parsed;
  if (parsed && typeof parsed === "object") {
    const data = parsed as Record<string, unknown>;
    const code = data.code ?? data.kind;
    if (typeof code === "string") return code;
  }
  return null;
}

function readConvexErrorNumber(err: unknown, field: string): number | null {
  const parsed = parseConvexErrorData(err);
  if (!parsed || typeof parsed !== "object") return null;
  const value = (parsed as Record<string, unknown>)[field];
  return typeof value === "number" ? value : null;
}

type SetPreferencesResult =
  | { ok: true; syncVersion: number }
  | { ok: false; reason: "CONFLICT"; actualSyncVersion: number }
  | { ok: false; reason: "BLOB_TOO_LARGE"; size: number; max: number }
  | { ok: false; reason: "RATE_LIMITED"; limit: number; reset: number };

function setRateLimitResponseHeaders(headers: Headers, limit: number, reset: number): void {
  const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
  headers.set("X-RateLimit-Limit", String(limit));
  headers.set("X-RateLimit-Remaining", "0");
  headers.set("X-RateLimit-Reset", String(reset));
  headers.set("Retry-After", String(retryAfter));
}

const REGISTER_INTEREST_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REGISTER_INTEREST_MAX_EMAIL_LENGTH = 320;
const REGISTER_INTEREST_MAX_META_LENGTH = 100;

/**
 * Server-to-server bridge for the anonymous waitlist flow. The public
 * registerInterest mutation is internal so a Convex client cannot bypass the
 * edge handler's Turnstile/desktop proof, email validation, and rate limits.
 */
export async function registerInterestHttpHandler(
  ctx: ActionCtx,
  request: Request,
): Promise<Response> {
  const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
  const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
  if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
    return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await parseJsonObjectBody<{
    email?: unknown;
    source?: unknown;
    appVersion?: unknown;
    referredBy?: unknown;
  }>(request);
  if (!body) {
    return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const email = typeof body.email === "string" ? body.email : "";
  if (
    email.length === 0 ||
    email.length > REGISTER_INTEREST_MAX_EMAIL_LENGTH ||
    !REGISTER_INTEREST_EMAIL_RE.test(email)
  ) {
    return new Response(JSON.stringify({ error: "INVALID_EMAIL" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const metadata = [
    ["source", body.source],
    ["appVersion", body.appVersion],
    ["referredBy", body.referredBy],
  ] as const;
  for (const [field, value] of metadata) {
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length > REGISTER_INTEREST_MAX_META_LENGTH)
    ) {
      return new Response(JSON.stringify({ error: `INVALID_${field.toUpperCase()}` }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  if (typeof body.referredBy === "string" && body.referredBy.length > 20) {
    return new Response(JSON.stringify({ error: "INVALID_REFERRED_BY" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const result = await ctx.runMutation(internal.registerInterest.register, {
      email,
      source: body.source as string | undefined,
      appVersion: body.appVersion as string | undefined,
      referredBy: body.referredBy as string | undefined,
    });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[register-interest] internal mutation failed:", err);
    return new Response(JSON.stringify({ error: "REGISTRATION_UNAVAILABLE" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function internalEntitlementsHttpHandler(
  ctx: ActionCtx,
  request: Request,
): Promise<Response> {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ userId?: unknown }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (
      typeof body.userId !== "string" ||
      body.userId.length === 0 ||
      body.userId.length > 256
    ) {
      return new Response(JSON.stringify({ error: "MISSING_USER_ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await ctx.runQuery(
      internal.entitlements.getEntitlementsByUserId,
      { userId: body.userId },
    );

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

const http = httpRouter();

// Only the edge contact handler may write leads after its public abuse checks.
http.route({
  path: "/leads/submit-contact",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    const provided = request.headers.get("x-convex-shared-secret") ?? "";
    if (!expected || !(await timingSafeEqualStrings(provided, expected))) {
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }
    const body = await parseJsonObjectBody<Record<string, unknown>>(request);
    if (!body || typeof body.name !== "string" || typeof body.email !== "string"
      || typeof body.source !== "string"
      || [body.organization, body.phone, body.message].some(
        (value) => value !== undefined && typeof value !== "string",
      )) {
      return Response.json({ error: "INVALID_CONTACT" }, { status: 400 });
    }
    try {
      const result = await ctx.runMutation(internal.contactMessages.submit, {
        name: body.name,
        email: body.email,
        source: body.source,
        organization: body.organization as string | undefined,
        phone: body.phone as string | undefined,
        message: body.message as string | undefined,
      });
      return Response.json(result);
    } catch (error) {
      const code = extractConvexErrorCode(error);
      if (code === "rate_limited") {
        return Response.json({ error: code }, { status: 429 });
      }
      if (code === "FREE_EMAIL_NOT_ALLOWED") {
        return Response.json({ error: code }, { status: 422 });
      }
      return Response.json({ error: "CONTACT_STORAGE_FAILED" }, { status: 503 });
    }
  }),
});

http.route({
  path: "/api/internal-register-interest",
  method: "POST",
  handler: httpAction(registerInterestHttpHandler),
});

http.route({
  path: "/api/internal-entitlements",
  method: "POST",
  handler: httpAction(internalEntitlementsHttpHandler),
});

http.route({
  path: "/api/user-prefs",
  method: "OPTIONS",
  handler: httpAction(userPrefsOptionsHttpHandler),
});

http.route({
  path: "/api/user-prefs",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const headers = corsHeaders(request.headers.get("Origin"));
    headers.set("Content-Type", "application/json");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return new Response(JSON.stringify({ error: "UNAUTHENTICATED" }), {
        status: 401,
        headers,
      });
    }

    const body = await parseJsonObjectBody<{
      variant?: string;
      data?: unknown;
      expectedSyncVersion?: number;
      schemaVersion?: number;
    }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers,
      });
    }

    if (
      typeof body.variant !== "string" ||
      body.data === undefined ||
      typeof body.expectedSyncVersion !== "number"
    ) {
      return new Response(JSON.stringify({ error: "MISSING_FIELDS" }), {
        status: 400,
        headers,
      });
    }

    if (!isPreferenceVariant(body.variant)) {
      return new Response(JSON.stringify({ error: "INVALID_VARIANT" }), {
        status: 400,
        headers,
      });
    }

    try {
      const result = (await ctx.runMutation(
        anyApi.userPreferences!.setPreferences as any,
        {
          variant: body.variant,
          data: body.data,
          expectedSyncVersion: body.expectedSyncVersion,
          schemaVersion: body.schemaVersion,
        },
      )) as SetPreferencesResult;
      // Expected write denials return as a discriminated result so Convex can
      // commit limiter bookkeeping and duplicate-counter cleanup. Mirror the
      // wire shape from api/user-prefs.ts (Vercel) regardless of host.
      if (result.ok === false) {
        if (result.reason === "BLOB_TOO_LARGE") {
          return new Response(JSON.stringify({ error: "BLOB_TOO_LARGE" }), {
            status: 400,
            headers,
          });
        }
        if (result.reason === "RATE_LIMITED") {
          setRateLimitResponseHeaders(headers, result.limit, result.reset);
          return new Response(JSON.stringify({ error: "RATE_LIMITED" }), {
            status: 429,
            headers,
          });
        }
        return new Response(
          JSON.stringify({
            error: "CONFLICT",
            actualSyncVersion: result.actualSyncVersion,
          }),
          { status: 409, headers },
        );
      }
      return new Response(
        JSON.stringify({ syncVersion: result.syncVersion }),
        { status: 200, headers },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = extractConvexErrorCode(err);
      // Defensive: keep CONFLICT-throw fallback for the deploy-ordering
      // window where this http action may run against an older Convex
      // deployment that still throws. Once both layers have soaked, this
      // branch is unreachable and can be removed.
      if (code === "CONFLICT" || msg.includes("CONFLICT")) {
        return new Response(JSON.stringify({ error: "CONFLICT" }), {
          status: 409,
          headers,
        });
      }
      if (code === "BLOB_TOO_LARGE" || msg.includes("BLOB_TOO_LARGE")) {
        return new Response(JSON.stringify({ error: "BLOB_TOO_LARGE" }), {
          status: 400,
          headers,
        });
      }
      if (code === "RATE_LIMITED" || msg.includes("RATE_LIMITED")) {
        const limit = readConvexErrorNumber(err, "limit") ?? USER_PREFS_WRITE_RATE_LIMIT;
        const reset = readConvexErrorNumber(err, "reset") ?? Date.now() + 60_000;
        setRateLimitResponseHeaders(headers, limit, reset);
        return new Response(JSON.stringify({ error: "RATE_LIMITED" }), {
          status: 429,
          headers,
        });
      }
      throw err;
    }
  }),
});

// Shows enough of the account email for its owner to recognise it, without
// handing a stranger who opens a forwarded link the full address.
function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "(hidden)";
  const local = email.slice(0, at);
  return `${local.slice(0, Math.min(2, local.length))}***${email.slice(at)}`;
}

async function telegramBotCall(botToken: string, method: string, body: Record<string, unknown>): Promise<void> {
  // Awaited because HTTP actions end when the handler returns.
  await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "worldmonitor-convex/1.0" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  }).catch((err: unknown) => {
    console.error(`[telegram-webhook] ${method} failed:`, err);
  });
}

http.route({
  path: "/api/telegram-pair-callback",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Always return 200 — non-200 triggers Telegram retry storm.
    // Fail closed: drop the update unless the request carries the secret
    // header set when we registered the webhook. Returning 200 without
    // processing keeps Telegram from retrying spoofed requests while still
    // refusing to run the pairing-token claim path on unauthenticated input.
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
    if (!secret) {
      console.error(
        "[telegram-webhook] TELEGRAM_WEBHOOK_SECRET not configured — rejecting all requests",
      );
      return new Response("OK", { status: 200 });
    }
    const provided =
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (!provided) {
      // Helps ops spot webhook re-registration drift (Telegram dropped the
      // header) without re-enabling the bypass.
      console.warn(
        "[telegram-webhook] secret header absent — rejecting request",
      );
      return new Response("OK", { status: 200 });
    }
    if (!(await timingSafeEqualStrings(provided, secret))) {
      return new Response("OK", { status: 200 });
    }

    const update = await parseJsonObjectBody<{
      message?: {
        chat?: { type?: string; id?: number };
        text?: string;
        date?: number;
      };
      callback_query?: {
        id?: string;
        from?: { id?: number };
        data?: string;
        message?: { chat?: { type?: string; id?: number }; message_id?: number };
      };
    }>(request);
    if (!update) {
      return new Response("OK", { status: 200 });
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
    const isPrivateChatId = (id: unknown): id is number =>
      typeof id === "number" && Number.isSafeInteger(id) && id > 0;

    // Step 2: the Confirm button pressed in the chat that sent /start.
    const callback = update.callback_query;
    if (callback) {
      const chat = callback.message?.chat;
      const confirm = typeof callback.data === "string"
        ? callback.data.match(/^wmpair:([A-Za-z0-9_-]{40,50})$/)
        : null;
      // In a private chat the chat id is the user id, so requiring both to
      // match means only the person in that chat can confirm it.
      if (!confirm?.[1] || chat?.type !== "private" || !isPrivateChatId(chat.id) || callback.from?.id !== chat.id) {
        return new Response("OK", { status: 200 });
      }
      const chatId = String(chat.id);
      const claimed = await ctx.runMutation(internal.notificationChannels.claimPairingToken, {
        token: confirm[1],
        chatId,
      });
      if (botToken) {
        await telegramBotCall(botToken, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: claimed.ok ? "Connected" : "This link has expired. Start again from WorldMonitor settings.",
        });
        if (claimed.ok) {
          await telegramBotCall(botToken, "sendMessage", {
            chat_id: chatId,
            text: "✅ WorldMonitor connected! You'll receive breaking news alerts here.",
          });
        }
      }
      return new Response("OK", { status: 200 });
    }

    const msg = update.message;
    if (!msg) return new Response("OK", { status: 200 });

    if (msg.chat?.type !== "private") return new Response("OK", { status: 200 });
    if (!isPrivateChatId(msg.chat.id)) {
      return new Response("OK", { status: 200 });
    }

    if (typeof msg.date !== "number" || !Number.isSafeInteger(msg.date) || Math.abs(Date.now() / 1000 - msg.date) > 900) {
      return new Response("OK", { status: 200 });
    }

    if (typeof msg.text !== "string") return new Response("OK", { status: 200 });
    const text = msg.text.trim();
    const chatId = String(msg.chat.id);

    const match = text.match(/^\/start\s+([A-Za-z0-9_-]{40,50})$/);
    if (!match?.[1]) return new Response("OK", { status: 200 });

    // Step 1: record the chat and ask it to confirm. Nothing is bound yet.
    const staged = await ctx.runMutation(internal.notificationChannels.stagePairingToken, {
      token: match[1],
      chatId,
    });

    if (staged.ok && staged.userId && botToken) {
      let accountEmail: string | undefined;
      try {
        accountEmail = await lookupVerifiedAccountEmail(staged.userId, { allowMissingUser: true });
      } catch {
        accountEmail = undefined;
      }
      const account = accountEmail ? `the WorldMonitor account ${maskEmail(accountEmail)}` : "a WorldMonitor account";
      await telegramBotCall(botToken, "sendMessage", {
        chat_id: chatId,
        text:
          `Connect this chat to ${account}?\n\n` +
          "Only confirm if you started this from your own WorldMonitor settings. " +
          "If someone sent you this link, ignore this message.",
        reply_markup: {
          inline_keyboard: [[{ text: "Confirm", callback_data: `wmpair:${match[1]}` }]],
        },
      });
    }

    return new Response("OK", { status: 200 });
  }),
});

// Every type the schema stores, read from the validator so a new channel
// type cannot be left out of the deactivate route (#9264).
const CHANNEL_TYPES: ReadonlySet<string> = new Set(channelTypeValidator.members.map((member) => member.value));
function isChannelType(value: unknown): value is Infer<typeof channelTypeValidator> {
  return typeof value === "string" && CHANNEL_TYPES.has(value);
}

http.route({
  path: "/relay/deactivate",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = await authorizeTenantRelay(request, ["delivery"]);
    if (unauthorized) return unauthorized;

    const body = await parseJsonObjectBody<{ userId?: string; channelType?: string }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (
      typeof body.userId !== "string" || !body.userId ||
      !isChannelType(body.channelType)
    ) {
      return new Response(JSON.stringify({ error: "MISSING_FIELDS" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    await ctx.runMutation((internal as any).notificationChannels.deactivateChannelForUser, {
      userId: body.userId,
      channelType: body.channelType,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ---------------------------------------------------------------------------
// One-click email unsubscribe (RFC 8058) for the daily brief, alert emails and
// winback. GET renders a confirm page and never changes state, because link
// scanners and mail-security proxies prefetch GETs. POST unsubscribes without
// a login: mail clients send `List-Unsubscribe=One-Click` to the header URL,
// and the confirm page's form posts to the same URL. Token format and signing
// live in lib/emailUnsubscribe.ts; the state change in emailUnsubscribe.ts.
// ---------------------------------------------------------------------------

const UNSUBSCRIBE_LIST_COPY = {
  brief: { name: "the World Monitor daily brief", done: "You will no longer get the daily brief by email." },
  alerts: { name: "World Monitor alert emails", done: "You will no longer get real-time alerts by email." },
  marketing: { name: "World Monitor product emails", done: "You will no longer get product and win-back emails. Account and billing notices still arrive." },
} as const;

function unsubscribePage(status: number, title: string, bodyHtml: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head>
<body style="margin:0;background:#0a0a0a;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:520px;margin:64px auto;padding:32px;background:#111;border:1px solid #1f1f1f;">
<p style="font-size:13px;font-weight:800;letter-spacing:1px;color:#4ade80;margin:0 0 16px;">WORLD MONITOR</p>
<h1 style="font-size:20px;color:#fff;margin:0 0 12px;">${title}</h1>
${bodyHtml}
<p style="font-size:12px;color:#777;line-height:1.5;margin:24px 0 0;">Manage daily brief and alert emails in <a href="https://www.worldmonitor.app/dashboard?settings=notifications" style="color:#4ade80;">Notification settings</a>. For product emails, <a href="mailto:support@worldmonitor.app?subject=Unsubscribe%20from%20product%20emails" style="color:#4ade80;">email support to unsubscribe</a>.</p>
</div></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // The URL carries the signed token.
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

function invalidUnsubscribeLink(): Response {
  return unsubscribePage(
    400,
    "This unsubscribe link is not valid",
    `<p style="font-size:14px;color:#aaa;line-height:1.5;margin:0;">The link may be incomplete. Open the latest email again, or use the options below.</p>`,
  );
}

async function readUnsubscribeToken(request: Request): Promise<string | null> {
  const fromQuery = new URL(request.url).searchParams.get("t");
  if (fromQuery) return fromQuery;
  // The confirm form posts the token as a field as well as in the URL.
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text().catch(() => "");
    return new URLSearchParams(text.slice(0, 4096)).get("t");
  }
  return null;
}

http.route({
  path: EMAIL_UNSUBSCRIBE_PATH,
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    const token = new URL(request.url).searchParams.get("t");
    const verified = await verifyUnsubscribeToken(token);
    if (!verified || !token) return invalidUnsubscribeLink();
    const copy = UNSUBSCRIBE_LIST_COPY[verified.list];
    const action = `${EMAIL_UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}`;
    return unsubscribePage(
      200,
      `Unsubscribe from ${copy.name}?`,
      `<form method="post" action="${action}" style="margin:0;">
<input type="hidden" name="t" value="${token.replace(/[^A-Za-z0-9._-]/g, "")}">
<button type="submit" style="background:#4ade80;color:#0a0a0a;border:0;padding:12px 28px;font-weight:800;font-size:13px;letter-spacing:1px;text-transform:uppercase;cursor:pointer;">Unsubscribe</button>
</form>`,
    );
  }),
});

http.route({
  path: EMAIL_UNSUBSCRIBE_PATH,
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const verified = await verifyUnsubscribeToken(await readUnsubscribeToken(request));
    if (!verified) return invalidUnsubscribeLink();
    await ctx.runMutation(internal.emailUnsubscribe.applyUnsubscribe, verified);
    const copy = UNSUBSCRIBE_LIST_COPY[verified.list];
    console.log(`[email-unsubscribe] one-click unsubscribe applied (list=${verified.list})`);
    return unsubscribePage(
      200,
      "You are unsubscribed",
      `<p style="font-size:14px;color:#aaa;line-height:1.5;margin:0;">${copy.done}</p>`,
    );
  }),
});

http.route({
  path: "/relay/channels",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = await authorizeTenantRelay(request, ["delivery"]);
    if (unauthorized) return unauthorized;

    const body = await parseJsonObjectBody<{ userId?: string }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.userId !== "string" || !body.userId) {
      return new Response(JSON.stringify({ error: "MISSING_USER_ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const channels: Array<{ channelType?: string; email?: string }> =
      await ctx.runQuery((internal as any).notificationChannels.getChannelsByUserId, {
        userId: body.userId,
      }) ?? [];

    // Delivery workers send alert and digest mail to whatever this returns.
    // Drop email channels whose address bounced, complained or was suppressed
    // by an operator, so those sends stop like every other Resend sender.
    // Email channels also carry pre-signed one-click unsubscribe URLs
    // (RFC 8058) so the workers never need the signing secret; both are null
    // when EMAIL_UNSUBSCRIBE_SECRET is unset.
    const deliverable = [];
    let unsubscribeUrls: { brief: string | null; alerts: string | null } | null = null;
    for (const channel of channels) {
      if (channel.channelType === "email" && typeof channel.email === "string" && channel.email
        && await ctx.runQuery(internal.emailSuppressions.isEmailSuppressed, {
          email: channel.email,
          purpose: "transactional",
        })) {
        continue;
      }
      if (channel.channelType === "email") {
        unsubscribeUrls ??= {
          brief: await buildUnsubscribeUrl(body.userId, "brief"),
          alerts: await buildUnsubscribeUrl(body.userId, "alerts"),
        };
        deliverable.push({ ...channel, unsubscribeUrls });
        continue;
      }
      deliverable.push(channel);
    }

    return new Response(JSON.stringify(deliverable), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// Service-to-service notification channel management (no user JWT required).
// Authenticated via CONVEX_TENANT_RELAY_SECRET; caller supplies the validated userId.
http.route({
  path: "/relay/notification-channels",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = await authorizeTenantRelay(request, ["gateway"]);
    if (unauthorized) return unauthorized;

    const body = await parseJsonObjectBody<{
      action?: string;
      userId?: string;
      channelType?: string;
      chatId?: string;
      webhookEnvelope?: string;
      webhookLabel?: string;
      webhookSecret?: string;
      email?: string;
      variant?: string;
      enabled?: boolean;
      eventTypes?: string[];
      sensitivity?: string;
      channels?: string[];
      slackChannelName?: string;
      slackTeamName?: string;
      slackConfigurationUrl?: string;
      discordGuildId?: string;
      discordChannelId?: string;
      endpoint?: string;
      p256dh?: string;
      auth?: string;
      userAgent?: string;
      quietHoursEnabled?: boolean;
      quietHoursStart?: number;
      quietHoursEnd?: number;
      quietHoursTimezone?: string;
      quietHoursOverride?: string;
      digestMode?: string;
      digestHour?: number;
      digestTimezone?: string;
      aiDigestEnabled?: boolean;
      countries?: string[];
      tickers?: string[];
      chokepoints?: string[];
      scheduleWelcome?: boolean;
    }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { action = "get", userId } = body;
    if (typeof userId !== "string" || !userId) {
      return new Response(JSON.stringify({ error: "MISSING_USER_ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      if (action === "get") {
        const [channels, alertRules] = await Promise.all([
          ctx.runQuery((internal as any).notificationChannels.getChannelsByUserId, { userId }),
          ctx.runQuery((internal as any).alertRules.getAlertRulesByUserId, { userId }),
        ]);
        // The signing secret is only ever shown once, at registration; the
        // settings UI needs to know whether a webhook is signed, not the key.
        const visibleChannels = (channels ?? []).map(
          ({ webhookSecret, ...channel }: { webhookSecret?: string; [key: string]: unknown }) =>
            channel.channelType === "webhook" ? { ...channel, webhookSigned: Boolean(webhookSecret) } : channel,
        );
        return new Response(JSON.stringify({ channels: visibleChannels, alertRules: alertRules ?? [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (action === "welcome-scheduling-capability") {
        return new Response(
          JSON.stringify({ durableWelcomeScheduling: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (action === "create-pairing-token") {
        const result = await ctx.runMutation((internal as any).notificationChannels.createPairingTokenForUser, {
          userId,
          variant: body.variant,
        });
        return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (action === "set-channel") {
        if (!body.channelType) {
          return new Response(JSON.stringify({ error: "channelType required" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const verifiedAccountEmail = body.channelType === "email"
          ? requireVerifiedAccountEmail(body.email, await lookupVerifiedAccountEmail(userId))
          : undefined;
        const setResult = await ctx.runMutation((internal as any).notificationChannels.setChannelForUser, {
          userId,
          channelType: body.channelType as "telegram" | "slack" | "email" | "teams" | "webhook",
          chatId: body.chatId,
          webhookEnvelope: body.webhookEnvelope,
          email: body.email,
          verifiedAccountEmail,
          webhookLabel: body.webhookLabel,
          webhookSecret: body.channelType === "webhook" ? body.webhookSecret : undefined,
          scheduleWelcome: body.scheduleWelcome === true,
        });
        return new Response(JSON.stringify({
          ok: true,
          isNew: setResult.isNew,
          durableWelcomeScheduling: body.scheduleWelcome === true,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (action === "set-slack-oauth") {
        if (!body.webhookEnvelope) {
          return new Response(JSON.stringify({ error: "webhookEnvelope required" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const oauthResult = await ctx.runMutation((internal as any).notificationChannels.setSlackOAuthChannelForUser, {
          userId,
          webhookEnvelope: body.webhookEnvelope,
          slackChannelName: body.slackChannelName,
          slackTeamName: body.slackTeamName,
          slackConfigurationUrl: body.slackConfigurationUrl,
        });
        return new Response(JSON.stringify({ ok: true, isNew: oauthResult.isNew }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (action === "set-discord-oauth") {
        if (!body.webhookEnvelope) {
          return new Response(JSON.stringify({ error: "webhookEnvelope required" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const discordResult = await ctx.runMutation((internal as any).notificationChannels.setDiscordOAuthChannelForUser, {
          userId,
          webhookEnvelope: body.webhookEnvelope,
          discordGuildId: body.discordGuildId,
          discordChannelId: body.discordChannelId,
        });
        return new Response(JSON.stringify({ ok: true, isNew: discordResult.isNew }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (action === "set-web-push") {
        if (!body.endpoint || !body.p256dh || !body.auth) {
          return new Response(JSON.stringify({ error: "endpoint, p256dh, auth required" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const webPushResult = await ctx.runMutation((internal as any).notificationChannels.setWebPushChannelForUser, {
          userId,
          endpoint: body.endpoint,
          p256dh: body.p256dh,
          auth: body.auth,
          userAgent: body.userAgent,
          scheduleWelcome: body.scheduleWelcome === true,
        });
        return new Response(JSON.stringify({
          ok: true,
          isNew: webPushResult.isNew,
          durableWelcomeScheduling: body.scheduleWelcome === true,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (action === "delete-channel") {
        if (!body.channelType) {
          return new Response(JSON.stringify({ error: "channelType required" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        await ctx.runMutation((internal as any).notificationChannels.deleteChannelForUser, {
          userId,
          channelType: body.channelType as "telegram" | "slack" | "email" | "discord" | "teams",
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (action === "set-alert-rules") {
        const VALID_SENSITIVITY = new Set(["all", "high", "critical"]);
        if (
          typeof body.variant !== "string" || !body.variant ||
          typeof body.enabled !== "boolean" ||
          !Array.isArray(body.eventTypes) ||
          !Array.isArray(body.channels) ||
          (body.sensitivity !== undefined && !VALID_SENSITIVITY.has(body.sensitivity as string)) ||
          (body.countries !== undefined && !Array.isArray(body.countries)) ||
          (body.tickers !== undefined && !Array.isArray(body.tickers)) ||
          (body.chokepoints !== undefined && !Array.isArray(body.chokepoints))
        ) {
          return new Response(JSON.stringify({ error: "MISSING_REQUIRED_FIELDS" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        try {
          await ctx.runMutation((internal as any).alertRules.setAlertRulesForUser, {
            userId,
            variant: body.variant,
            enabled: body.enabled,
            eventTypes: body.eventTypes as string[],
            // Pass body.sensitivity through unchanged (may be undefined).
            // setAlertRulesForUser now accepts optional sensitivity and uses
            // resolveEffectivePair to preserve existing.sensitivity on patch and
            // default to 'high' only on fresh insert. A blind '?? "all"' fallback
            // here would silently narrow existing daily+all digest users to
            // daily+high whenever a caller omits the field.
            // See docs/archive/plans/forbid-realtime-all-events.md §1c.
            sensitivity: body.sensitivity as "all" | "high" | "critical" | undefined,
            channels: body.channels as Array<"telegram" | "slack" | "email">,
            aiDigestEnabled: typeof body.aiDigestEnabled === "boolean" ? body.aiDigestEnabled : undefined,
            // ISO-3166 alpha-2 country-scope; mutation re-validates + normalizes.
            countries: Array.isArray(body.countries) ? (body.countries as string[]) : undefined,
            // Watchlist ticker-scope (#4922 U3); mutation re-validates + normalizes.
            tickers: Array.isArray(body.tickers) ? (body.tickers as string[]) : undefined,
            // Chokepoint-scope (#9217); mutation re-validates + normalizes.
            chokepoints: Array.isArray(body.chokepoints) ? (body.chokepoints as string[]) : undefined,
          });
        } catch (err: unknown) {
          // normalizeTickers/normalizeCountries throw ConvexError with a
          // structured code (TICKERS_LIMIT_EXCEEDED / COUNTRIES_LIMIT_EXCEEDED)
          // when a caller exceeds the 50-entry cap. assertCompatibleDeliveryMode
          // throws INCOMPATIBLE_DELIVERY when the legacy set-alert-rules path
          // tries to keep (realtime, high|all). Surface those as a 400 with
          // the machine-readable code — matching the set-notification-config
          // path below — instead of letting them fall to the outer catch as a
          // generic 500, which the client can't route on.
          // See Sentry WORLDMONITOR-143 (prod setAlertRulesForUser via this action).
          const code = extractConvexErrorCode(err);
          if (code === "TICKERS_LIMIT_EXCEEDED" || code === "COUNTRIES_LIMIT_EXCEEDED" || code === "CHOKEPOINTS_INVALID") {
            return new Response(JSON.stringify({ error: code }), { status: 400, headers: { "Content-Type": "application/json" } });
          }
          if (code === "INCOMPATIBLE_DELIVERY") {
            const parsed = parseConvexErrorData(err);
            const message = (parsed && typeof parsed === "object")
              ? (parsed as { message?: string }).message ?? ""
              : "";
            return new Response(JSON.stringify({ error: code, message }), { status: 400, headers: { "Content-Type": "application/json" } });
          }
          throw err;
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (action === "set-quiet-hours") {
        const VALID_OVERRIDE = new Set(["critical_only", "silence_all", "batch_on_wake"]);
        if (typeof body.variant !== "string" || !body.variant || typeof body.quietHoursEnabled !== "boolean") {
          return new Response(JSON.stringify({ error: "variant and quietHoursEnabled required" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (body.quietHoursOverride !== undefined && !VALID_OVERRIDE.has(body.quietHoursOverride)) {
          return new Response(JSON.stringify({ error: "invalid quietHoursOverride" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        await ctx.runMutation((internal as any).alertRules.setQuietHoursForUser, {
          userId,
          variant: body.variant,
          quietHoursEnabled: body.quietHoursEnabled,
          quietHoursStart: body.quietHoursStart,
          quietHoursEnd: body.quietHoursEnd,
          quietHoursTimezone: body.quietHoursTimezone,
          quietHoursOverride: body.quietHoursOverride as "critical_only" | "silence_all" | "batch_on_wake" | undefined,
          countries: Array.isArray(body.countries) ? (body.countries as string[]) : undefined,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (action === "set-digest-settings") {
        const VALID_DIGEST_MODE = new Set(["realtime", "daily", "twice_daily", "weekly"]);
        if (
          typeof body.variant !== "string" || !body.variant ||
          !VALID_DIGEST_MODE.has(body.digestMode as string)
        ) {
          return new Response(JSON.stringify({ error: "MISSING_REQUIRED_FIELDS" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        await ctx.runMutation((internal as any).alertRules.setDigestSettingsForUser, {
          userId,
          variant: body.variant,
          digestMode: body.digestMode as "realtime" | "daily" | "twice_daily" | "weekly",
          digestHour: typeof body.digestHour === "number" ? body.digestHour : undefined,
          digestTimezone: typeof body.digestTimezone === "string" ? body.digestTimezone : undefined,
          countries: Array.isArray(body.countries) ? (body.countries as string[]) : undefined,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Atomic update of (digestMode, sensitivity) and any subset of the alert-rule /
      // digest-schedule fields. Used by the settings UI's delivery-mode change flow
      // to avoid the two-call race that the legacy set-alert-rules + set-digest-settings
      // pair has against the cross-field validator.
      // See docs/archive/plans/forbid-realtime-all-events.md §1d, §1f.
      if (action === "set-notification-config") {
        const VALID_SENSITIVITY = new Set(["all", "high", "critical"]);
        const VALID_DIGEST_MODE = new Set(["realtime", "daily", "twice_daily", "weekly"]);
        if (typeof body.variant !== "string" || !body.variant) {
          return new Response(JSON.stringify({ error: "MISSING_VARIANT" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (body.sensitivity !== undefined && !VALID_SENSITIVITY.has(body.sensitivity as string)) {
          return new Response(JSON.stringify({ error: "INVALID_SENSITIVITY" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (body.digestMode !== undefined && !VALID_DIGEST_MODE.has(body.digestMode as string)) {
          return new Response(JSON.stringify({ error: "INVALID_DIGEST_MODE" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (body.countries !== undefined && !Array.isArray(body.countries)) {
          return new Response(JSON.stringify({ error: "COUNTRIES_MUST_BE_ARRAY" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (body.tickers !== undefined && !Array.isArray(body.tickers)) {
          return new Response(JSON.stringify({ error: "TICKERS_MUST_BE_ARRAY" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (body.chokepoints !== undefined && !Array.isArray(body.chokepoints)) {
          return new Response(JSON.stringify({ error: "CHOKEPOINTS_MUST_BE_ARRAY" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        try {
          await ctx.runMutation((internal as any).alertRules.setNotificationConfigForUser, {
            userId,
            variant: body.variant,
            enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
            eventTypes: Array.isArray(body.eventTypes) ? (body.eventTypes as string[]) : undefined,
            sensitivity: body.sensitivity as "all" | "high" | "critical" | undefined,
            channels: Array.isArray(body.channels) ? (body.channels as Array<"telegram" | "slack" | "email" | "discord" | "teams" | "webhook" | "web_push">) : undefined,
            aiDigestEnabled: typeof body.aiDigestEnabled === "boolean" ? body.aiDigestEnabled : undefined,
            digestMode: body.digestMode as "realtime" | "daily" | "twice_daily" | "weekly" | undefined,
            digestHour: typeof body.digestHour === "number" ? body.digestHour : undefined,
            digestTimezone: typeof body.digestTimezone === "string" ? body.digestTimezone : undefined,
            countries: Array.isArray(body.countries) ? (body.countries as string[]) : undefined,
            tickers: Array.isArray(body.tickers) ? (body.tickers as string[]) : undefined,
            chokepoints: Array.isArray(body.chokepoints) ? (body.chokepoints as string[]) : undefined,
          });
        } catch (err: unknown) {
          // Translate structured ConvexError codes into machine-readable HTTP
          // responses so the UI can route to inline helper text (400) or to
          // the upgrade flow (402). Do NOT swallow as a generic 500 — the
          // client needs the structured `error` field to render the right
          // surface. Use extractConvexErrorCode, which decodes the JSON-STRING
          // shape ctx.runMutation serializes err.data into across the function
          // boundary (see :67) — a manual `typeof data === "object"` check
          // misses every code on this path.
          const code = extractConvexErrorCode(err);
          // Preserve the ConvexError message where present — the client renders
          // it as inline helper text for INCOMPATIBLE_DELIVERY.
          const parsed = parseConvexErrorData(err);
          const message = (parsed && typeof parsed === "object")
            ? (parsed as { message?: string }).message ?? ""
            : "";
          if (code === "INCOMPATIBLE_DELIVERY" || code === "TICKERS_LIMIT_EXCEEDED" || code === "COUNTRIES_LIMIT_EXCEEDED" || code === "CHOKEPOINTS_INVALID") {
            return new Response(JSON.stringify({ error: code, message }), { status: 400, headers: { "Content-Type": "application/json" } });
          }
          if (code === "PRO_REQUIRED") {
            // 402 Payment Required — the canonical HTTP status for paywall-gated
            // content. Client reads `error: "PRO_REQUIRED"` to route to the
            // upgrade flow rather than show a generic failure toast.
            return new Response(JSON.stringify({ error: code, message }), { status: 402, headers: { "Content-Type": "application/json" } });
          }
          throw err;
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers: { "Content-Type": "application/json" } });
    } catch (err: unknown) {
      const code = extractConvexErrorCode(err);
      if (code === "EMAIL_OWNERSHIP_REQUIRED" || code === "PRO_REQUIRED") {
        return new Response(JSON.stringify({ error: code }), { status: code === "PRO_REQUIRED" ? 402 : 400, headers: { "Content-Type": "application/json" } });
      }
      console.error('[notification-channels] Operation failed', err);
      return new Response(JSON.stringify({ error: 'Operation failed' }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }),
});

// Service-to-service: Railway digest cron fetches due rules (no user JWT required).
http.route({
  path: "/relay/digest-rules",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = await authorizeTenantRelay(request, ["delivery"]);
    if (unauthorized) return unauthorized;
    const rules = await ctx.runQuery((internal as any).alertRules.getDigestRules);
    return new Response(JSON.stringify(rules), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// Service-to-service: the notification relay fetches ALL enabled rules (it
// fans out alerts + drains quiet-hours batches). Wraps the INTERNAL
// `alertRules.getByEnabled` (GHSA-r649-4cqj-w93h) behind the shared secret so
// the cross-tenant scan is never reachable anonymously. `?enabled=false`
// selects the disabled set; defaults to enabled=true (all the relay ever asks).
http.route({
  path: "/relay/enabled-rules",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = await authorizeTenantRelay(request, ["delivery"]);
    if (unauthorized) return unauthorized;
    const enabled = new URL(request.url).searchParams.get("enabled") !== "false";
    const rules = await ctx.runQuery(
      (internal as any).alertRules.getByEnabled,
      { enabled },
    );
    return new Response(JSON.stringify(rules), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/relay/user-preferences",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = await authorizeTenantRelay(request, ["delivery"]);
    if (unauthorized) return unauthorized;
    const body = await parseJsonObjectBody<{ userId?: string; variant?: string }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!body.userId || typeof body.variant !== "string") {
      return new Response(JSON.stringify({ error: "userId and variant required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!isPreferenceVariant(body.variant)) {
      return new Response(JSON.stringify({ error: "INVALID_VARIANT" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const prefs = await ctx.runQuery(
      (internal as any).userPreferences.getPreferencesByUserId,
      { userId: body.userId, variant: body.variant },
    );
    return new Response(JSON.stringify(prefs?.data ?? null), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// Followed-countries relay (plan U14). Mirrors `/relay/user-preferences`:
// shared-secret auth in the Authorization header, POST {userId} body, returns
// `{ countries: string[] }`. Used by server-side cron consumers (PR C brief
// composer) that need a typed `string[]` watchlist for a given user without
// going through the Clerk-authenticated `listFollowed` query.
http.route({
  path: "/relay/followed-countries",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = await authorizeTenantRelay(request, ["gateway", "delivery"]);
    if (unauthorized) return unauthorized;
    const body = await parseJsonObjectBody<{ userId?: unknown }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    // P2 #19 — Mirror /relay/user-preferences validation rigor: userId
    // must be a non-empty string with bounded length (Clerk subjects are
    // short, ~30 chars; cap at 256 defensively).
    if (
      typeof body.userId !== "string" ||
      body.userId.length === 0 ||
      body.userId.length > 256
    ) {
      return new Response(JSON.stringify({ error: "userId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const countries = await ctx.runQuery(
      internal.followedCountries.internalListFollowedForUser,
      { userId: body.userId },
    );
    return new Response(JSON.stringify({ countries }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/relay/entitlement",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = await authorizeTenantRelay(request, ["delivery"]);
    if (unauthorized) return unauthorized;
    const body = await parseJsonObjectBody<{ userId?: string }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!body.userId) {
      return new Response(JSON.stringify({ error: "userId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const ent = await ctx.runQuery(
      internal.entitlements.getEntitlementsByUserId,
      { userId: body.userId },
    );
    const tier = ent?.features?.tier ?? 0;
    return new Response(JSON.stringify({ tier }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ---------------------------------------------------------------------------
// Referral code registration (Phase 9 / Todo #223)
// ---------------------------------------------------------------------------

// Edge-route companion for /api/referral/me. Binds a Clerk-derived
// 8-char share code to the signed-in user's Clerk userId so future
// /pro?ref=<code> signups can credit the sharer via the
// userReferralCredits path in registerInterest:register. Auth is
// server-to-server via CONVEX_TENANT_RELAY_SECRET — the edge route already
// validated the caller's Clerk bearer before hitting this.
http.route({
  path: "/relay/register-referral-code",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = await authorizeTenantRelay(request, ["gateway"]);
    if (unauthorized) return unauthorized;
    const body = await parseJsonObjectBody<{ userId?: string; code?: string }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!userId || !code || code.length < 4 || code.length > 32) {
      return new Response(JSON.stringify({ error: "userId + code required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const result = await ctx.runMutation(
      (internal as any).registerInterest.registerUserReferralCode,
      { userId, code },
    );
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ---------------------------------------------------------------------------
// User API key validation (service-to-service only)
// ---------------------------------------------------------------------------

// Schedule-site half of the lastUsedAt debounce (the mutation-side half lives
// in touchKeyLastUsed / touchProMcpTokenLastUsed). Scheduling a touch on
// EVERY validation meant that at each debounce boundary all concurrently
// scheduled touches read the same stale lastUsedAt and patched the same hot
// document — 1,036 OCC write conflicts on userApiKeys in 14 days at up to
// retry depth 3 (Convex Insights, 2026-08). A fresh lastUsedAt makes the
// touch a guaranteed no-op, so don't enqueue it at all; only genuinely stale
// (or never-touched) rows schedule, which also drops one scheduled job per
// validation off the scheduler.
function touchIsDue(lastUsedAt: unknown): boolean {
  return typeof lastUsedAt !== "number" || lastUsedAt <= Date.now() - TOUCH_DEBOUNCE_MS;
}

// The gate cannot stop a burst: every parallel validation that lands before
// the first touch commits still sees a stale lastUsedAt, and touches scheduled
// for the same instant conflict N-1 times (560 OCC conflicts in 72h across
// userApiKeys + mcpProTokens, Convex Insights 2026-10). A random delay makes
// the rest start after the first commits, read it, and no-op, except a touch
// that lands within its ~20ms run: about (N-1) x 20ms / 30s per burst. On a
// local backend, herds of 5 went from 4 conflicts each to 0.
const TOUCH_SPREAD_MS = 30_000;

function touchDelayMs(): number {
  return Math.floor(Math.random() * TOUCH_SPREAD_MS);
}

// Service-to-service: validate a user API key by its SHA-256 hash.
// Called by the Vercel edge gateway to look up user-owned keys.
http.route({
  path: "/api/internal-validate-api-key",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ keyHash?: unknown }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.keyHash !== "string" || body.keyHash.length === 0) {
      return new Response(JSON.stringify({ error: "MISSING_KEY_HASH" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await ctx.runQuery(
      (internal as any).apiKeys.validateKeyByHash,
      { keyHash: body.keyHash },
    );

    if (result && touchIsDue(result.lastUsedAt)) {
      try {
        await ctx.scheduler.runAfter(touchDelayMs(), (internal as any).apiKeys.touchKeyLastUsed, { keyId: result.id });
      } catch (err) {
        // sentry-coverage-ok: re-throwing here would 500 the gateway, which coerces to null
        // and stamps a 60s negative-cache sentinel for a valid key. lastUsedAt is best-effort telemetry.
        console.warn("[validate-api-key] touchKeyLastUsed schedule failed:", err instanceof Error ? err.message : String(err));
      }
    }

    // Strip the gate's input from the response: the gateway caches this blob
    // in Redis for 60s and its shape is load-bearing (isUserKeyResult in
    // api/_user-api-key.js) — lastUsedAt exists for the gate above only.
    const publicResult = result
      ? (({ lastUsedAt: _lastUsedAt, ...rest }) => rest)(result)
      : null;

    return new Response(JSON.stringify(publicResult), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// Service-to-service: look up the owner of a key by hash (regardless of revoked status).
// Used by the cache-invalidation endpoint to verify tenancy boundaries.
http.route({
  path: "/api/internal-get-key-owner",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ keyHash?: unknown }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.keyHash !== "string" || !/^[a-f0-9]{64}$/.test(body.keyHash)) {
      return new Response(JSON.stringify({ error: "INVALID_KEY_HASH" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await ctx.runQuery(
      (internal as any).apiKeys.getKeyOwner,
      { keyHash: body.keyHash },
    );

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// Service-to-service: validate a partner-embed key by its SHA-256 hash.
// Separate from /api/internal-validate-api-key on purpose — the two credential
// surfaces must never resolve through one another's table.
http.route({
  path: "/api/internal-validate-embed-key",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ keyHash?: unknown }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.keyHash !== "string" || !/^[a-f0-9]{64}$/.test(body.keyHash)) {
      return new Response(JSON.stringify({ error: "INVALID_KEY_HASH" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await ctx.runQuery(
      (internal as any).embedKeys.validateKeyByHash,
      { keyHash: body.keyHash },
    );

    if (result && touchIsDue(result.lastUsedAt)) {
      try {
        await ctx.scheduler.runAfter(touchDelayMs(), (internal as any).embedKeys.touchKeyLastUsed, { keyId: result.id });
      } catch (err) {
        // sentry-coverage-ok: re-throwing here would 500 the edge validator, which
        // coerces to null and stamps a negative-cache sentinel for a valid key.
        // lastUsedAt is best-effort telemetry.
        console.warn("[validate-embed-key] touchKeyLastUsed schedule failed:", err instanceof Error ? err.message : String(err));
      }
    }

    // Strip the gate's input from the response for the same reason the API-key
    // route does: the edge caches this blob and its shape is load-bearing.
    const publicResult = result
      ? (({ lastUsedAt: _lastUsedAt, ...rest }) => rest)(result)
      : null;

    return new Response(JSON.stringify(publicResult), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ---------------------------------------------------------------------------
// Pro MCP token routes (service-to-service, x-convex-shared-secret auth).
// Called by the Vercel edge (api/oauth/authorize-pro, api/mcp.ts, settings).
// See plan U1 / docs/plans/2026-05-10-001-feat-pro-mcp-clerk-auth-quota-plan.md
// ---------------------------------------------------------------------------

http.route({
  path: "/resend-webhook",
  method: "POST",
  handler: resendWebhookHandler,
});

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: clerkWebhookHandler,
});

// Bulk email suppression: service-to-service, authenticated via CONVEX_EMAIL_SUPPRESSION_SECRET.
// Used by the one-time import script (scripts/import-bounced-emails.mjs).
http.route({
  path: "/relay/bulk-suppress-emails",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = await authorizeTenantRelay(request, ["suppression"]);
    if (unauthorized) return unauthorized;

    const body = await parseJsonObjectBody<{
      emails: Array<{
        email: string;
        reason: "bounce" | "complaint" | "manual";
        source?: string;
      }>;
    }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!Array.isArray(body.emails) || body.emails.length === 0) {
      return new Response(
        JSON.stringify({ error: "MISSING_FIELDS", required: ["emails"] }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const result = await ctx.runMutation(
        internal.emailSuppressions.bulkSuppress,
        { emails: body.emails },
      );
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bulk suppress failed";
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

export default http;
