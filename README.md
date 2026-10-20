# NucMonitor

**US nuclear facility all-hazards monitoring.** One dashboard that shows what is happening at, or near, every US nuclear site: reactor power, NRC event notifications, and the weather, seismic, fire, storm, outage and radiation signals inside each site's emergency planning zones.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

---

## Who it is for

- **Utilities and operators**: a morning view of the fleet, the hazards near each site, and what the NRC published overnight.
- **Vendors and fuel-cycle suppliers**: outages, restarts and events at the sites you serve.
- **Insurers and risk analysts**: hazard exposure by site, with distances to the 10-mile and 50-mile planning zones.
- **Emergency planners**: one map of facilities, active alerts and radiation readings.

## What is on the dashboard

| Panel | What it shows | Source |
|---|---|---|
| US Nuclear Facilities Map | About 170 registry facilities with hazard overlays; 10 mi / 50 mi planning-zone rings for the selected site | Registry, plus the feeds below |
| NRC Reactor Power Status | Daily power of every operating commercial reactor, fleet summary, day-over-day changes | NRC Power Reactor Status Report |
| NRC Event Notifications | Event Notification Reports for the last 14 days, linked to facilities, filterable by category, emergency class, region and "my sites" | NRC Event Notification Reports |
| Facility All-Hazards Watch | Each facility's status (normal / watch / warning) from hazards inside its planning zones, with the reason | NWS, USGS, NASA FIRMS, NHC / EONET, outages, EPA RadNet, Safecast |
| US Nuclear Facility Directory | Searchable registry: dockets, units, reactor types, net MWe, license expirations, operators; facility detail view | Registry |
| Radiation Watch | RadNet and Safecast anomaly detection | EPA RadNet, Safecast |
| Nuclear Headlines; NRC, DOE & IAEA Official; Industry; Policy & Security | Agency releases and trade and policy coverage | Site-scoped news feeds |
| Satellite Fires, Climate, Energy Markets, Energy Commodities | Context for the hazard and demand picture | NASA FIRMS, NOAA, EIA, markets |

Partners can keep a **"my sites" watchlist**, export the facility table with current hazard status to **CSV**, and print a **one-page site brief** for morning meetings.

### The facility registry

`src/config/us-nuclear-facilities.ts` lists 169 publicly documented sites: 55 operating power reactor sites, 2 restarts, 9 new builds, 23 decommissioning sites, 29 research reactors, 10 fuel-cycle facilities, 23 DOE / NNSA sites, 9 uranium recovery operations and 9 waste sites. Sources: the NRC operating reactor list and facility locator, NRC decommissioning, research reactor, fuel cycle and new reactor pages, DOE EM and NNSA site lists, EIA and IAEA PRIS. `US_NUCLEAR_REGISTRY_AS_OF` records the review date.

See [docs/nuclear-hub.mdx](docs/nuclear-hub.mdx) for how the feeds are parsed and how hazard status is computed.

## Quick start

Requires Node.js 24 (see `.nvmrc`).

```bash
npm install
npm run dev
```

Open [localhost:3000](http://localhost:3000) (override the port with `DEV_PORT` in `.env.local`). The dashboard runs without environment variables; some data feeds need keys (for example `NASA_FIRMS_API_KEY`, `EIA_API_KEY`). See `.env.example`.

Useful commands:

```bash
npm run typecheck      # browser TypeScript
npm run typecheck:api  # API and server TypeScript
npm run lint           # Biome plus the safe-HTML guard
npm run test:data      # node unit tests
npm run build          # production build
```

[SELF_HOSTING.md](SELF_HOSTING.md) covers Docker deployment and seeding data into Redis. [ARCHITECTURE.md](ARCHITECTURE.md) describes the system.

## Tech stack

| Category | Technologies |
|---|---|
| Frontend | TypeScript, Vite, deck.gl + MapLibre GL, globe.gl |
| API | Vercel edge functions; Protocol Buffers contracts with sebuf |
| Data | Seed workers writing to Redis (Upstash); Convex for accounts and preferences |
| Caching | Redis, CDN, service worker |

## Disclaimer

NucMonitor is informational. It republishes public data from the NRC, DOE, EIA, EPA, USGS, NWS, NOAA and NASA and is **not an official NRC notification channel**. Confirm anything you act on against the linked source. The registry contains only publicly documented facility information.

## License and credits

AGPL-3.0-only; see [LICENSE](LICENSE).

NucMonitor is a fork of [World Monitor](https://github.com/koala73/worldmonitor) by Elie Habib, copyright (C) 2024-2026 Elie Habib, also licensed AGPL-3.0-only. The World Monitor name and branding belong to its author and are not used by this project.
