/**
 * Partner invites for ACCESS_MODE=partner deployments (docs/partner-access.md).
 *
 * The edge asks `isInvited` with the caller's own Clerk token, so the answer
 * is about the signed-in account and needs no shared secret. Everything that
 * changes the list is internal: operators run it with `npx convex run`.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { getFeaturesForPlan } from "./lib/entitlements";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/;
// Partner API keys reuse the existing per-user key flow; the gateway requires
// the key owner's entitlement to carry apiAccess, which this plan grants.
const PARTNER_API_PLAN_KEY = "enterprise";
const PARTNER_API_VALID_DAYS = 365;

function normalizeEmail(email: string): string {
  const value = email.trim().toLowerCase();
  if (!EMAIL_RE.test(value)) throw new ConvexError("INVALID_EMAIL");
  return value;
}

function normalizeDomain(domain: string): string {
  const value = domain.trim().toLowerCase().replace(/^@/, "");
  if (!DOMAIN_RE.test(value)) throw new ConvexError("INVALID_DOMAIN");
  return value;
}

function target(args: { email?: string; domain?: string }): { kind: "email" | "domain"; value: string } {
  if (args.email && !args.domain) return { kind: "email", value: normalizeEmail(args.email) };
  if (args.domain && !args.email) return { kind: "domain", value: normalizeDomain(args.domain) };
  throw new ConvexError("PASS_EXACTLY_ONE_OF_EMAIL_OR_DOMAIN");
}

async function findInvite(ctx: QueryCtx, kind: "email" | "domain", value: string) {
  return await ctx.db
    .query("partnerInvites")
    .withIndex("by_kind_value", (q) => q.eq("kind", kind).eq("value", value))
    .first();
}

/** Whether the signed-in caller's verified email (or its domain) is invited. */
export const isInvited = query({
  args: {},
  handler: async (ctx): Promise<boolean> => {
    const identity = await ctx.auth.getUserIdentity();
    const email = identity?.email?.trim().toLowerCase();
    if (!email || identity?.emailVerified === false) return false;
    if (await findInvite(ctx, "email", email)) return true;
    const domain = email.slice(email.lastIndexOf("@") + 1);
    return Boolean(domain && await findInvite(ctx, "domain", domain));
  },
});

/** `npx convex run partnerAccess:invite '{"email":"ops@utility.com","organization":"Utility Co"}'` */
export const invite = internalMutation({
  args: {
    email: v.optional(v.string()),
    domain: v.optional(v.string()),
    organization: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { kind, value } = target(args);
    const existing = await findInvite(ctx, kind, value);
    if (existing) return { created: false, kind, value };
    await ctx.db.insert("partnerInvites", {
      kind,
      value,
      ...(args.organization ? { organization: args.organization } : {}),
      ...(args.note ? { note: args.note } : {}),
      createdAt: Date.now(),
    });
    return { created: true, kind, value };
  },
});

/** `npx convex run partnerAccess:revoke '{"email":"ops@utility.com"}'` */
export const revoke = internalMutation({
  args: { email: v.optional(v.string()), domain: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { kind, value } = target(args);
    const existing = await findInvite(ctx, kind, value);
    if (existing) await ctx.db.delete(existing._id);
    return { removed: Boolean(existing), kind, value };
  },
});

/** `npx convex run partnerAccess:listInvites` */
export const listInvites = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("partnerInvites").collect();
    return rows.map(({ kind, value, organization, note, createdAt }) => ({
      kind,
      value,
      organization,
      note,
      createdAt,
    }));
  },
});

/**
 * Let a partner account create API keys that the gateway accepts.
 * `npx convex run partnerAccess:grantApiAccess '{"userId":"user_..."}'`
 */
export const grantApiAccess = internalMutation({
  args: { userId: v.string(), days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const days = Math.max(1, Math.min(args.days ?? PARTNER_API_VALID_DAYS, 3650));
    const row = {
      userId: args.userId,
      planKey: PARTNER_API_PLAN_KEY,
      features: getFeaturesForPlan(PARTNER_API_PLAN_KEY),
      validUntil: now + days * 86_400_000,
      updatedAt: now,
    };
    const existing = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("entitlements", row);
    return { userId: args.userId, validUntil: row.validUntil };
  },
});

// ── Access requests (landing page) ────────────────────────────────────────

const MAX_FIELD = { email: 254, organization: 120, role: 80, message: 1000 } as const;

function clean(value: string | undefined, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Record a request for partner access from the public landing page. Called
 * by the edge function `api/request-access.ts` after its own validation and
 * rate limit; the mutation re-validates so a direct call cannot store junk.
 */
export const requestAccess = mutation({
  args: {
    email: v.string(),
    organization: v.string(),
    role: v.optional(v.string()),
    message: v.optional(v.string()),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = normalizeEmail(clean(args.email, MAX_FIELD.email));
    const organization = clean(args.organization, MAX_FIELD.organization);
    if (!organization) throw new ConvexError("ORGANIZATION_REQUIRED");
    const role = clean(args.role, MAX_FIELD.role) || undefined;
    const message = clean(args.message, MAX_FIELD.message) || undefined;
    const source = clean(args.source, 40) || "landing";
    const now = Date.now();
    const existing = await ctx.db
      .query("accessRequests")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        organization,
        ...(role ? { role } : {}),
        ...(message ? { message } : {}),
        updatedAt: now,
        submissions: existing.submissions + 1,
      });
      return { created: false, email };
    }
    await ctx.db.insert("accessRequests", {
      email,
      emailDomain: email.slice(email.lastIndexOf("@") + 1),
      organization,
      ...(role ? { role } : {}),
      ...(message ? { message } : {}),
      source,
      status: "new",
      createdAt: now,
      updatedAt: now,
      submissions: 1,
    });
    return { created: true, email };
  },
});

/** `npx convex run partnerAccess:listAccessRequests` (newest first). */
export const listAccessRequests = internalQuery({
  args: { status: v.optional(v.union(v.literal("new"), v.literal("invited"), v.literal("declined"))) },
  handler: async (ctx, args) => {
    const rows = args.status
      ? await ctx.db.query("accessRequests").withIndex("by_status", (q) => q.eq("status", args.status!)).collect()
      : await ctx.db.query("accessRequests").collect();
    return rows
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ email, emailDomain, organization, role, message, source, status, createdAt, updatedAt, submissions }) => ({
        email, emailDomain, organization, role, message, source, status, createdAt, updatedAt, submissions,
      }));
  },
});

/** `npx convex run partnerAccess:setAccessRequestStatus '{"email":"ops@utility.com","status":"invited"}'` */
export const setAccessRequestStatus = internalMutation({
  args: { email: v.string(), status: v.union(v.literal("new"), v.literal("invited"), v.literal("declined")) },
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    const existing = await ctx.db
      .query("accessRequests")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (!existing) return { updated: false, email };
    await ctx.db.patch(existing._id, { status: args.status, updatedAt: Date.now() });
    return { updated: true, email };
  },
});
