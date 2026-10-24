/**
 * Pure-resolver tests for buildUsageIdentity().
 *
 * The resolver maps gateway-internal auth state to the telemetry identity
 * fields (auth_kind, principal_id, customer_id). It is intentionally pure —
 * no JWT verification, no key hashing of secrets, no I/O — so the branch
 * matrix is trivially testable here.
 */

import { describe, expect, test } from 'vitest';

import { buildUsageIdentity, hashKeySync, type UsageIdentityInput } from '../_shared/usage-identity';

function baseInput(overrides: Partial<UsageIdentityInput> = {}): UsageIdentityInput {
  return {
    sessionUserId: null,
    enterpriseApiKey: null,
    ...overrides,
  };
}

describe('buildUsageIdentity — auth_kind branches', () => {
  test('a verified partner session takes precedence over an enterprise key', () => {
    const ident = buildUsageIdentity(baseInput({
      sessionUserId: 'user_123',
      enterpriseApiKey: 'should-be-ignored',
    }));
    expect(ident).toEqual({
      auth_kind: 'clerk_jwt',
      principal_id: 'user_123',
      customer_id: 'user_123',
    });
  });

  test('enterprise_api_key: principal_id is hashed, not raw', () => {
    const ident = buildUsageIdentity(baseInput({ enterpriseApiKey: 'wm_ent_secret' }));
    expect(ident.auth_kind).toBe('enterprise_api_key');
    expect(ident.principal_id).toBe(hashKeySync('wm_ent_secret'));
    expect(ident.principal_id).not.toContain('secret');
    expect(ident.customer_id).toBe('enterprise-unmapped');
  });

  test('anon: every field null', () => {
    expect(buildUsageIdentity(baseInput())).toEqual({
      auth_kind: 'anon',
      principal_id: null,
      customer_id: null,
    });
  });
});

describe('hashKeySync', () => {
  test('is deterministic and distinguishes keys', () => {
    expect(hashKeySync('a')).toBe(hashKeySync('a'));
    expect(hashKeySync('a')).not.toBe(hashKeySync('b'));
  });
});
