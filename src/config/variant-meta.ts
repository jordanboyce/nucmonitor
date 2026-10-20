export interface VariantMeta {
  title: string;
  description: string;
  keywords: string;
  url: string;
  siteName: string;
  shortName: string;
  subject: string;
  classification: string;
  categories: string[];
  features: string[];
}

export const VARIANT_META: { nuclear: VariantMeta; [k: string]: VariantMeta } = {
  nuclear: {
    title: 'NucMonitor - US Nuclear Facility Hub & All-Hazards Dashboard',
    description: 'Real-time hub for every US nuclear facility: NRC reactor power status, all-hazards watch, radiation monitoring, facility directory, and NRC, DOE, and industry news.',
    keywords: 'nuclear facilities, US nuclear plants, NRC reactor status, power reactor status report, nuclear power plant map, NRC event reports, DOE sites, NNSA, spent fuel storage, ISFSI, decommissioning, SMR, advanced reactors, uranium enrichment, fuel cycle, research reactors, RadNet, radiation monitoring, nuclear safety, nuclear hazards, earthquakes near nuclear plants, hurricanes nuclear plants, wildfire nuclear facility, nuclear news',
    // Root-relative: the canonical and og:url tags resolve against whichever host serves the build.
    url: '/dashboard',
    siteName: 'NucMonitor',
    shortName: 'NucMonitor',
    subject: 'US Nuclear Facilities, Reactor Status, and All-Hazards Situational Awareness',
    classification: 'Nuclear Facility Dashboard, Reactor Status Tracker, Radiological Hazard Monitor',
    categories: ['news', 'utilities'],
    features: [
      'Registry of every US nuclear facility (reactors, DOE/NNSA sites, fuel cycle, research reactors, waste)',
      'Daily NRC power reactor status with fleet summary and day-over-day changes',
      'All-hazards watch joining earthquakes, weather alerts, wildfires, storms, and radiation to each site',
      'EPA RadNet and Safecast radiation anomaly monitoring',
      'NRC, DOE, IAEA official feeds beside industry and policy news',
      'Facility directory with NRC dockets, license expirations, capacities, and operators',
      'Map of facilities with hazard overlays and satellite fire detections',
      'Open data sources throughout: NRC, DOE, EIA, EPA, USGS, NWS, NASA FIRMS',
    ],
  },
};
