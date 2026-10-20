# Partner access

NucMonitor has no paid plans. A deployment runs in one of two access modes,
and everyone who gets past the mode's gate has the same, full access.

| Mode | Who can open the dashboard | Data reads |
| --- | --- | --- |
| `public-demo` (default) | Anyone. A banner labels the page as a demo of public data. | Shared, CDN-cached anonymous reads, as before. |
| `partner` | A signed-in user whose email is on the partner list. | Every read needs a browser session or an API key. No anonymous reads. |

The default needs no secrets, so a showcase deployment works out of the box.

## Turning on partner mode

Set these and redeploy both the web build and the edge functions. The client
value is baked in at build time.

| Variable | Where | Value |
| --- | --- | --- |
| `VITE_ACCESS_MODE` | web build | `partner` |
| `ACCESS_MODE` | edge / server runtime | `partner` |
| `VITE_CLERK_PUBLISHABLE_KEY` | web build | Your Clerk publishable key (sign-in) |
| `CLERK_JWT_ISSUER_DOMAIN` | edge and Convex | Your Clerk issuer, e.g. `https://clerk.example.com` |
| `PARTNER_ALLOWED_DOMAINS` | edge | Optional. Comma-separated email domains, e.g. `utility.com,vendor.com` |
| `PARTNER_ALLOWED_EMAILS` | edge | Optional. Comma-separated individual addresses |
| `CONVEX_URL` | edge | Needed for invites stored in Convex (below) |
| `CLERK_SECRET_KEY` | edge | Optional. Looks up the email when a token lacks the `email` claim |
| `VITE_PARTNER_CONTACT_EMAIL` | web build | Optional. Adds a "Request access" link to the refusal screen |

The Clerk `convex` JWT template should include the `email` claim. Without it,
the edge falls back to the Clerk Backend API, which needs `CLERK_SECRET_KEY`.

Domains must match exactly: `utility.com` admits `ops@utility.com`, but not
`ops@grid.utility.com` or `ops@notutility.com`.

## What partner mode enforces

- **Sign-in gate.** Before the dashboard loads, the browser shows one of these
  screens: sign in, access not yet granted, or try again (when the check
  itself failed). The dashboard code is not loaded until access is granted.
- **Session minting.** `/api/wm-session` mints the browser session only for a
  verified Clerk token whose email is on the list (`api/_partner-access.js`).
  The decision is cached per user for 5 minutes, so a revoked invite takes
  effect within 5 minutes.
- **Data reads.** Data endpoints already require that session or an API key.
  Partner mode also turns off the anonymous paths:
  - the `&public=1` bootstrap and RPC shapes;
  - the anonymous weather read;
  - the keyless embed map frame.
- **Gateway.** A Clerk bearer replaces an API key only when its account is a
  partner.
- **Status codes.** Responses carry `401 sign_in_required`, `403
  partner_access_required` or `503 access_unverifiable`. An identity-provider
  or Convex outage returns 503 and is never cached as a refusal.

## Inviting a partner

Use env for whole organisations that are settled. Use Convex invites for
everything else, because they take effect without a redeploy.

```sh
# One person
npx convex run partnerAccess:invite '{"email":"ops@utility.com","organization":"Utility Co"}'

# A whole email domain
npx convex run partnerAccess:invite '{"domain":"utility.com","organization":"Utility Co"}'

# Review and revoke
npx convex run partnerAccess:listInvites
npx convex run partnerAccess:revoke '{"email":"ops@utility.com"}'
```

Invites match the caller's verified Clerk email, and are case-insensitive.

## API keys for partners

There are two ways to give a partner API access:

- **Organisation key, no Convex involved.** Generate a random secret and add it
  to `WORLDMONITOR_VALID_KEYS` (comma-separated). Callers send it as
  `X-Api-Key`.
- **Per-user keys.** A partner creates keys under Settings → API Keys. The
  gateway accepts a user key only when its owner's entitlement carries API
  access, so grant that once per account:

  ```sh
  npx convex run partnerAccess:grantApiAccess '{"userId":"user_2abc..."}'
  ```

  The Clerk user id appears in the Clerk dashboard. Grants last 365 days by
  default; pass `"days"` to change that.

## Not covered yet

- No admin UI. Invites are managed with `npx convex run`.
- There is no organisation or role model. Everyone admitted has the same
  access.
- SSO (SAML or OIDC) comes from your Clerk instance's configuration, not
  from NucMonitor.
