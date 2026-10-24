import type { AuthSession } from '@/services/auth-state';
import type { AccessContextSnapshot } from '@/services/webmcp';

/** Keys that must never appear on a WebMCP access snapshot or bounded result. */
export const ACCESS_CONTEXT_PRIVACY_KEYS = [
  'email',
  'name',
  'userId',
  'id',
  'token',
  'sessionId',
  'image',
  'session',
] as const;

export interface WebMcpAccessContextInput {
  auth: AuthSession;
  clerkEnabled: boolean;
  clerkReady: boolean;
  enabledPanelUsed: number;
  dashboardTabCount: number;
}

export interface OpenSignInDecisionInput {
  clerkEnabled: boolean;
  clerkReady: boolean;
  alreadyOpen: boolean;
  loadFailed?: boolean;
}

export type OpenSignInDecision =
  | { action: 'open' }
  | { action: 'load_and_open' }
  | { ok: true; status: 'already_open'; reason: 'already_open' }
  | { ok: false; status: 'denied'; reason: 'clerk_unavailable' };

function nonNegativeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Bounded, PII-free access snapshot for WebMCP. */
export function buildWebMcpAccessContext(
  input: WebMcpAccessContextInput,
): AccessContextSnapshot {
  const accountState = input.auth.isPending
    ? 'loading'
    : input.auth.user
      ? 'signed_in'
      : 'signed_out';

  let clerk: AccessContextSnapshot['clerk'];
  if (!input.clerkEnabled) clerk = 'unavailable';
  else if (input.clerkReady) clerk = 'ready';
  else if (input.auth.isPending) clerk = 'loading';
  else clerk = 'unavailable';

  return {
    accountState,
    clerk,
    usage: {
      enabledPanels: nonNegativeCount(input.enabledPanelUsed),
      dashboardTabs: nonNegativeCount(input.dashboardTabCount),
    },
  };
}

export function resolveWebMcpOpenSignIn(
  input: OpenSignInDecisionInput,
): OpenSignInDecision {
  if (!input.clerkEnabled || input.loadFailed === true) {
    return { ok: false, status: 'denied', reason: 'clerk_unavailable' };
  }
  if (input.alreadyOpen) {
    return { ok: true, status: 'already_open', reason: 'already_open' };
  }
  return input.clerkReady ? { action: 'open' } : { action: 'load_and_open' };
}
