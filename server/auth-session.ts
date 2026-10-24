/**
 * Server-side session validation for the Vercel edge gateway.
 *
 * Validates Clerk-issued bearer tokens using local JWT verification
 * with jose + cached JWKS. No Convex round-trip needed.
 * Requires CLERK_PUBLISHABLE_KEY (server-side) and CLERK_JWT_ISSUER_DOMAIN.
 *
 * This module must NOT import anything from `src/` -- it runs in the
 * Vercel edge runtime, not the browser.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { isAllowedOrigin } from './cors.js';

// Absorb minor issuer/edge clock skew without turning expiration into a broad
// grace period. jose's operators are asymmetric at the bound: `exp` is accepted
// strictly less than five seconds late (rejected at exactly five — jose tests
// `exp <= now - tolerance`), while `nbf` is accepted up to and including five
// seconds early. Either way the replay window widens by at most this bound.
const CLERK_JWT_CLOCK_TOLERANCE_SECONDS = 5;

// Exported so tests can assert the fallback (no-audience) path's options
// directly, mirroring the existing assertion on getClerkJwtVerifyOptions().
export function getClerkJwtVerifyBaseOptions() {
  return {
    // Read lazily (not from the module-scope const) for the same reason as
    // getJWKS(): both halves of issuer handling must read the env at the same
    // time. A module evaluated before CLERK_JWT_ISSUER_DOMAIN is set would
    // otherwise pin issuer '' here — and jose skips the issuer VALUE check
    // entirely on a falsy issuer — while the lazily-built JWKS still resolves.
    issuer: process.env.CLERK_JWT_ISSUER_DOMAIN ?? '',
    algorithms: ['RS256'],
    clockTolerance: CLERK_JWT_CLOCK_TOLERANCE_SECONDS,
    // The bounded tolerance above is only a bound if expiry is evaluated at
    // all: jose skips the whole `exp` check (tolerance included) when the
    // claim is absent. Clerk always mints `exp`, so requiring it rejects
    // nothing real — it makes the stated bound enforced rather than assumed.
    requiredClaims: ['exp'],
  };
}

// Module-scope JWKS resolver -- cached across warm invocations.
// jose handles key rotation and caching internally.
// Exported so callers can reuse the same singleton (avoids duplicate JWKS
// HTTP fetches on cold start).
// Reads CLERK_JWT_ISSUER_DOMAIN lazily (not from module-scope const) so that
// tests that set the env var after import still get a valid JWKS.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
export function getJWKS() {
  if (!_jwks) {
    const issuerDomain = process.env.CLERK_JWT_ISSUER_DOMAIN;
    if (issuerDomain) {
      const jwksUrl = new URL('/.well-known/jwks.json', issuerDomain);
      _jwks = createRemoteJWKSet(jwksUrl);
    }
  }
  return _jwks;
}

/**
 * Drop the memoized resolver so a test can change CLERK_JWT_ISSUER_DOMAIN and
 * have the next call rebuild against it. Without this the first test to touch a
 * bearer pins the resolver for the whole module lifetime, and a later test that
 * unsets the env still gets the old one — silently asserting the wrong branch.
 */
export function __resetJwksForTests(): void {
  _jwks = null;
}

export interface SessionResult {
  valid: boolean;
  userId?: string;
  orgId?: string | null;
  email?: string;
  name?: string;
  /**
   * Why a `valid: false` result is invalid — present only on the deny arm.
   *
   * `invalid` is a confirmed answer ABOUT THE TOKEN: bad signature, expired,
   * wrong issuer, no subject. Re-authenticating is the fix.
   *
   * `unverifiable` means verification never happened — the issuer domain is
   * unset, or the JWKS fetch failed. That says nothing about the token, so a
   * caller must not render it as "your credential is bad, signing in again is
   * the fix" (#5619 follow-up: the same "our defect is not a verdict" rule the
   * entitlement path already follows).
   *
   * Optional and additive: `valid` keeps its exact meaning, so every existing
   * consumer that only reads `valid` is unaffected. A caller opts in by
   * branching on this to answer the retryable contract instead.
   */
  reason?: 'invalid' | 'unverifiable';
  /**
   * Present only when verification succeeded BECAUSE of the bounded
   * `clockTolerance` — the token's `exp` was already in the past on this
   * machine's clock. Optional and additive, like `reason`: `valid` keeps its
   * exact meaning for every existing consumer. A caller that re-presents the
   * same bearer to a second verifier with its own clock (Convex via
   * `client.setAuth`) opts in by branching on this to classify that verifier's
   * rejection as expected near-expiry traffic rather than auth-config drift.
   */
  acceptedWithinClockTolerance?: true;
}

/**
 * True when a jwtVerify rejection means we could not REACH the JWKS, rather
 * than that the token failed verification against it.
 *
 * Deliberately narrow. `JWKSNoMatchingKey` is excluded: it fires both for a
 * forged token and for a mid-rotation key, and misclassifying a forged token as
 * "retry later" is the worse error. Only unambiguous transport failures — jose's
 * own JWKS timeout, and the bare `TypeError` a failed `fetch` surfaces — count.
 */
function isJwksFetchFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ERR_JWKS_TIMEOUT';
}

function getAllowedAudiences(): string[] {
  const configured = [
    process.env.CLERK_JWT_AUDIENCE,
    process.env.CLERK_PUBLISHABLE_KEY,
  ]
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  return Array.from(new Set(['convex', ...configured]));
}

export function getClerkJwtVerifyOptions() {
  return {
    ...getClerkJwtVerifyBaseOptions(),
    audience: getAllowedAudiences(),
  };
}

/**
 * Clerk browser session tokens set `azp` to the origin that minted them.
 * When the claim is present, require it to be an app-serving origin (same
 * boundary as credentialed CORS / TRUSTED_RETURN_URL_ORIGINS), a surveyed
 * desktop/preview origin already covered by `isAllowedOrigin`, or the
 * deployment's own `SITE_URL`. Absent `azp` stays fail-open — machine and
 * other non-browser Clerk tokens omit it (#8178).
 */
export function isAllowedClerkAuthorizedParty(azp: string): boolean {
  if (!azp) return false;
  if (isAllowedOrigin(azp)) return true;
  const siteUrl = process.env.SITE_URL?.trim();
  if (!siteUrl) return false;
  try {
    return new URL(siteUrl).origin === new URL(azp).origin;
  } catch {
    return false;
  }
}

function extractOrgId(payload: Record<string, unknown>): string | null {
  const orgClaim = payload.org as Record<string, unknown> | undefined;
  return (
    (typeof orgClaim?.id === 'string' ? orgClaim.id : null) ??
    (typeof payload.org_id === 'string' ? payload.org_id : null)
  );
}

/**
 * Validate a Clerk-issued bearer token using local JWKS verification.
 * Accepts both custom-template (`convex`) tokens and standard session tokens.
 * Fails closed: invalid/expired/unverifiable tokens return { valid: false }.
 * When a browser session token carries `azp`, it must be an authorized party
 * (app hosts seeded from TRUSTED_RETURN_URL_ORIGINS via the CORS allowlist,
 * plus desktop/preview origins and `SITE_URL`); absent `azp` is fail-open.
 */
export async function validateBearerToken(token: string): Promise<SessionResult> {
  const jwks = getJWKS();
  // No issuer domain configured: a deploy defect, not a bad token.
  if (!jwks) return { valid: false, reason: 'unverifiable' };

  try {
    // Try with audience first (Clerk 'convex' template tokens include aud).
    // Fall back without audience for standard Clerk session tokens (no aud claim).
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, jwks, getClerkJwtVerifyOptions()));
    } catch (audErr) {
      if ((audErr as Error).message?.includes('missing required "aud"')) {
        ({ payload } = await jwtVerify(token, jwks, getClerkJwtVerifyBaseOptions()));
      } else {
        throw audErr;
      }
    }

    const userId = payload.sub as string | undefined;
    // Verified, but carries no subject — a confirmed answer about the token.
    if (!userId) return { valid: false, reason: 'invalid' };

    // Bind Clerk's authorized-party claim when present. Fail open when absent
    // so non-browser tokens keep working; reject a foreign minting origin.
    const azp = payload.azp;
    if (typeof azp === 'string' && azp.length > 0 && !isAllowedClerkAuthorizedParty(azp)) {
      return { valid: false, reason: 'invalid' };
    }
    // Present non-string claims (including explicit null) are unbound; only
    // absent (`undefined`) and empty-string azp remain fail-open.
    if (azp !== undefined && typeof azp !== 'string') {
      return { valid: false, reason: 'invalid' };
    }

    const email = typeof payload.email === 'string' ? payload.email : undefined;
    const givenName = typeof payload.given_name === 'string' ? payload.given_name : undefined;
    const familyName = typeof payload.family_name === 'string' ? payload.family_name : undefined;
    const name = [givenName, familyName].filter(Boolean).join(' ') || undefined;
    const orgId = extractOrgId(payload);

    // `exp` in the past on our clock means only the clockTolerance admitted
    // this token (requiredClaims guarantees the claim is present on success).
    const expMs = typeof payload.exp === 'number' ? payload.exp * 1000 : null;
    const withinTolerance = expMs !== null && expMs <= Date.now();

    return {
      valid: true,
      userId,
      orgId,
      email,
      name,
      ...(withinTolerance ? { acceptedWithinClockTolerance: true as const } : {}),
    };
  } catch (err) {
    // Usually signature verification failed / expired / wrong issuer — a
    // confirmed answer about the token. But this same catch also covers a JWKS
    // FETCH failure, since createRemoteJWKSet resolves lazily inside jwtVerify,
    // and that says nothing about the token at all. Split them so a Clerk
    // outage stops rendering as "sign in again" (#5619 follow-up).
    return { valid: false, reason: isJwksFetchFailure(err) ? 'unverifiable' : 'invalid' };
  }
}
