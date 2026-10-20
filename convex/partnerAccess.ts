/**
 * Partner invites for ACCESS_MODE=partner deployments (docs/partner-access.md).
 *
 * The edge asks `isInvited` with the caller's own Clerk token, so the answer
 * is about the signed-in account and needs no shared secret. Everything that
 * changes the list is internal: operators run it with `npx convex run`.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
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
