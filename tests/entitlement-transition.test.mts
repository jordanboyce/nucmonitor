/**
 * Unit tests for shouldReloadOnEntitlementChange.
 *
 * Upstream, this helper drove the post-payment reload in panel-layout.ts (the
 * 2026-04-18 duplicate-subscription incident). NucMonitor removed pricing: the
 * single partner entitlement is static and gating re-runs in place on every
 * announcement, so no transition may force a page reload — a reload here would
 * be a loop with nothing to activate.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldReloadOnEntitlementChange } from '@/services/entitlements';

describe('shouldReloadOnEntitlementChange', () => {
  it('does not reload on the first snapshot when user is free', () => {
    assert.equal(shouldReloadOnEntitlementChange(null, false), false);
  });

  it('does not reload on the first snapshot when user is already pro', () => {
    // Legacy-pro user on page load — avoid reload loop.
    assert.equal(shouldReloadOnEntitlementChange(null, true), false);
  });

  it('does not reload free → free (idempotent free-tier update)', () => {
    assert.equal(shouldReloadOnEntitlementChange(false, false), false);
  });

  it('does not reload pro → pro (renewal, metadata refresh)', () => {
    assert.equal(shouldReloadOnEntitlementChange(true, true), false);
  });

  it('does not reload pro → free (expiration, revocation) — handled elsewhere', () => {
    // Revocation paths are handled by re-rendering; no forced reload.
    assert.equal(shouldReloadOnEntitlementChange(true, false), false);
  });

  it('does not reload on free → pro either (no post-payment activation exists)', () => {
    assert.equal(shouldReloadOnEntitlementChange(false, true), false);
  });

  it('replays the upstream incident sequence (free default, then entitled) without reloading', () => {
    let last: boolean | null = null;
    let reloadCount = 0;

    const snapshots = [false, true, true];
    for (const entitled of snapshots) {
      if (shouldReloadOnEntitlementChange(last, entitled)) reloadCount += 1;
      last = entitled;
    }

    assert.equal(reloadCount, 0);
  });

  it('legacy-pro user reconnecting WS: pro, pro, pro → zero reloads', () => {
    let last: boolean | null = null;
    let reloadCount = 0;

    for (const entitled of [true, true, true]) {
      if (shouldReloadOnEntitlementChange(last, entitled)) reloadCount += 1;
      last = entitled;
    }

    assert.equal(reloadCount, 0);
  });

});
