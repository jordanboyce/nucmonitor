import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

function caller(email: string | undefined, emailVerified = true) {
  return {
    subject: "user-partner",
    tokenIdentifier: "clerk|user-partner",
    ...(email ? { email, emailVerified } : {}),
  };
}

describe("partnerAccess", () => {
  test("an invited email is admitted, case-insensitively", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.partnerAccess.invite, { email: "Ops@Utility.com", organization: "Utility Co" });
    expect(await t.withIdentity(caller("ops@utility.com")).query(api.partnerAccess.isInvited, {})).toBe(true);
    expect(await t.withIdentity(caller("other@utility.com")).query(api.partnerAccess.isInvited, {})).toBe(false);
  });

  test("a domain invite admits every verified address on that domain", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.partnerAccess.invite, { domain: "@vendor.example" });
    expect(await t.withIdentity(caller("a@vendor.example")).query(api.partnerAccess.isInvited, {})).toBe(true);
    expect(await t.withIdentity(caller("a@notvendor.example")).query(api.partnerAccess.isInvited, {})).toBe(false);
  });

  test("unverified, missing or anonymous identities are refused", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.partnerAccess.invite, { domain: "vendor.example" });
    expect(await t.withIdentity(caller("a@vendor.example", false)).query(api.partnerAccess.isInvited, {})).toBe(false);
    expect(await t.withIdentity(caller(undefined)).query(api.partnerAccess.isInvited, {})).toBe(false);
    expect(await t.query(api.partnerAccess.isInvited, {})).toBe(false);
  });

  test("invites are idempotent and revocable", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.partnerAccess.invite, { email: "ops@utility.com" })).toMatchObject({ created: true });
    expect(await t.mutation(internal.partnerAccess.invite, { email: "ops@utility.com" })).toMatchObject({ created: false });
    expect(await t.query(internal.partnerAccess.listInvites, {})).toHaveLength(1);
    expect(await t.mutation(internal.partnerAccess.revoke, { email: "ops@utility.com" })).toMatchObject({ removed: true });
    expect(await t.withIdentity(caller("ops@utility.com")).query(api.partnerAccess.isInvited, {})).toBe(false);
  });

  test("an invite names exactly one well-formed email or domain", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(internal.partnerAccess.invite, {})).rejects.toThrow();
    await expect(t.mutation(internal.partnerAccess.invite, { email: "a@b.co", domain: "b.co" })).rejects.toThrow();
    await expect(t.mutation(internal.partnerAccess.invite, { email: "not-an-email" })).rejects.toThrow();
    await expect(t.mutation(internal.partnerAccess.invite, { domain: "localhost" })).rejects.toThrow();
  });

  test("grantApiAccess writes an entitlement that carries apiAccess", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.partnerAccess.grantApiAccess, { userId: "user-partner" });
    await t.mutation(internal.partnerAccess.grantApiAccess, { userId: "user-partner", days: 30 });
    const rows = await t.run((ctx) => ctx.db.query("entitlements").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.features.apiAccess).toBe(true);
    expect(rows[0]!.validUntil).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });
});
