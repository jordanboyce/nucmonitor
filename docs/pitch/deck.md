# NucMonitor — short deck (10 slides)

*Draft. One idea per slide; speaker notes under each. **[fill in]** marks what the team adds.*

---

## 1. NucMonitor

**US nuclear facility all-hazards monitoring.**
What is happening at, or near, every US nuclear site, on one screen.

*Notes: one sentence, then straight to the problem. Demo URL in the footer.* **[fill in]**

---

## 2. The 6 a.m. problem

- NRC status report, NRC event notifications, NWS, USGS, NASA FIRMS, NHC, EPA RadNet: six sites, six formats.
- None of them is organised around the site and its 10- and 50-mile planning zones.
- Every utility, vendor, insurer and state agency rebuilds the same picture by hand, every morning.

*Notes: ask the room who does this today. Usually someone nods.*

---

## 3. What it looks like

**[screenshot: Facility All-Hazards Watch with flagged sites]**

- One status per site: normal, watch, warning.
- The rule that fired is printed next to the status.
- Every item links to its public source.

*Notes: this is the screen the demo opens on.*

---

## 4. What is behind it

| Feed | Source |
|---|---|
| Reactor power, daily | NRC Power Reactor Status Report |
| Event notifications, 14 days | NRC Event Notification Reports |
| Weather warnings | National Weather Service |
| Earthquakes | USGS |
| Fire detections | NASA FIRMS |
| Storm tracks | NHC and NASA EONET |
| Outages | Internet-outage feed (grid and telecom proxy) |
| Radiation | EPA RadNet and Safecast |

Joined to a registry of 169 facilities: 55 operating reactor sites, restarts, new builds, decommissioning sites, research reactors, fuel-cycle plants, DOE and NNSA sites, uranium recovery and waste sites.

---

## 5. Explainable by design

- Thresholds are written down (magnitude and distance for earthquakes, warning class for weather, detections and intensity for fire, category and track distance for storms).
- Statuses are a proximity screen, not a claim about plant condition.
- Public data only. Not an official NRC channel. No sensitive or controlled information.

*Notes: this slide answers the compliance question before it is asked.*

---

## 6. Who it is for

- **Utility emergency preparedness and operations**: the morning fleet view and a one-page site brief.
- **Vendors and fuel-cycle suppliers**: outages, restarts and events at the sites they serve.
- **Insurers and risk analysts**: exposure by site with planning-zone distances.
- **State and local emergency management**: one map of facilities, alerts and readings.

---

## 7. Where it stands today

- Working product: tested, deployed as a public demo. **[fill in: URL]**
- Partner mode: sign-in for invited organisations, private instances, invites live in minutes.
- Exports: CSV of the fleet with status, printable site brief.
- Open-source core (AGPL-3.0); the hosted service is the product.

---

## 8. Roadmap with the first pilot

1. Alerts: email, Teams, webhooks on status changes and NRC events at watched sites.
2. NRC Licensee Event Reports and inspection findings.
3. Partner API and docs; SSO.
4. Security review and a reviewed legal package.

*Notes: everything here is partner-driven; none of it is needed to win the first meeting.*

---

## 9. Adoption and funding

- Free public demo → 2–3 invited pilots (4–6 weeks) → paid organisation plans.
- Funding fit to confirm: DOE SBIR/STTR (nuclear operations, grid resilience), DOE GAIN vouchers, state resilience grants; NEI and EPRI as pilot partners.

---

## 10. The ask

**[fill in]**: amount, what it funds, timeline, and what a pilot partner commits to (two named users, a weekly 30-minute check-in, feedback on alerts).

**Team** **[fill in]**

**Contact** **[fill in]**
