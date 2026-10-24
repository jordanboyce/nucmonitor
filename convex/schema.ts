import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// NucMonitor keeps only what partner access (docs/partner-access.md) and the
// signed-in cloud preference sync need. There are no plans, subscriptions or
// per-user API keys.
export default defineSchema({
  // Partner access (docs/partner-access.md): who may sign in to a deployment
  // running ACCESS_MODE=partner, in addition to PARTNER_ALLOWED_* env. One row
  // per invited email or whole email domain; written only by internal
  // mutations an operator runs with `npx convex run`.
  partnerInvites: defineTable({
    kind: v.union(v.literal("email"), v.literal("domain")),
    // Lowercased email address, or bare domain without "@".
    value: v.string(),
    organization: v.optional(v.string()),
    note: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_kind_value", ["kind", "value"]),

  // Access requests from the public landing page (api/request-access.ts).
  // One row per email; a repeat submission refreshes the row rather than
  // adding another. Reviewed with `npx convex run partnerAccess:listAccessRequests`.
  accessRequests: defineTable({
    email: v.string(),
    emailDomain: v.string(),
    organization: v.string(),
    role: v.optional(v.string()),
    message: v.optional(v.string()),
    source: v.string(),
    status: v.union(v.literal("new"), v.literal("invited"), v.literal("declined")),
    createdAt: v.number(),
    updatedAt: v.number(),
    submissions: v.number(),
  }).index("by_email", ["email"]).index("by_status", ["status"]),

  userPreferences: defineTable({
    userId: v.string(),
    variant: v.string(),
    data: v.any(),
    schemaVersion: v.number(),
    updatedAt: v.number(),
    syncVersion: v.number(),
  }).index("by_user_variant", ["userId", "variant"]),

  userPreferenceWriteRateLimits: defineTable({
    userId: v.string(),
    windowStart: v.number(),
    count: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_window", ["userId", "windowStart"])
    // Retention scan for `pruneStaleWriteRateLimits` (#6706). Expired-window
    // rows are garbage-collected off the write path, so the sweep needs a
    // cross-user range on age alone; without it the prune would be a full
    // table scan whose read set collides with every live counter.
    .index("by_windowStart", ["windowStart"]),
});
