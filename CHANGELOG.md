# Changelog

All notable changes to NucMonitor are documented here. History before the fork
lives in the upstream [World Monitor](https://github.com/koala73/worldmonitor)
repository.

## [Unreleased]

### Added

- Showcase mode (`VITE_SHOWCASE_SCENARIO=1`): a labeled sample scenario
  (Gulf Coast hurricane, Central Coast earthquake, Jemez wildfire, two
  Unusual Events and a reactor trip) replaces the live hazard feeds and adds
  SAMPLE rows to the NRC panels, so a demo never depends on live feeds
  (docs/showcase-mode.md).
- Landing page at `/` with a request-access form; requests are stored in
  Convex (`accessRequests`) through `api/request-access`, with a mailto
  fallback when intake is not configured.
- Placeholder Terms, Privacy and Source-license pages under `/legal/`.
- Deployment checklist (docs/deploy-demo.md), a five-minute demo script
  (docs/demo-script.md) and pitch drafts (docs/pitch/).
- `APP_ORIGINS` and same-origin acceptance in the CORS allowlists, so the
  edge functions and gateway accept requests from the host that serves them.
- NRC Event Notifications panel: the last 14 days of NRC Event Notification
  Reports, linked to registry facilities.
- Site hazard status (normal / watch / warning) from hazards inside each
  facility's 10-mile and 50-mile emergency planning zones, a facility detail
  view, a "my sites" watchlist, planning-zone rings on the map, CSV export and
  a printable site brief.

### Changed

- World Monitor leftovers removed from everything a visitor can reach: the
  upstream legal PDFs, the agent and MCP registry files (`plugin.json`,
  `mcp.json`, `server.json`), the `worldmonitor.app` hostnames in analytics
  (now opt-in through `VITE_UMAMI_*`), error tracking, map data and links,
  and the World Monitor routing in `vercel.json`.
- NucMonitor is the only dashboard; the World Monitor global, tech, finance,
  commodity, happy and energy dashboards, the desktop app, the CLI, the SDK,
  the marketing site and the non-nuclear data domains were removed.
- English is the only interface language.

### Fixed

- Deployment checklist: `WM_SESSION_SECRET` is required at runtime. The demo
  guide listed no secrets, but without it `/api/wm-session` returns 503 and
  every panel request is rejected with 401 (docs/deploy-demo.md).
