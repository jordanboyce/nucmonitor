# Deploying the demo (Vercel)

What it takes to put the public demo on a URL today. The front end, the two
NRC edge functions and the landing page need no secrets. Everything else is
optional and listed under "later".

## 1. Create the Vercel project

1. Import `jordanboyce/nucmonitor` into Vercel. Framework preset: **Vite**.
   `vercel.json` already sets the build command (`npm run build:full`) and
   the routing, so leave the build and output settings at their defaults.
2. Node.js version: **24** (Project Settings → General → Node.js Version).
3. Add the environment variables below under Project Settings → Environment
   Variables, then deploy. Build-time values (`VITE_*`) only take effect on
   the next build.

## 2. Environment variables for the demo

| Variable | Value | Scope | Why |
|---|---|---|---|
| `VITE_VARIANT` | `nuclear` | build | Selects the NucMonitor dashboard (the only variant). |
| `VITE_SHOWCASE_SCENARIO` | `1` | build | Labeled sample scenario instead of live hazard feeds ([showcase-mode.md](showcase-mode.md)). Leave empty once the seed workers run. |
| `WM_SESSION_SECRET` | `openssl rand -hex 32` | runtime | Signs the anonymous browser session that `/api/wm-session` mints for every dashboard request. Without it that endpoint returns 503, every panel request is rejected with 401, and the NRC panels only ever show their SAMPLE rows. |
| `UPSTASH_REDIS_REST_URL` | from Upstash | runtime | `/api/wm-session` rate-limits session issuance and fails closed by design (`api/wm-session.js`, pinned by its tests). With no Redis it returns 503 "Rate-limit service temporarily unavailable" and the dashboard gets no session, so every panel request is rejected with 401. A free Upstash database is enough for the demo. |
| `UPSTASH_REDIS_REST_TOKEN` | from Upstash | runtime | Token for the database above. |
| `VITE_ACCESS_MODE` | *(empty)* | build | Public demo. `partner` turns on the sign-in gate ([partner-access.md](partner-access.md)). |
| `ACCESS_MODE` | *(empty)* | runtime | Server side of the same switch. |
| `APP_ORIGINS` | `https://<your-domain>` | runtime | CORS allowlist for the edge functions and gateway. The deployment's own origin is always admitted, so this matters only once a custom domain and the `*.vercel.app` URL are both in use. |
| `PARTNER_CONTACT_EMAIL` | your address | runtime | Shown by the landing-page form when request intake is not configured, and by the partner gate. |
| `VITE_PARTNER_CONTACT_EMAIL` | your address | build | Same address for the browser side. |

Optional, recommended:

| Variable | Why |
|---|---|
| `VITE_WEB_APP_ORIGIN` | `https://<your-domain>`; makes links in saved reports absolute. |
| `VITE_PMTILES_URL` | A self-hosted PMTiles basemap. Without it the map uses the OpenFreeMap public style, which is fine for a demo. |
| `VITE_SENTRY_DSN` | Browser error tracking. Off when empty. |
| `VITE_UMAMI_SCRIPT_URL`, `VITE_UMAMI_WEBSITE_ID` | Self-hosted Umami analytics. Off unless both are set. |

Everything else in `.env.example` can stay empty for the demo. In particular
the live hazard feeds (weather, earthquakes, fires, outages, radiation) read
from Upstash Redis filled by the seed workers; with `VITE_SHOWCASE_SCENARIO=1`
they are not needed.

## 3. What the deployment serves

| Path | What |
|---|---|
| `/` | Landing page (`public/landing.html`) with the request-access form. |
| `/dashboard` | The dashboard. `/stocks` and `/stocks/:symbol` are legacy client routes that also load it. |
| `/api/nrc-reactor-status`, `/api/nrc-event-reports`, `/api/nrc-safety-reports` | Live proxies to nrc.gov (reactor status, Event Notification Reports, Part 21 reports and Preliminary Notifications). These are the first things to verify after deploying: open the two NRC panels and confirm real rows and events appear (the sample rows carry SAMPLE; real ones do not). |
| `/api/request-access` | Landing-page intake. Returns 503 "intake not configured" with the contact address until `CONVEX_URL` is set. |
| `/legal/terms`, `/legal/privacy`, `/legal/license` | Placeholder legal pages (`public/legal/`). Replace before a pilot. |
| `/trust/` | Label-history page for the news panels. |
| `/robots.txt` | Allows the site, disallows `/api/`. |

## 4. Verify after the first deploy

1. Open `/`: the landing page renders; the "Open the demo dashboard" button
   reaches `/dashboard`.
2. On the dashboard the banner reads **Sample scenario**, Facility All-Hazards
   Watch lists Waterford 3, River Bend and Diablo Canyon as warnings, and the
   map draws the facilities.
3. NRC Reactor Power Status shows a report date and more than 90 units, and
   NRC Event Notifications shows real events below the three sample ones. If
   either panel shows "unavailable", open the browser console: the parser was
   built from the published format and this is the first live run (see
   [nuclear-hub.mdx](nuclear-hub.mdx)). Report the failing URL and the status.
4. Submit the request-access form with a test address: expect the "intake not
   configured" message with the contact address (or a thank-you once Convex
   is set up).
5. Open the settings gear: the legal row links to the three `/legal/` pages.

## 5. Later: turning on the rest

| Capability | What to set |
|---|---|
| Live hazard feeds | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and the seed workers from [SELF_HOSTING.md](../SELF_HOSTING.md); then drop `VITE_SHOWCASE_SCENARIO`. |
| Request intake stored in Convex | Deploy the Convex project (`npx convex deploy`), set `CONVEX_URL` (runtime) and `VITE_CONVEX_URL` (build). Review requests with `npx convex run partnerAccess:listAccessRequests`. |
| Partner sign-in | [partner-access.md](partner-access.md): Clerk keys, `ACCESS_MODE=partner`, invites. |
| Rate limiting on the edge functions | The same Upstash variables. The read-only proxies fail open without them, but `/api/wm-session` does not (see section 2), which is why Upstash is listed as required. |
