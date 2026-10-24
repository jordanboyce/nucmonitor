import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACCESS_CONTEXT_PRIVACY_KEYS,
  buildWebMcpAccessContext,
  resolveWebMcpOpenSignIn,
} from '../src/services/webmcp-access-snapshot.ts';
import { boundWebMcpAccessContext } from '../src/services/webmcp.ts';

const SIGNED_OUT_AUTH = { user: null, isPending: false } as const;
const LOADING_AUTH = { user: null, isPending: true } as const;
const SIGNED_IN_AUTH = {
  user: {
    id: 'user_secret_id',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    image: 'https://example.com/ada.png',
  },
  isPending: false,
};

function signedOutInput(
  overrides: Partial<Parameters<typeof buildWebMcpAccessContext>[0]> = {},
) {
  return {
    auth: SIGNED_OUT_AUTH,
    clerkEnabled: true,
    clerkReady: true,
    enabledPanelUsed: 12,
    dashboardTabCount: 1,
    ...overrides,
  };
}

function assertNoPersonalInformation(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const key of ACCESS_CONTEXT_PRIVACY_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(value as object, key),
      false,
      `access context must not expose ${key}`,
    );
  }
  assert.doesNotMatch(serialized, /ada@example\.com/i);
  assert.doesNotMatch(serialized, /Ada Lovelace/);
  assert.doesNotMatch(serialized, /user_secret_id/);
  assert.doesNotMatch(serialized, /pk_test_|sk_live_|Bearer /);
}

describe('buildWebMcpAccessContext', () => {
  it('reports signed-out, ready Clerk, and usage counts', () => {
    const snapshot = buildWebMcpAccessContext(signedOutInput());
    assert.equal(snapshot.accountState, 'signed_out');
    assert.equal(snapshot.clerk, 'ready');
    assert.deepEqual(snapshot.usage, { enabledPanels: 12, dashboardTabs: 1 });
  });

  it('keeps loading and Clerk-unavailable states explicit', () => {
    const loading = buildWebMcpAccessContext(signedOutInput({
      auth: LOADING_AUTH,
      clerkReady: false,
    }));
    assert.equal(loading.accountState, 'loading');
    assert.equal(loading.clerk, 'loading');

    const unavailable = buildWebMcpAccessContext(signedOutInput({
      clerkEnabled: false,
      clerkReady: false,
    }));
    assert.equal(unavailable.accountState, 'signed_out');
    assert.equal(unavailable.clerk, 'unavailable');
  });

  it('treats a configured Clerk that failed to load as unavailable, not loading', () => {
    const snapshot = buildWebMcpAccessContext(signedOutInput({
      clerkEnabled: true,
      clerkReady: false,
      auth: SIGNED_OUT_AUTH,
    }));
    assert.equal(snapshot.accountState, 'signed_out');
    assert.equal(snapshot.clerk, 'unavailable');
  });

  it('floors usage counts to non-negative integers', () => {
    const snapshot = buildWebMcpAccessContext(signedOutInput({
      enabledPanelUsed: -3,
      dashboardTabCount: 2.7,
    }));
    assert.deepEqual(snapshot.usage, { enabledPanels: 0, dashboardTabs: 2 });
  });

  it('never copies personal fields even when a caller tries to inject them', () => {
    const snapshot = buildWebMcpAccessContext(signedOutInput({
      auth: SIGNED_IN_AUTH,
    }));
    const bounded = boundWebMcpAccessContext({
      ...snapshot,
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      userId: 'user_secret_id',
      token: 'sess_abc',
      sessionId: 'sess_abc',
    } as typeof snapshot & Record<string, string>, true);
    assert.equal(snapshot.accountState, 'signed_in');
    assertNoPersonalInformation(snapshot);
    assertNoPersonalInformation(bounded);
    assert.equal(bounded.targetCancellationSupported, true);
    assert.equal(
      Object.keys(bounded).sort().join(','),
      ['accountState', 'clerk', 'targetCancellationSupported', 'usage'].sort().join(','),
    );
  });
});

describe('resolveWebMcpOpenSignIn', () => {
  it('returns clerk_unavailable when Clerk is not configured or failed to load', () => {
    assert.deepEqual(
      resolveWebMcpOpenSignIn({ clerkEnabled: false, clerkReady: false, alreadyOpen: false }),
      { ok: false, status: 'denied', reason: 'clerk_unavailable' },
    );
    assert.deepEqual(
      resolveWebMcpOpenSignIn({ clerkEnabled: true, clerkReady: false, alreadyOpen: false, loadFailed: true }),
      { ok: false, status: 'denied', reason: 'clerk_unavailable' },
    );
  });

  it('returns already_open when the Clerk modal is already visible', () => {
    assert.deepEqual(
      resolveWebMcpOpenSignIn({ clerkEnabled: true, clerkReady: true, alreadyOpen: true }),
      { ok: true, status: 'already_open', reason: 'already_open' },
    );
  });

  it('asks the host to open the existing Clerk modal and never accepts credentials', () => {
    assert.deepEqual(
      resolveWebMcpOpenSignIn({ clerkEnabled: true, clerkReady: true, alreadyOpen: false }),
      { action: 'open' },
    );
    assert.deepEqual(
      resolveWebMcpOpenSignIn({ clerkEnabled: true, clerkReady: false, alreadyOpen: false }),
      { action: 'load_and_open' },
    );
  });
});
