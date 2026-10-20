# Showcase mode (sample scenario)

A demo should not depend on what the weather, the USGS or nrc.gov happen to be
doing at the moment someone is watching. Showcase mode replaces the live hazard
feeds with a fixed, clearly labeled scenario that is timed to "today", so every
feature of the hub lights up on every run.

## Turning it on

Set at build time (the value is baked into the client bundle):

```sh
VITE_SHOWCASE_SCENARIO=1 npm run build
# or, locally
VITE_SHOWCASE_SCENARIO=1 npm run dev
```

Nothing on the server changes. The two NRC endpoints are still called; the
scenario only adds to what they return.

## What the scenario contains

All timestamps are relative to the moment the page loads (and refresh once an
hour in a long session), so events read as "4 hours ago" every day.

| Story | Signals | Sites it touches |
|---|---|---|
| **Hurricane Marisol**, Category 3 in the northern Gulf, forecast landfall on the southeast Louisiana coast | NHC-style storm with forecast track; NWS Hurricane Warning and Storm Surge Warning; Tropical Storm Warning; Tropical Storm Watch; Flash Flood Watch; a major telecom outage in St. Charles Parish; a low-confidence elevated RadNet reading at Baton Rouge (rain washout) | Waterford 3 (warning), River Bend (warning), South Texas Project (watch), Grand Gulf (watch) |
| **M5.4 earthquake** 28 km off the Central Coast with an M3.6 aftershock | USGS-style events | Diablo Canyon (warning) |
| **Cañada Fire** in the Jemez Mountains | Six VIIRS-style detections inside 12 km, an EONET wildfire event, a Red Flag Warning | Los Alamos National Laboratory (warning) |
| A quiet site | An M2.8 north of Richland that stays below every threshold | Columbia Generating Station (normal) |

NRC panels:

- **NRC Event Notifications** shows three SAMPLE events at the top of the live
  list: an Unusual Event at Waterford 3 for the Hurricane Warning, an automatic
  reactor trip at Waterford 3 on loss of offsite power, and an Unusual Event at
  Diablo Canyon for the earthquake. Each carries a "Sample" badge, a
  placeholder event number, and a narrative that opens with "SAMPLE SCENARIO.
  This event is simulated for demonstration and did not occur." They never
  move the "new since last visit" marker.
- **NRC Reactor Power Status** keeps the live file and lays four rows over it:
  Waterford 3 at 0% (trip), River Bend at 80%, Diablo Canyon 1 and 2 at 100%
  with a SAMPLE change note. If nrc.gov cannot be reached, a complete sample
  file (every operating unit at 100% plus those rows) is used and the footer
  says so.

The dashboard banner reads "Sample scenario" and names the storm, the quake and
the fire. Storm and fire names are invented.

## Where it lives

| File | Role |
|---|---|
| `src/config/showcase.ts` | The build switch and the scenario title |
| `src/services/showcase-scenario.ts` | `buildShowcaseScenario(now)`: pure data, every feed in the shape the dashboard already consumes |
| `src/app/data-loader.ts` | Each hazard loader takes the scenario feed instead of fetching when the switch is on |
| `src/services/nrc-event-reports.ts`, `src/services/nrc-reactor-status.ts` | Sample events and status overrides on top of the live NRC data |
| `src/components/AccessGate.ts` | The banner |
| `tests/showcase-scenario.test.mts` | Labels, timing, which sites flag, NRC matching, status overrides |

The hazard rules themselves are untouched: the scenario goes through the same
`correlateFacilityHazards` and `buildSiteRiskSummaries` as live data, so what
the demo shows is what the product would compute if these signals were real.
