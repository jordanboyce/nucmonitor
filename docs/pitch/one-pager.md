# NucMonitor — one-pager

*Draft for review. Items marked **[fill in]** need the team's input.*

## The problem

Every morning, the people responsible for a US nuclear site rebuild the same
picture by hand: what the NRC published overnight, which weather warnings
cover the site, whether anything shook nearby, whether a fire or a storm is
approaching, whether a radiation monitor moved. That information is public,
but it lives on six federal sites in six formats, and none of it is organised
around the one thing that matters to them, the site and its 10- and 50-mile
emergency planning zones.

The result is slow, inconsistent and unrepeatable situational awareness. The
utility's emergency preparedness group, the vendor supporting an outage, the
insurer pricing exposure and the state emergency manager all answer the same
question separately, and none of them can show their working.

## What NucMonitor does

NucMonitor is a working product, not a concept. It joins eight public feeds to
a registry of 169 US nuclear facilities and gives each site one explainable
status:

- **NRC Reactor Power Status**: every operating unit, daily, with the NRC's
  reasons and day-over-day changes.
- **NRC Event Notifications**: fourteen days of licensee reports, linked to
  sites, flagged for reactor trips and emergency declarations.
- **Facility All-Hazards Watch**: NWS warnings, USGS earthquakes, NASA FIRMS
  fire detections, NHC and EONET storm tracks, outages and EPA RadNet and
  Safecast readings, bucketed by planning zone, with the rule that fired.
- **Map, directory, watchlist, CSV export and a printable site brief** for the
  morning meeting.

The hazard rules are written down and reviewable. Nothing is a black box, and
every item links to its public source.

## Who it is for

| Audience | What they get |
|---|---|
| Utility emergency preparedness and operations | The morning fleet view and a one-page brief per site |
| Vendors and fuel-cycle suppliers | Outages, restarts and events at the sites they serve |
| Insurers and risk analysts | Hazard exposure by site with distances to the planning zones |
| State and local emergency management | One map of facilities, alerts and radiation readings |

## Where it stands

- Built, tested and running as a public demo with a labeled sample scenario
  and live NRC panels. **[fill in: demo URL]**
- Partner access mode exists: sign-in for invited organisations, private
  instances, invites that take effect in minutes.
- Public data only. Informational, not an official NRC channel. No sensitive
  or controlled information is involved; the registry holds only publicly
  documented facility information.

## Roadmap (with the first pilot partner)

1. Alert delivery: email, Microsoft Teams and webhooks on status changes and
   NRC events at watched sites.
2. NRC Licensee Event Reports and inspection findings alongside the event
   notifications.
3. Partner API with documentation, and SSO through the partner's identity
   provider.
4. Security review and a reviewed legal and data-processing package.

## Adoption path

Free public demo → two or three invited pilots of four to six weeks (utilities
or vendors) → paid organisation plans with alerts, API access and SSO.

## Funding fit (to confirm)

- DOE SBIR/STTR topics on nuclear operations and grid resilience.
- DOE GAIN vouchers, which pair nuclear companies with national-laboratory
  support.
- State emergency-management and resilience grants.
- Industry bodies (NEI, EPRI) as pilot partners rather than funders.

## The ask

**[fill in]**: the amount, what it funds (pilot delivery, alerting, security
review), and the timeline.

## Team

**[fill in]**: names, roles and relevant background.

## Contact

**[fill in]**: name, email, demo URL.
