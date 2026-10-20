# NucMonitor demo script (5 minutes)

A repeatable walkthrough for a funder or a pilot partner. It assumes a
showcase build (`VITE_SHOWCASE_SCENARIO=1`, see [showcase-mode.md](showcase-mode.md)),
so the same things light up every time. Start on the landing page, with the
dashboard already loaded in a second tab.

## 0:00 — Frame it (30 s)

> "It's 6 a.m. at a utility. The emergency preparedness lead wants one answer
> before the morning call: what is happening at, or near, our plants? Today
> that answer is stitched together by hand from NRC, the Weather Service,
> USGS, NASA and EPA. NucMonitor is that answer on one screen."

Point at the landing page's one line and the four tiles (169 facilities, 8
feeds per site, 10/50-mile rings, daily NRC reports). Click **Open the demo
dashboard**.

## 0:30 — The fleet, ranked (60 s)

Switch to the dashboard. Note the **Sample scenario** banner: "Everything you
are about to see is computed by the real rules from simulated feeds, so I can
show you a bad morning on demand."

In **Facility All-Hazards Watch**:

- The list opens on **Flagged** sites. Read the top three aloud: Waterford 3
  (warning), River Bend (warning), Diablo Canyon (warning).
- Point at a status badge and the reason line under it: "every status says
  which rule produced it: a Hurricane Warning covers the site, so it is a
  warning inside the 10-mile zone. Nothing here is a black box."
- Click **All sites** to show that most of the fleet is normal, then back to
  **Flagged**.

## 1:30 — One site in depth (75 s)

Click **Waterford 3** to open the detail drawer.

- Walk the zones top to bottom: plume zone (10 mi), ingestion zone (50 mi),
  regional. The Hurricane Warning and the storm-surge warning sit in the plume
  zone; the hurricane's forecast track and the telecom outage sit farther out.
- Click **Show on map**. The map flies to the site and draws the 10- and
  50-mile rings; the storm track and the weather polygons are visible around
  it. "This is the planning-zone picture a state emergency manager works
  from."
- Click the star: "Watch site." That adds it to **my sites**, which filters
  every panel.

## 2:45 — What the NRC said (60 s)

Scroll to **NRC Event Notifications**.

- The three sample events sit at the top with a **Sample** badge: the Unusual
  Event for the Hurricane Warning, the automatic reactor trip on loss of
  offsite power, and Diablo Canyon's earthquake Unusual Event. Below them are
  the real notifications the NRC published in the last 14 days.
- Expand the reactor trip. Show the unit table (100% to 0%, hot standby), the
  10 CFR 50.72 sections and the narrative. "This is the licensee's own report
  as the NRC publishes it, linked to the registry site, with 'My site' and
  'Reactor trip' flags so nobody has to read every entry."
- Click **My sites** in the toolbar: only Waterford events remain.

Glance at **NRC Reactor Power Status**: Waterford 3 at 0% with the trip note,
River Bend reduced, the fleet summary at the top. "Updated daily from the
NRC's status file; the day-over-day column is what people check first."

## 3:45 — Take it with you (45 s)

Back in **Facility All-Hazards Watch**, open Waterford 3 again.

- **Print site brief**: a one-page brief with the site facts, each zone's
  signals, the reactor power rows and the NRC events. "This is the morning
  meeting handout."
- Close it. Click **Export CSV**: every facility with its current status,
  reasons and counts. "This is what goes into a risk model or a SharePoint
  list."

## 4:30 — How partners get it (30 s)

Open the settings gear briefly to show the legal links and the absence of
any pricing, then close it.

> "The public demo is public data only. A partner deployment is a private
> instance with sign-in for your organisation; invites take effect in
> minutes. On the roadmap, with the first pilot partner: alert delivery by
> email, Teams and webhooks, NRC Licensee Event Reports and inspection
> findings, and an API with docs."

Return to the landing page and point at **Request partner access**. Stop.

## If something goes wrong

- **A panel shows an error**: the sample scenario covers the hazard feeds,
  the map and the NRC panels; news and market panels are live and can fail
  without affecting the story. Collapse the panel and move on.
- **The map has no basemap**: the facility markers, rings and hazard layers
  still draw. Say the tiles are a third-party style and continue.
- **Someone asks whether these events are real**: no. Every sample record
  says SAMPLE, the narrative opens with "This event is simulated", and the
  banner names the storm, quake and fire. The rules that flagged them are the
  real ones.

## Questions to expect

- *Is this an official NRC product?* No. It republishes public data and is
  not an official NRC notification channel; every item links to its source.
- *Where does the data come from?* NRC status and event reports (daily), NWS
  alerts, USGS earthquakes, NASA FIRMS fire detections, NHC and EONET storm
  tracks, EPA RadNet and Safecast radiation, and an internet-outage feed.
- *Is anything sensitive in the registry?* No. It holds only publicly
  documented facility information: NRC dockets, unit lists, operators,
  license dates and public coordinates.
- *How are the thresholds chosen?* They are written down in
  [nuclear-hub.mdx](nuclear-hub.mdx) and in the panel's info tooltip, and
  they are a proximity screen, not a claim about plant condition.
