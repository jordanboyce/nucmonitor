/**
 * Server-rendered differentiation copy for dashboard shells (#7380).
 *
 * Variant subdomain dashboards share one SPA shell; without unique body
 * prose their HTML is ~98% identical and compete as near-duplicates.
 * These paragraphs are injected into the persistent SEO summary + noscript
 * fallback (and the AI-crawler stub on variant roots) so each host has
 * 300–500 words of genuine, product-accurate differentiation.
 */

export type VariantSeoKey = 'full' | 'nuclear';

export const VARIANT_SEO_PARAGRAPHS: Record<VariantSeoKey, readonly string[]> = {
  full: [
    'World Monitor is the full-spectrum real-time global intelligence dashboard: one browser workspace that combines geopolitical conflict tracking, military and civil aviation, maritime AIS, undersea cable and infrastructure maps, markets, climate hazards, cyber signals, and open-source news into a single live situation picture. Analysts, journalists, researchers, and operators use it to see how distant events connect before they harden into headlines.',
    'On the map you can follow conflict zones and protest activity alongside earthquake and wildfire alerts, power-outage clusters, and strategic infrastructure such as military bases, nuclear facilities, and subsea cables. Aviation layers surface military and commercial flights; maritime layers track ships through chokepoints and high-risk waters. Country deep-dives open resilience, risk, and source-backed context for more than 190 states without leaving the dashboard.',
    'Market and prediction panels sit beside the geospatial view so price moves, central-bank signals, commodities, and prediction-market odds can be read against the same map context that shows tankers, jets, and crisis corridors. Government-spending and macro indicators help separate noise from policy-relevant shifts. The goal is not another news feed — it is a continuously updating OSINT workbench with auditable upstream sources.',
    'Reference surfaces outside the live map keep the same evidence standard: country intelligence pages, maritime chokepoint briefs, crisis trackers, live tools, research reports, and an audited source catalog. Agents and developers can also use the MCP server and REST API documented on the site. World Monitor is open source and free to start; Pro unlocks deeper analysis without hiding the core map. Specialized sibling monitors focus on tech, finance, commodities, energy infrastructure, and constructive global progress; this full dashboard remains the canonical geopolitics and multi-domain intelligence surface at www.worldmonitor.app/dashboard for humans and crawlers alike.',
    'If you need a single citeable URL for multi-domain situation awareness — conflicts, markets, flights, ships, infrastructure, and climate hazards together — use this full dashboard rather than a specialized sibling. That separation is intentional: tech, finance, commodity, energy, and happy monitors carry their own summaries so crawlers do not treat six shells as near-duplicates.',
  ],
  nuclear: [
    'NucMonitor is the World Monitor variant built as an all-hazards information hub for every nuclear facility in the United States. It brings the commercial power reactor fleet, restart programs such as Palisades and Crane, advanced reactor and small modular reactor projects, decommissioning sites with stranded spent fuel, the Department of Energy and National Nuclear Security Administration complex, enrichment and fuel fabrication plants, university research reactors, uranium recovery operations, and waste disposal sites into one live map and one searchable directory.',
    'The reactor status panel reads the Nuclear Regulatory Commission daily Power Reactor Status Report so readers can see which units are at full power, which are coasting down for refueling or repairs, and what the NRC Operations Center recorded as the reason. The facility all-hazards watch joins United States Geological Survey earthquakes, National Weather Service warnings, NASA FIRMS satellite fire detections, National Hurricane Center storm tracks, and Environmental Protection Agency RadNet plus Safecast radiation observations to each site, ranking facilities by the strongest public hazard signal nearby. Nothing here is a claim that a plant is affected; it is a prompt to read the linked source and the NRC event notification reports.',
    'Official feeds from the NRC, DOE, Office of Nuclear Energy, and the International Atomic Energy Agency sit beside industry reporting from World Nuclear News, the American Nuclear Society, the Nuclear Energy Institute, and trade press, plus policy and security coverage on nonproliferation, spent fuel, and licensing. The directory lists NRC docket numbers, reactor types, net capacities, operators, license expirations, and spent fuel storage status for each site, with links to the NRC facility locator and operating reactor list, DOE site pages, and IAEA PRIS.',
    'Emergency planners, state radiation programs, utility and grid analysts, journalists, researchers, and residents near a plant use NucMonitor when the question is what is happening around a specific nuclear site today. Energy Atlas covers oil, gas, and pipelines; the full World Monitor dashboard covers geopolitics and global nuclear sites. NucMonitor stays focused on the United States nuclear estate, on open data from federal agencies and industry, and on evidence-linked situational awareness that can be cited by people and by AI assistants alike. Canonical home: nuclear.worldmonitor.app/dashboard.',
  ],
};

export function variantSeoWordCount(variant: VariantSeoKey): number {
  return VARIANT_SEO_PARAGRAPHS[variant].join(' ').split(/\s+/).filter(Boolean).length;
}
