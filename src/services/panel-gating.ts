/**
 * Premium access, panel gate reasons, and CTA routing.
 *
 * Per-gate logic does NOT live here (#5813). Each gate owns a pure resolver
 * leaf plus a reader beside it under `gates/` — `gates/export.ts` (data export
 * + dashboard tab cap) and `gates/playback.ts` (historical playback). A fourth
 * gate gets its own pair there, not another `readX`/`evaluateX` in this file.
 *
 * What stays here is what every gate shares: the access predicate
 * (`hasPremiumAccess`), the reason enum and its billing-aware refinement, and
 * the CTA action resolver. Gate modules import from this file; it imports from
 * none of them, so the dependency runs one way.
 */

import type { AuthSession } from './auth-state';
import { getEntitlementState } from './entitlements';
import type { ClientEntitlementBelief } from './premium-denial';
import { getSecretState } from './runtime-config';
import { isProUser } from './widget-store';

export enum PanelGateReason {
  NONE = 'none',           // show content (pro user, or desktop with API key, or non-premium panel)
  ANONYMOUS = 'anonymous', // "Sign In to Unlock"
  FREE_TIER = 'free_tier', // "Upgrade to Pro"
  // #4771 billing-aware refinements of FREE_TIER — the user has (or had) paid
  // evidence, so a generic Upgrade CTA would be misleading.
  PAYMENT_ON_HOLD = 'payment_on_hold', // "Update Payment" (payment failed, retry window)
  RENEWAL_PENDING = 'renewal_pending', // "Refresh Status" (renewal verification in progress)
  RENEWAL_FAILED = 'renewal_failed',   // "Manage Billing" (provider check failed)
  LAPSED = 'lapsed',                   // "Resubscribe" (provider confirmed coverage ended)
}

/**
 * Single source of truth for premium access.
 * Covers all access paths: desktop API key, tester keys (wm-pro-key / wm-widget-key),
 * Clerk Pro role, and Convex Dodo entitlement (the latter two via isProUser).
 *
 * The Convex entitlement check is the authoritative signal for paying
 * customers — Clerk `publicMetadata.plan` is NOT written by our webhook
 * pipeline, so a user with a valid Dodo subscription would otherwise show
 * as free here even though isPanelEntitled() already allowed them past
 * the panel-rendering gate. That split caused paying users to see the
 * "Upgrade to Pro" paywall overlay on top of panels they were entitled to,
 * reproducing the 2026-04-17/18 duplicate-subscription incident.
 *
 * isEntitled() is folded into isProUser() (see widget-store.ts) so every
 * call site that checks isProUser — widgets, search, event handlers —
 * agrees with panel gating. That keeps this function a thin union of
 * signals that aren't already covered by isProUser.
 */
export function hasPremiumAccess(authState?: AuthSession): boolean {
  return readPremiumAccessGrant(authState) !== 'none';
}

/** Which arm of `hasPremiumAccess` answered. `none` means no arm did. */
export type PremiumAccessGrant = 'api_key' | 'pro_user' | 'auth_role' | 'none';

/**
 * The same union as `hasPremiumAccess`, reported rather than collapsed.
 * TELEMETRY ONLY — no gate may branch on the arm, or the arms stop being
 * interchangeable and this becomes a second, subtly different access rule.
 *
 * It exists because the boolean is lossy exactly where it matters. `api_key`
 * and the tester-key half of `pro_user` unlock panels from browser-local
 * state and, as the comment above says, assert nothing about the signed-in
 * account — so a `true` does NOT imply the premium fetch will carry a
 * user-bound credential. WORLDMONITOR-147 is that gap: the scorecard widget
 * only fetches when this returns premium, yet one request reached the gateway
 * as `auth_kind: anon` (against 51 `clerk_jwt` 200s on the same route in the
 * same 22h) and came back 401. The event could not say which arm had granted
 * access, so a second occurrence would have proved no more than the first.
 *
 * `hasPremiumAccess` is defined in terms of this function so the two can never
 * drift on the membership or the ORDER of the union — the order is load-bearing
 * for the report, since earlier arms shadow later ones.
 */
export function readPremiumAccessGrant(authState?: AuthSession): PremiumAccessGrant {
  if (getSecretState('WORLDMONITOR_API_KEY').present) return 'api_key';
  if (isProUser()) return 'pro_user';
  if (authState?.user?.role === 'pro') return 'auth_role';
  return 'none';
}

/**
 * Snapshot what the CLIENT believes about this account's plan, for
 * `classifyPremiumDenial` (#5608). Deliberately narrower than
 * hasPremiumAccess: the desktop API key and the browser tester keys unlock
 * panels locally but assert nothing about the signed-in Clerk account, so
 * they must not suppress a legitimate upgrade CTA.
 */
export function readClientEntitlementBelief(authState: AuthSession): ClientEntitlementBelief {
  return {
    entitlementTier: getEntitlementState()?.features.tier ?? null,
    authRole: authState.user?.role ?? null,
  };
}

/**
 * Determine gating reason for a premium panel given current auth state.
 * Non-premium panels always return NONE.
 */
export function getPanelGateReason(
  authState: AuthSession,
  isPremium: boolean,
): PanelGateReason {
  // Non-premium panels are never gated
  if (!isPremium) return PanelGateReason.NONE;

  // API key, tester key, or Clerk Pro: always unlocked
  if (hasPremiumAccess(authState)) return PanelGateReason.NONE;

  // Web gating based on Clerk auth state
  if (!authState.user) return PanelGateReason.ANONYMOUS;
  return PanelGateReason.FREE_TIER;
}

/**
 * Billing-aware refinement of a FREE_TIER verdict. NucMonitor has no billing,
 * so every reason passes through untouched.
 */
export function resolveBillingAwareGateReason(reason: PanelGateReason): PanelGateReason {
  return reason;
}

/**
 * Every locked surface routes its CTA through here. Extracted from
 * `PanelLayoutManager.getGateAction` (which was private and closed over
 * `ctx.authModal`) so the export gate, the panel gate and future gates cannot
 * drift — the auth-modal opener is injected instead.
 */
export interface GateActionDeps {
  /** Opens the sign-in modal for the ANONYMOUS reason. */
  openAuthModal: () => void;
  /** Unused since billing was removed; kept so existing callers compile. */
  planKey?: string | null;
}

/**
 * Return the action callback for a given gate reason. Only sign-in remains a
 * real action: there is no pricing page or billing portal to send anyone to.
 */
export function resolveGateAction(reason: PanelGateReason, deps: GateActionDeps): () => void {
  if (reason === PanelGateReason.ANONYMOUS) return () => deps.openAuthModal();
  return () => {};
}
