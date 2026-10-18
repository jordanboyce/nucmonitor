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

export const VARIANT_META: { full: VariantMeta; [k: string]: VariantMeta } = {
  full: {
    title: 'World Monitor - Real-Time Global Intelligence Dashboard',
    description: 'Real-time global intelligence: conflicts, markets, military, OSINT signals — live in 190+ countries; structural resilience ranked for 170 of 196 countries.',
    keywords: 'AI intelligence, AI-powered dashboard, global intelligence, geopolitical dashboard, world news, market data, military bases, nuclear facilities, undersea cables, conflict zones, real-time monitoring, situation awareness, OSINT, flight tracking, AIS ships, earthquake monitor, protest tracker, power outages, oil prices, government spending, polymarket predictions',
    url: 'https://www.worldmonitor.app/dashboard',
    siteName: 'World Monitor',
    shortName: 'World Monitor',
    subject: 'AI-Powered Global Intelligence and Situation Awareness',
    classification: 'AI Intelligence Dashboard, OSINT Tool, News Aggregator',
    categories: ['news', 'productivity'],
    features: [
      'Real-time news aggregation',
      'Stock market tracking',
      'Military flight monitoring',
      'Ship AIS tracking',
      'Earthquake alerts',
      'Protest tracking',
      'Power outage monitoring',
      'Oil price analytics',
      'Government spending data',
      'Prediction markets',
      'Infrastructure monitoring',
      'Geopolitical intelligence',
    ],
  },
  nuclear: {
    title: 'NucMonitor - US Nuclear Facility Hub & All-Hazards Dashboard',
    description: 'Real-time hub for every US nuclear facility: NRC reactor power status, all-hazards watch, radiation monitoring, facility directory, and NRC, DOE, and industry news.',
    keywords: 'nuclear facilities, US nuclear plants, NRC reactor status, power reactor status report, nuclear power plant map, NRC event reports, DOE sites, NNSA, spent fuel storage, ISFSI, decommissioning, SMR, advanced reactors, uranium enrichment, fuel cycle, research reactors, RadNet, radiation monitoring, nuclear safety, nuclear hazards, earthquakes near nuclear plants, hurricanes nuclear plants, wildfire nuclear facility, nuclear news',
    url: 'https://nuclear.worldmonitor.app/dashboard',
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
