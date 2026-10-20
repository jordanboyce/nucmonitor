/**
 * Live per-facility hazard state for the nuclear hub.
 *
 * data-loader feeds every hazard source in here as it refreshes; the
 * hazards panel, the facility directory and the map read the same computed
 * summaries, so a site never shows "Warning" in one place and "Normal" in
 * another. Recomputation is coalesced to one microtask because several feeds
 * land in the same tick on first load.
 */

import type { Earthquake } from '@/services/earthquakes';
import type { WeatherAlert } from '@/services/weather';
import type { RadiationObservation } from '@/services/radiation';
import type { MapFire } from '@/services/wildfires';
import type { InternetOutage, NaturalEvent } from '@/types';
import {
  correlateFacilityHazards,
  type FacilityHazardInputs,
  type FacilityHazardReport,
} from '@/services/nuclear-facility-hazards';
import { buildSiteRiskSummaries, type SiteRiskSummary } from '@/services/nuclear-site-risk';

export interface SiteRiskSnapshot {
  reports: FacilityHazardReport[];
  summaries: SiteRiskSummary[];
  byId: Map<string, SiteRiskSummary>;
  /** True once at least one hazard feed has landed. */
  ready: boolean;
  computedAt: Date | null;
}

type Listener = (snapshot: SiteRiskSnapshot) => void;

const inputs: FacilityHazardInputs = {};
const listeners = new Set<Listener>();
let snapshot: SiteRiskSnapshot = {
  reports: [],
  summaries: buildSiteRiskSummaries([]),
  byId: new Map(),
  ready: false,
  computedAt: null,
};
snapshot.byId = new Map(snapshot.summaries.map((s) => [s.facility.id, s]));
let scheduled = false;

function recompute(): void {
  scheduled = false;
  const now = new Date();
  const reports = correlateFacilityHazards({ ...inputs, now });
  const summaries = buildSiteRiskSummaries(reports);
  snapshot = {
    reports,
    summaries,
    byId: new Map(summaries.map((s) => [s.facility.id, s])),
    ready: true,
    computedAt: now,
  };
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (err) {
      console.error('[nuclear-site-risk] listener failed', err);
    }
  }
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  if (typeof queueMicrotask === 'function') queueMicrotask(recompute);
  else recompute();
}

export const nuclearSiteRiskStore = {
  setEarthquakes(value: Earthquake[]): void { inputs.earthquakes = value; schedule(); },
  setWeatherAlerts(value: WeatherAlert[]): void { inputs.weatherAlerts = value; schedule(); },
  setFires(value: MapFire[]): void { inputs.fires = value; schedule(); },
  setRadiation(value: RadiationObservation[]): void { inputs.radiation = value; schedule(); },
  setNaturalEvents(value: NaturalEvent[]): void { inputs.naturalEvents = value; schedule(); },
  setOutages(value: InternetOutage[]): void { inputs.outages = value; schedule(); },
  getSnapshot(): SiteRiskSnapshot { return snapshot; },
  /** Subscribe to recomputations; returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
