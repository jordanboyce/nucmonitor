# Relay credentials

NucMonitor's Convex deployment serves partner access and signed-in user
preferences only. It exposes no `/relay/` HTTP routes, so there are no Convex
tenant relay credentials to provision. The former notification, checkout,
customer-portal, referral and email-suppression routes were removed with the
paid tier.

| Credential | Holders | Purpose |
| --- | --- | --- |
| `RELAY_SHARED_SECRET` | The Railway relay (`scripts/ais-relay.cjs`) and every Vercel or server process that calls it | Authenticates calls to the relay. The relay refuses to start without it. |

Provision it through each platform's secret store. Never put it in browser
variables, source code, logs, PR descriptions or screenshots.

A value added or rotated later needs a new deploy on every platform that reads
it. A Vercel variable set after the build never reaches the running build,
because a same-commit redeploy is cancelled by the ignored-build step (#8216).
