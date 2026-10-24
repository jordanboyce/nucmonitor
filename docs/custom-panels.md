# Custom panels and sources

Viewers can add their own RSS or Atom feeds to NucMonitor and show them in
panels they name themselves. Open **Settings → Custom**, paste a feed URL,
pick an existing custom panel or **+ New panel**, and select **Check and add**.
The feed is fetched once to confirm it works; its title fills in the source and
panel names when those are left blank.

- Each browser keeps its own custom panels in localStorage
  (`nucmonitor-custom-feed-panels`). Nothing is stored on the server. Settings
  export and import carry them to another browser.
- Limits: 12 custom panels, 10 sources per panel. A panel shows the newest 30
  items across its sources (up to 10 per source) and refreshes every 10
  minutes while it is on screen.
- Custom panels appear in **Settings → Panels** like built-in ones, so a
  closed panel can be shown again there. Rename or delete a panel, or remove a
  source, from **Settings → Custom**.
- Panel ids use the `cw-feed-` prefix, so layouts, dashboard tabs and variant
  resets treat them as runtime panels.

## How feeds are fetched

Built-in feeds go through `/api/rss-proxy`, which only fetches hosts on the
RSS allowlist (`api/_rss-allowed-domain-match.js`). Custom feeds call the same
endpoint with `custom=1` (`src/services/custom-feeds.ts`). In that mode the
proxy (`api/rss-proxy.js`, mirrored by the dev plugin in `vite.config.ts`):

- accepts any public DNS name on the default http(s) port, and refuses IP
  literals, single-label names, `localhost`, private suffixes such as
  `.local` and `.internal`, cloud metadata hosts, and URLs with credentials
  (`api/_public-feed-host.js`);
- applies the same check to every redirect hop;
- relays a successful body only if it is an RSS, RDF or Atom document, and
  answers `422 Not an RSS or Atom feed` otherwise;
- never uses the Railway relay, which serves the allowlist only, and does not
  report feed failures to Sentry, since only the viewer can fix them.

Responses keep the proxy's existing protections: `text/plain` with a sandbox
CSP, a 5 MB and 20-item cap, a session or API key, and the per-IP rate limit.

Some sites refuse automated readers; the Custom tab then shows the HTTP status
the site returned. JSON Feed is not supported.
