import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// ─── WORLDMONITOR-12A: the limiter scope must be wired at the CALL SITE ──────
//
// `server/_shared/rate-limit.ts` can separate an API key's bucket from an
// interactive session's, but only if the gateway actually tells it which
// credential the caller presented. Those are two different failures, and the
// module-level test in `tests/rate-limit.test.mts` cannot see the second one:
// deleting both `principalScope` arguments from gateway.ts leaves that suite
// fully green (verified by mutation, 2026-09-11).
//
// Rather than pin the two literal call sites — which a third limiter call would
// silently slip past — assert the invariant: every limiter option object that
// names a principal must also name that principal's scope. A new call site that
// forgets the scope re-opens the bug, and re-opening it means a paying customer's
// own scraper can starve their dashboard again.
//
// This is a source pin because driving a real API-key request through
// `createDomainGateway` needs key validation, entitlement resolution and Redis;
// the behaviour it guards is already proven against the limiter itself.

const GATEWAY_SOURCE = readFileSync(
  new URL('../server/gateway.ts', import.meta.url),
  'utf8',
);

describe('gateway rate-limit principal scoping (WORLDMONITOR-12A)', () => {
  it('passes principalScope wherever it passes principalUserId', () => {
    const principals = GATEWAY_SOURCE.match(/\bprincipalUserId:/g) ?? [];
    const scopes = GATEWAY_SOURCE.match(/\bprincipalScope:/g) ?? [];

    assert.ok(
      principals.length > 0,
      'sanity: gateway.ts must still pass a principal to the limiter — if this '
      + 'fails the regex has drifted, not the behaviour',
    );
    assert.equal(
      scopes.length,
      principals.length,
      `every limiter call naming a principal must also name its scope; found `
      + `${principals.length} principalUserId vs ${scopes.length} principalScope. `
      + 'An unscoped call shares one bucket between a customer\'s API key and '
      + 'their browser session.',
    );
  });

  it('names only a verified partner account as a principal, scoped as a session', () => {
    // NucMonitor has no per-user API keys: an enterprise env key is metered per
    // key by its own layer and otherwise stays on the IP bucket, so the only
    // principal the gateway names is a partner's verified Clerk account.
    assert.match(
      GATEWAY_SOURCE,
      /rateLimitPrincipalUserId = partner\.userId;/,
      'the principal must come from verifyPartnerRequest',
    );
    assert.doesNotMatch(
      GATEWAY_SOURCE,
      /principalScope:\s*'api_key'/,
      'no gateway call site may claim the api_key scope without a per-user key to back it',
    );
    assert.match(
      GATEWAY_SOURCE,
      /withTrustedRateLimitPrincipal\([\s\S]{0,120}?'session'/,
      'the handler-facing stamp carries the same session scope the limiter charged',
    );
  });
});
