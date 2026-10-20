/**
 * Client entitlements for NucMonitor's partner access model.
 *
 * There are no paid plans. Whoever reaches the dashboard has already passed the
 * deployment's access gate (public demo, or a signed-in allowlisted partner —
 * see src/services/partner-access.ts), so every feature is unlocked. The state
 * is a constant "partner" grant rather than a Convex subscription; the module
 * keeps its former API so feature checks across the app stay single-sourced.
 */

export interface EntitlementState {
  planKey: string;
  features: {
    tier: number;
    apiAccess: boolean;
    apiRateLimit: number;
    planLimits?: {
      apiRequestsPerDay: number | null;
      apiBurstRequestsPerMinute: number | null;
      /** `"shared-api-budget"` = no separate MCP allowance; MCP calls charge
       *  `apiRequestsPerDay`. Mirrors `PlanLimits` in convex/config/productCatalog.ts. */
      mcpCallsPerDay: number | null | "shared-api-budget";
      mcpBurstRequestsPerMinute: number | null;
      dashboardAiCallsPerDay?: number | null;
    };
    maxDashboards: number;
    prioritySupport: boolean;
    exportFormats: string[];
    /**
     * Pro MCP access (plan 2026-05-10-001). Undefined on legacy entitlement
     * snapshots that pre-date the catalog field. `hasFeature('mcpAccess')`
     * coerces undefined → false via Boolean(), so the settings tab
     * fails-closed for unrefreshed Pro users (they'll see it appear once
     * Dodo's next webhook repopulates the field).
     */
    mcpAccess?: boolean;
    /**
     * Data-export entitlement (plan 2026-07-25-001). This controls the locked
     * state while `exportFormats` controls which CSV/JSON/PDF actions the
     * unlocked menu exposes; `tier` cannot discriminate because Pro Business
     * shares tier 1 with Pro.
     * Undefined on legacy snapshots: the export gate treats undefined on a
     * `tier >= 2` snapshot as entitled (permanent fail-open) so a stale row
     * never locks a paying customer out of their own data.
     */
    dataExport?: boolean;
    /**
     * Partner-embed key issuance (`wme_…`). Deliberately separate from
     * `apiAccess`: both Pro tiers sell embedding without REST access, so
     * gating the Embeds tab on `apiAccess` would hide it from most of the
     * customers who bought it. Undefined on snapshots older than the catalog
     * field; the account gate also accepts a verified Clerk PRO role while the
     * Convex snapshot hydrates.
     */
    embedAccess?: boolean;
  };
  validUntil: number;
}

/**
 * Account-scoped progress for resolving the current entitlement snapshot.
 * The partner grant is static, so verification is always `ready`.
 */
export type EntitlementVerificationStatus =
  | 'idle'
  | 'pending'
  | 'ready'
  | 'unavailable';

/** The single access level: everything the app offers. */
export const PARTNER_ENTITLEMENT: EntitlementState = Object.freeze({
  planKey: 'partner',
  features: Object.freeze({
    tier: 3,
    apiAccess: true,
    apiRateLimit: 0,
    maxDashboards: 50,
    prioritySupport: true,
    exportFormats: ['csv', 'json', 'pdf'],
    mcpAccess: false,
    dataExport: true,
    embedAccess: true,
  }),
  validUntil: Number.MAX_SAFE_INTEGER,
}) as EntitlementState;

export function beginEntitlementVerification(): void {}

export function markEntitlementVerificationUnavailable(): void {}

export function resetEntitlementVerification(): void {}

/** No-op: the partner grant needs no subscription. Kept for existing callers. */
export async function initEntitlementSubscription(
  _userId?: string,
  _isCurrent: () => boolean = () => true,
): Promise<void> {}

export function destroyEntitlementSubscription(): void {}

export function resetEntitlementState(): void {}

/** Replays the constant grant; it never changes, so nothing else is emitted. */
export function onEntitlementChange(
  cb: (state: EntitlementState | null) => void,
): () => void {
  cb(PARTNER_ENTITLEMENT);
  return () => {};
}

export function onEntitlementVerificationChange(
  cb: (status: EntitlementVerificationStatus) => void,
): () => void {
  cb('ready');
  return () => {};
}

export function getEntitlementVerificationStatus(): EntitlementVerificationStatus {
  return 'ready';
}

export function getEntitlementState(): EntitlementState | null {
  return PARTNER_ENTITLEMENT;
}

export function hasFeature(flag: keyof EntitlementState['features']): boolean {
  return Boolean(PARTNER_ENTITLEMENT.features[flag]);
}

export function hasEmbedAccessForAccount(_role: 'free' | 'pro' | undefined): boolean {
  return true;
}

export function hasTier(minTier: number): boolean {
  return PARTNER_ENTITLEMENT.features.tier >= minTier;
}

/** @internal Snapshot predicate kept for shared callers and tests. */
export function isEntitlementActive(
  state: EntitlementState | null,
  now: number,
): boolean {
  return state !== null && state.planKey !== 'free' && state.validUntil >= now;
}

export function isEntitled(): boolean {
  return true;
}

export function shouldReloadOnEntitlementChange(
  _last: boolean | null,
  _next: boolean,
): boolean {
  return false;
}
