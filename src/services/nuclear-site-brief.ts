/**
 * One-page printable brief for a single nuclear facility: registry facts,
 * latest NRC reactor power, and every hazard signal inside its emergency
 * planning zones. Built as a standalone HTML document and handed to
 * `printReportDocument`, so partners can print or "Save as PDF" it for a
 * morning meeting.
 *
 * Pure string builder: every dynamic value goes through `escapeReportHtml`
 * and links through `briefUrl`, so the document is safe to write into the
 * print iframe.
 */

import {
  getNrcRegion,
  NRC_REGION_NAMES,
  nrcDocketUrl,
  US_NUCLEAR_CATEGORY_LABELS,
  US_NUCLEAR_REGISTRY_AS_OF,
  US_NUCLEAR_REGISTRY_SOURCES,
  US_NUCLEAR_STATUS_LABELS,
} from '@/config/us-nuclear-facilities';
import { escapeReportHtml as esc } from '@/utils/export-report';
import {
  formatMiles,
  INGESTION_EPZ_MILES,
  PLUME_EPZ_MILES,
  SITE_RISK_STATUS_LABELS,
  type SiteReactorPower,
  type SiteRiskSummary,
  type SiteRiskZone,
} from '@/services/nuclear-site-risk';

const ZONE_LABEL: Record<SiteRiskZone, string> = {
  plume: `Within ${PLUME_EPZ_MILES} mi`,
  ingestion: `${PLUME_EPZ_MILES}–${INGESTION_EPZ_MILES} mi`,
  regional: `Beyond ${INGESTION_EPZ_MILES} mi`,
};

/** Only http(s) links survive. */
function briefUrl(value: string | undefined): string {
  const raw = (value ?? '').trim();
  return /^https?:\/\//i.test(raw) ? esc(raw) : '';
}

function link(href: string | undefined, text: string): string {
  const url = briefUrl(href);
  return url ? `<a href="${url}">${esc(text)}</a>` : esc(text);
}

export interface SiteBriefOptions {
  power?: SiteReactorPower[];
  generatedAt?: Date;
}

export function buildSiteBriefDocument(summary: SiteRiskSummary, options: SiteBriefOptions = {}): string {
  const f = summary.facility;
  const generatedAt = options.generatedAt ?? new Date();
  const region = getNrcRegion(f.state);
  const units = f.units ?? [];
  const power = options.power ?? [];

  const facts: Array<[string, string]> = [
    ['Category', esc(US_NUCLEAR_CATEGORY_LABELS[f.category])],
    ['Status', esc(US_NUCLEAR_STATUS_LABELS[f.status])],
    ['Operator', esc(f.operator)],
    ['Regulator', `${esc(f.regulator)}${region ? ` · NRC ${esc(NRC_REGION_NAMES[region])}` : ''}`],
    ['Location', `${esc(f.city ? `${f.city}, ${f.state}` : f.state)} · ${esc(f.lat.toFixed(3))}, ${esc(f.lon.toFixed(3))}`],
  ];
  if (f.docket) facts.push(['Docket', link(nrcDocketUrl(f.docket), f.docket)]);
  if (f.isfsi) facts.push(['Spent fuel', 'Dry storage (ISFSI) on site']);

  const unitRows = units.map((u) => {
    const p = power.find((x) => x.registryUnit === u.name);
    return `<tr><td>${esc(u.name)}</td><td>${esc(u.type)}</td><td>${esc(u.netMwe ?? (u.thermalMw !== undefined ? `${u.thermalMw} MWt` : '—'))}</td><td>${esc(u.status)}</td><td>${esc(u.licenseExpires ?? '—')}</td><td>${p ? `${esc(p.power)}%` : '—'}</td></tr>`;
  }).join('');
  const unmatchedPower = power.filter((p) => !units.some((u) => p.registryUnit === u.name));

  const signalRows = summary.signals.map((s) => `<tr class="sev-${esc(s.severity)}">
      <td>${esc(ZONE_LABEL[s.zone])}</td>
      <td>${esc(s.severity)}</td>
      <td>${esc(s.kind)}</td>
      <td>${esc(s.summary)}</td>
      <td>${esc(formatMiles(s.distanceMi))}</td>
      <td>${link(s.sourceUrl, s.source)}${s.at ? ` · ${esc(s.at.toISOString().slice(0, 16).replace('T', ' '))}Z` : ''}</td>
    </tr>`).join('');

  const reportDate = power[0]?.reportDate;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(f.name)} — NucMonitor site brief</title>
<style>
  @page { size: letter; margin: 0.5in; }
  body { font: 11px/1.4 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; margin: 14px 0 4px; border-bottom: 1px solid #999; padding-bottom: 2px; }
  .sub { color: #555; margin-bottom: 8px; }
  .status { display: inline-block; padding: 2px 8px; border-radius: 3px; font-weight: 700; border: 1px solid #333; }
  .status-warning { background: #fdd; border-color: #b00; color: #800; }
  .status-watch { background: #fff3cd; border-color: #b80; color: #640; }
  .status-normal { background: #e6f4ea; border-color: #2a7; color: #154; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 3px 5px; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { background: #f2f2f2; }
  .facts td:first-child { width: 110px; color: #555; }
  .counts td { text-align: center; }
  tr.sev-critical td, tr.sev-high td { font-weight: 600; }
  a { color: #0645ad; }
  .foot { margin-top: 14px; color: #666; font-size: 9.5px; }
</style></head>
<body>
  <h1>${esc(f.name)}</h1>
  <div class="sub">NucMonitor site brief · generated ${esc(generatedAt.toISOString().slice(0, 16).replace('T', ' '))} UTC</div>
  <div><span class="status status-${esc(summary.status)}">${esc(SITE_RISK_STATUS_LABELS[summary.status])}</span>
    ${summary.reasons.length ? ` ${esc(summary.reasons.join('; '))}` : ' No hazard signals inside the emergency planning zones.'}</div>
  ${f.notes ? `<p>${esc(f.notes)}</p>` : ''}

  <h2>Facility</h2>
  <table class="facts">${facts.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table>

  ${units.length ? `<h2>Units${reportDate ? ` · NRC power report ${esc(reportDate)}` : ''}</h2>
  <table><thead><tr><th>Unit</th><th>Type</th><th>Net MWe</th><th>Status</th><th>License expires</th><th>NRC power</th></tr></thead>
  <tbody>${unitRows}</tbody></table>` : ''}
  ${unmatchedPower.length ? `<p>NRC power: ${unmatchedPower.map((p) => `${esc(p.unit)} ${esc(p.power)}%`).join(' · ')}</p>` : ''}

  <h2>Hazards by emergency planning zone</h2>
  <table class="counts"><thead><tr><th>${esc(ZONE_LABEL.plume)} (plume EPZ)</th><th>${esc(ZONE_LABEL.ingestion)} (ingestion EPZ)</th><th>${esc(ZONE_LABEL.regional)}</th><th>Nearest</th></tr></thead>
  <tbody><tr><td>${summary.plume.total}</td><td>${summary.ingestion.total}</td><td>${summary.regional.total}</td><td>${esc(formatMiles(summary.nearestMi))}</td></tr></tbody></table>
  ${summary.signals.length ? `<table style="margin-top:6px"><thead><tr><th>Zone</th><th>Level</th><th>Type</th><th>Signal</th><th>Distance</th><th>Source</th></tr></thead><tbody>${signalRows}</tbody></table>` : '<p>No active public hazard signals near this site.</p>'}

  <h2>References</h2>
  <p>${link(f.url, 'Facility reference page')} · ${link(US_NUCLEAR_REGISTRY_SOURCES.nrcEventReports, 'NRC Event Notification Reports')} · ${link(US_NUCLEAR_REGISTRY_SOURCES.nrcReactorStatus, 'NRC Power Reactor Status')}</p>

  <div class="foot">Status is a proximity screen built from public feeds (USGS, NWS, NASA FIRMS, EPA RadNet / Safecast, NHC / EONET, internet outage monitors),
  not a statement about plant condition. Warning: high/critical signal within ${PLUME_EPZ_MILES} mi, critical within ${INGESTION_EPZ_MILES} mi, or elevated radiation within ${INGESTION_EPZ_MILES} mi.
  Watch: elevated signal within ${INGESTION_EPZ_MILES} mi, critical signal regionally, or 3+ signals within ${PLUME_EPZ_MILES} mi.
  Registry reviewed ${esc(US_NUCLEAR_REGISTRY_AS_OF)}; verify against the NRC before citing.</div>
</body></html>`;
}
