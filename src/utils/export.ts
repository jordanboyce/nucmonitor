import type { NewsItem, ClusteredEvent, MarketData, Monitor } from '@/types';
import type { IntelligenceCache } from '@/app/app-context';
import { t } from '@/services/i18n';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { showToast } from '@/utils/toast';
import { buildDataReportDocument, printReportDocument, sanitizeExportData } from '@/utils/export-report';
import { SUPPORTED_EXPORT_FORMATS, type DataExportFormat } from '@/services/gates/export-resolver';

type ExportFormat = DataExportFormat;

export interface ExportMeta {
  exportedAt: string;
  note: string;
}

export interface ExportData {
  meta?: ExportMeta;
  timestamp: number;
  news?: NewsItem[];
  newsClusters?: ClusteredEvent[];
  newsByCategory?: Record<string, NewsItem[]>;
  markets?: MarketData[];
  intelligence?: IntelligenceCache;
  monitors?: Monitor[];
}

// The LLM-annotation stripper lives in export-report.ts so all three exporters
// (JSON, CSV, PDF) share one implementation and it can be unit-tested without
// a DOM. Keyword and ML (local model) classifications are retained.

export function exportToJSON(data: ExportData, filename = 'worldmonitor-export'): void {
  const jsonStr = JSON.stringify(sanitizeExportData(data), null, 2);
  downloadFile(jsonStr, `${filename}.json`, 'application/json');
}

/**
 * PDF v1 (KTD7): a printable DATA report, not a dashboard screenshot. The
 * builder sanitizes and escapes internally; this wrapper only owns the print
 * surface and its failure toast.
 */
export function exportToPDF(data: ExportData): Promise<void> {
  return printReportDocument(buildDataReportDocument(data));
}

export function exportToCSV(data: ExportData, filename = 'worldmonitor-export'): void {
  const clean = sanitizeExportData(data);
  const lines: string[] = [];

  lines.push(`# WorldMonitor Export — ${new Date(clean.timestamp).toISOString()}`);
  lines.push('# Note: CSV is a structured summary. Use JSON export for full fidelity.');
  if (clean.meta?.note) lines.push(csvRow([`# ${clean.meta.note}`]));
  lines.push('');

  // News — prefer raw items over clusters; clusters lose individual sources
  const newsItems = clean.news ?? [];
  if (newsItems.length > 0) {
    lines.push('=== NEWS ===');
    lines.push('Title,Source,Link,Published,IsAlert,ThreatLevel,ThreatCategory');
    newsItems.forEach(item => {
      lines.push(csvRow([
        item.title,
        item.source,
        item.link,
        item.pubDate?.toISOString() || '',
        String(item.isAlert),
        item.threat?.level ?? '',
        item.threat?.category ?? '',
      ]));
    });
    lines.push('');
  }

  if (clean.markets && clean.markets.length > 0) {
    lines.push('=== MARKETS ===');
    lines.push('Symbol,Name,Price,Change');
    clean.markets.forEach(m => {
      lines.push(csvRow([m.symbol, m.name, m.price ?? '', m.change ?? '']));
    });
    lines.push('');
  }

  const intel = clean.intelligence;
  if (intel) {
    if (intel.earthquakes && intel.earthquakes.length > 0) {
      lines.push('=== EARTHQUAKES ===');
      lines.push('Place,Magnitude,DepthKm,OccurredAt,URL');
      intel.earthquakes.forEach(e => {
        lines.push(csvRow([e.place, e.magnitude, e.depthKm, new Date(e.occurredAt * 1000).toISOString(), e.sourceUrl]));
      });
      lines.push('');
    }

    if (intel.outages && intel.outages.length > 0) {
      lines.push('=== INTERNET OUTAGES ===');
      lines.push('Title,Country,Severity,PubDate,Link');
      intel.outages.forEach(o => {
        lines.push(csvRow([o.title, o.country, o.severity, o.pubDate.toISOString(), o.link]));
      });
      lines.push('');
    }

    if (intel.radiation?.observations && intel.radiation.observations.length > 0) {
      lines.push('=== RADIATION MONITORING ===');
      lines.push('Location,Country,Value,Unit,ObservedAt');
      intel.radiation.observations.forEach(s => {
        lines.push(csvRow([s.location, s.country, s.value, s.unit, s.observedAt.toISOString()]));
      });
      lines.push('');
    }
  }

  if (clean.monitors && clean.monitors.length > 0) {
    lines.push('=== MONITORS ===');
    lines.push('Name,Keywords,Color');
    clean.monitors.forEach(m => {
      lines.push(csvRow([m.name ?? '', m.keywords.join(';'), m.color]));
    });
    lines.push('');
  }

  downloadFile(lines.join('\n'), `${filename}.csv`, 'text/csv');
}

export interface CountryBriefExport {
  country: string;
  code: string;
  score?: number;
  level?: string;
  trend?: string;
  components?: { unrest: number; conflict: number; security: number; information: number };
  signals?: Record<string, number | string | null>;
  brief?: string;
  headlines?: Array<{ title: string; source: string; link: string; pubDate?: string }>;
  generatedAt: string;
}

export interface CountryEvidenceSourceInput {
  title?: string | null;
  source?: string | null;
  link?: string | null;
  pubDate?: string | Date | null;
}

export interface CountryEvidenceBundleInput {
  country: string;
  code: string;
  context?: string;
  score?: number;
  level?: string;
  trend?: string;
  components?: CountryBriefExport['components'];
  signals?: Record<string, unknown>;
  signalCoverageNotes?: readonly string[];
  brief?: string;
  headlines?: CountryEvidenceSourceInput[];
  generatedAt?: string;
  exportedAt?: string;
  briefGeneratedAt?: string;
  briefCached?: boolean;
}

export interface CountryEvidenceSignal {
  label: string;
  value: string;
}

export interface CountryEvidenceSource {
  title: string;
  publisher?: string;
  url?: string;
  publishedAt?: string;
  freshness: string;
  note?: string;
}

export interface CountryEvidenceBundle {
  country: string;
  code: string;
  context: string;
  exportedAt: string;
  generatedAt?: string;
  briefGeneratedAt?: string;
  briefCacheStatus?: 'cached' | 'fresh';
  score?: number;
  level?: string;
  trend?: string;
  components?: CountryBriefExport['components'];
  signals: CountryEvidenceSignal[];
  brief?: string;
  sources: CountryEvidenceSource[];
  freshnessNotes: string[];
  provenanceDisclaimer: string;
}

export const COUNTRY_EVIDENCE_PROVENANCE_DISCLAIMER =
  'This WorldMonitor evidence bundle packages user-visible context and source metadata for analyst handoff. It is not a legal evidentiary record; verify source availability, timestamps, and claims before reuse.';

const SIGNAL_LABELS: Record<string, string> = {
  criticalNews: 'Critical news',
  protests: 'Protests',
  militaryFlights: 'Military flights nearby',
  militaryVessels: 'Military vessels nearby',
  militaryFlightsInCountry: 'Military flights inside borders',
  militaryVesselsInCountry: 'Military vessels inside borders',
  outages: 'Internet outages',
  aisDisruptions: 'AIS disruptions',
  satelliteFires: 'Satellite fires',
  radiationAnomalies: 'Radiation anomalies',
  temporalAnomalies: 'Observed country temporal anomalies',
  globalTemporalAnomalies: 'Observed global temporal anomalies (not country-attributed)',
  cyberThreats: 'Cyber threats',
  earthquakes: 'Earthquakes',
  displacementOutflow: 'Displacement outflow',
  climateStress: 'Climate stress',
  conflictEvents: 'Conflict events',
  activeStrikes: 'Active strikes',
  orefSirens: 'Active OREF sirens',
  orefHistory24h: 'OREF sirens in 24h',
  aviationDisruptions: 'Aviation disruptions',
  travelAdvisories: 'Travel advisories',
  travelAdvisoryMaxLevel: 'Maximum travel advisory',
  gpsJammingHexes: 'GPS jamming zones',
  thermalEscalations: 'Thermal escalations',
  sanctionsDesignations: 'Sanctions designations',
  sanctionsNewDesignations: 'New sanctions designations',
};

const SECRET_ASSIGNMENT_RE = /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret(?:[_-]?access[_-]?key)?|client[_-]?secret|token|password|authorization|cookie|session))\b(\s*)([:=])(\s*)(["']?)([^"'\s,;]{6,})(["']?)/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g;
const AWS_ACCESS_KEY_ID_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const AWS_SECRET_ACCESS_KEY_RE = /\b(?=[A-Za-z0-9/+=]{40}\b)(?=[A-Za-z0-9/+=]{0,39}[A-Z])(?=[A-Za-z0-9/+=]{0,39}[a-z])(?=[A-Za-z0-9/+=]{0,39}\d)[A-Za-z0-9/+=]{40}\b/g;
const COMMON_SECRET_RE = /\b(?:sk[-_][A-Za-z0-9_-]{12,}|wm_[A-Za-z0-9_=-]{12,}|ghp_[A-Za-z0-9_=-]{12,}|github_pat_[A-Za-z0-9_=-]{12,}|AIza[A-Za-z0-9_-]{20,}|xox[abprsc]-[A-Za-z0-9-]{10,})\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const USER_ID_RE = /\buser_[A-Za-z0-9_-]{6,}\b/g;
const SECRET_URL_PARAM_NAME_RE = /(?:^|[_\-.])(?:api[_\-.]?key|access[_\-.]?key(?:[_\-.]?id)?|awsaccess[_\-.]?key(?:[_\-.]?id)?|secret(?:[_\-.]?access[_\-.]?key)?|client[_\-.]?secret|token|id[_\-.]?token|auth(?:orization)?|password|passwd|pwd|cookie|session|jwt|signature|sig|credential|key)(?:$|[_\-.])/i;

function regexMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matches = pattern.test(value);
  pattern.lastIndex = 0;
  return matches;
}

function isSecretishAssignmentValue(value: string): boolean {
  const clean = value.trim();
  if (
    regexMatches(AWS_ACCESS_KEY_ID_RE, clean)
    || regexMatches(AWS_SECRET_ACCESS_KEY_RE, clean)
    || regexMatches(COMMON_SECRET_RE, clean)
    || regexMatches(JWT_RE, clean)
  ) {
    return true;
  }

  if (clean.length < 16 || !/[A-Za-z]/.test(clean) || !/\d/.test(clean)) return false;
  const classes = [
    /[a-z]/.test(clean),
    /[A-Z]/.test(clean),
    /\d/.test(clean),
    /[-_=+/]/.test(clean),
  ].filter(Boolean).length;
  return classes >= 3 || clean.length >= 24;
}

function sanitizeEvidenceText(value: unknown): string {
  return String(value ?? '')
    .replace(BEARER_RE, 'Bearer [redacted-secret]')
    .replace(SECRET_ASSIGNMENT_RE, (match, key, beforeOperator, operator, afterOperator, openingQuote, secretValue, closingQuote) => {
      if (operator === ':' && !isSecretishAssignmentValue(secretValue)) return match;
      return `${key}${beforeOperator}${operator}${afterOperator}${openingQuote}[redacted-secret]${closingQuote}`;
    })
    .replace(AWS_ACCESS_KEY_ID_RE, '[redacted-secret]')
    .replace(AWS_SECRET_ACCESS_KEY_RE, '[redacted-secret]')
    .replace(COMMON_SECRET_RE, '[redacted-secret]')
    .replace(JWT_RE, '[redacted-secret]')
    .replace(EMAIL_RE, '[redacted-email]')
    .replace(USER_ID_RE, '[redacted-user-id]')
    .trim();
}

function isSensitiveUrlParamName(name: string): boolean {
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
  return SECRET_URL_PARAM_NAME_RE.test(normalized);
}

function sanitizeEvidenceUrlSearchParams(parsed: URL): void {
  if (!parsed.search) return;
  const sanitized = new URLSearchParams();
  let changed = false;
  parsed.searchParams.forEach((value, key) => {
    const sensitiveKey = isSensitiveUrlParamName(key);
    const sanitizedValue = sensitiveKey ? '[redacted-secret]' : sanitizeEvidenceText(value);
    if (sensitiveKey || sanitizedValue !== value) changed = true;
    sanitized.append(key, sanitizedValue);
  });
  if (changed) parsed.search = sanitized.toString() ? `?${sanitized.toString()}` : '';
}

function sanitizeEvidenceUrlFragment(parsed: URL): void {
  if (!parsed.hash) return;
  const fragment = parsed.hash.slice(1);
  const sanitized = sanitizeEvidenceText(fragment);
  if (sanitized !== fragment) parsed.hash = sanitized;
}

function normalizeEvidenceUrl(value: unknown): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (parsed.username) parsed.username = '[redacted-user-id]';
    if (parsed.password) parsed.password = '[redacted-secret]';
    sanitizeEvidenceUrlSearchParams(parsed);
    sanitizeEvidenceUrlFragment(parsed);
    return parsed.toString().replace(/[()]/g, (char) => char === '(' ? '%28' : '%29');
  } catch {
    return undefined;
  }
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : undefined;
}

function signalLabel(key: string): string {
  return SIGNAL_LABELS[key] ?? key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildEvidenceSignals(signals: Record<string, unknown> | undefined): CountryEvidenceSignal[] {
  if (!signals) return [];
  const normalized: Record<string, unknown> = { ...signals };
  if (normalized.cyberThreats === null) normalized.cyberThreats = 'unavailable';
  else if (normalized.cyberThreats === 0) normalized.cyberThreats = '0';
  for (const key of ['temporalAnomalies', 'globalTemporalAnomalies']) {
    if (key in normalized && normalized[key] === null) {
      normalized[key] = 'unavailable';
    }
  }
  return Object.entries(normalized)
    .filter(([, value]) => {
      if (typeof value === 'number') return value > 0;
      if (typeof value === 'string') return value.trim().length > 0;
      return value != null && value !== false;
    })
    .map(([key, value]) => ({
      label: signalLabel(key),
      value: sanitizeEvidenceText(value),
    }));
}

function freshnessForSource(publishedAt: string | undefined, exportedAt: string): string {
  if (!publishedAt) return 'Published timestamp unavailable; freshness could not be computed.';
  const published = new Date(publishedAt).getTime();
  const exported = new Date(exportedAt).getTime();
  if (!Number.isFinite(published) || !Number.isFinite(exported)) {
    return 'Published timestamp unavailable; freshness could not be computed.';
  }
  const ageMs = Math.max(0, exported - published);
  const ageHours = Math.floor(ageMs / 3_600_000);
  if (ageHours < 48) return `${ageHours}h old at export.`;
  return `${Math.floor(ageHours / 24)}d old at export.`;
}

function buildEvidenceSources(
  headlines: CountryEvidenceSourceInput[] | undefined,
  exportedAt: string,
): CountryEvidenceSource[] {
  return (headlines ?? [])
    .filter((headline) => Boolean(
      sanitizeEvidenceText(headline.title)
      || sanitizeEvidenceText(headline.source)
      || normalizeEvidenceUrl(headline.link)
      || normalizeIsoTimestamp(headline.pubDate),
    ))
    .map((headline, index) => {
      const title = sanitizeEvidenceText(headline.title) || `Source ${index + 1} (title unavailable)`;
      const publisher = sanitizeEvidenceText(headline.source) || undefined;
      const url = normalizeEvidenceUrl(headline.link);
      const publishedAt = normalizeIsoTimestamp(headline.pubDate);
      const hadUnsafeOrMissingUrl = Boolean(headline.link) && !url;
      return {
        title,
        publisher,
        url,
        publishedAt,
        freshness: freshnessForSource(publishedAt, exportedAt),
        note: url
          ? undefined
          : hadUnsafeOrMissingUrl
            ? 'URL omitted because it was missing or unsafe.'
            : 'URL unavailable; citation link was not provided.',
      };
    });
}

function buildFreshnessNotes(input: CountryEvidenceBundleInput, exportedAt: string): string[] {
  const notes: string[] = [`Exported at ${exportedAt}.`];
  const briefGeneratedAt = normalizeIsoTimestamp(input.briefGeneratedAt);
  if (briefGeneratedAt) {
    notes.push(`Brief generated at ${briefGeneratedAt}${input.briefCached === true ? ' from cache' : ''}.`);
  } else {
    notes.push('Brief generation timestamp unavailable.');
  }
  if (!input.headlines || input.headlines.length === 0) {
    notes.push('No headline source list was available for this export.');
  }
  for (const note of input.signalCoverageNotes?.slice(0, 12) ?? []) {
    const clean = sanitizeEvidenceText(note).slice(0, 1600).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (clean) notes.push(clean);
  }
  return notes;
}

function markdownListValue(value: string | number | undefined): string {
  const clean = sanitizeEvidenceText(value);
  return clean || 'Unavailable';
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[[\]\\]/g, '\\$&');
}

function escapeMarkdownInline(value: string): string {
  return sanitizeEvidenceText(value)
    .replace(/\s+/g, ' ')
    .replace(/([\\`*_{}[\]()#+\-.!|<>])/g, '\\$1');
}

function renderQuotedEvidenceBlock(value: string): string[] {
  return value.split(/\r?\n/).map((line) => `> ${line}`);
}

export function buildCountryEvidenceBundle(input: CountryEvidenceBundleInput): CountryEvidenceBundle {
  const exportedAt = normalizeIsoTimestamp(input.exportedAt) ?? new Date().toISOString();
  const generatedAt = normalizeIsoTimestamp(input.generatedAt);
  const briefGeneratedAt = normalizeIsoTimestamp(input.briefGeneratedAt);
  const brief = sanitizeEvidenceText(input.brief);
  return {
    country: sanitizeEvidenceText(input.country),
    code: sanitizeEvidenceText(input.code).toUpperCase(),
    context: sanitizeEvidenceText(input.context) || 'Country dossier',
    exportedAt,
    generatedAt,
    briefGeneratedAt,
    briefCacheStatus: input.briefCached === true ? 'cached' : input.briefCached === false ? 'fresh' : undefined,
    score: input.score,
    level: sanitizeEvidenceText(input.level) || undefined,
    trend: sanitizeEvidenceText(input.trend) || undefined,
    components: input.components,
    signals: buildEvidenceSignals(input.signals),
    brief: brief || undefined,
    sources: buildEvidenceSources(input.headlines, exportedAt),
    freshnessNotes: buildFreshnessNotes(input, exportedAt),
    provenanceDisclaimer: COUNTRY_EVIDENCE_PROVENANCE_DISCLAIMER,
  };
}

export function renderCountryEvidenceMarkdown(bundle: CountryEvidenceBundle): string {
  const lines: string[] = [];
  lines.push(`# WorldMonitor Evidence Bundle: ${bundle.country} (${bundle.code})`);
  lines.push('');
  lines.push(`- Context: ${markdownListValue(bundle.context)}`);
  lines.push(`- Exported at: ${markdownListValue(bundle.exportedAt)}`);
  if (bundle.generatedAt) lines.push(`- Bundle generated at: ${markdownListValue(bundle.generatedAt)}`);
  if (bundle.briefGeneratedAt) {
    const cacheSuffix = bundle.briefCacheStatus ? ` (${bundle.briefCacheStatus})` : '';
    lines.push(`- Brief generated at: ${markdownListValue(bundle.briefGeneratedAt)}${cacheSuffix}`);
  }
  lines.push('');

  lines.push('## Risk Context');
  if (bundle.score != null) {
    lines.push(`- Instability score: ${bundle.score}/100`);
    lines.push(`- Level: ${markdownListValue(bundle.level)}`);
    lines.push(`- Trend: ${markdownListValue(bundle.trend)}`);
  } else {
    lines.push('- Instability score: unavailable in this dossier.');
  }
  if (bundle.components) {
    lines.push(`- Components: unrest ${bundle.components.unrest}, conflict ${bundle.components.conflict}, security ${bundle.components.security}, information ${bundle.components.information}`);
  }
  lines.push('');

  lines.push('## Selected Signals');
  if (bundle.signals.length > 0) {
    bundle.signals.forEach((signal) => {
      lines.push(`- ${signal.label}: ${signal.value}`);
    });
  } else {
    lines.push('- No active signal counts were available in this dossier.');
  }
  lines.push('');

  if (bundle.brief) {
    lines.push('## Intelligence Brief');
    lines.push('');
    lines.push(...renderQuotedEvidenceBlock(bundle.brief));
    lines.push('');
  }

  lines.push('## Sources');
  if (bundle.sources.length > 0) {
    bundle.sources.forEach((source, index) => {
      const title = source.url
        ? `[${escapeMarkdownLinkText(source.title)}](${source.url})`
        : escapeMarkdownInline(source.title);
      const label = `${index + 1}. ${title}`;
      lines.push(label);
      lines.push(`   - Publisher: ${escapeMarkdownInline(markdownListValue(source.publisher))}`);
      lines.push(`   - Published at: ${markdownListValue(source.publishedAt)}`);
      lines.push(`   - Freshness: ${source.freshness}`);
      if (source.note) lines.push(`   - Note: ${source.note}`);
    });
  } else {
    lines.push('- No source links were available for this export.');
  }
  lines.push('');

  lines.push('## Freshness Notes');
  bundle.freshnessNotes.forEach((note) => lines.push(`- ${note}`));
  lines.push('');

  lines.push('## Provenance Disclaimer');
  lines.push(bundle.provenanceDisclaimer);
  lines.push('');
  return lines.join('\n');
}

export function countryEvidenceMarkdownArtifact(data: CountryEvidenceBundleInput): import('./country-text-download').CountryTextArtifact {
  const bundle = buildCountryEvidenceBundle(data);
  const timestamp = bundle.exportedAt.replace(/[:.]/g, '-');
  return { content: renderCountryEvidenceMarkdown(bundle), filename: `country-evidence-${bundle.code}-${timestamp}.md`, mimeType: 'text/markdown;charset=utf-8' };
}

export function exportCountryEvidenceMarkdown(data: CountryEvidenceBundleInput): void {
  const artifact = countryEvidenceMarkdownArtifact(data);
  downloadFile(artifact.content, artifact.filename, artifact.mimeType);
}

export function exportCountryBriefJSON(data: CountryBriefExport): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  downloadFile(JSON.stringify(data, null, 2), `country-brief-${data.code}-${timestamp}.json`, 'application/json');
}

export function exportCountryBriefCSV(data: CountryBriefExport): void {
  const lines: string[] = [];
  lines.push(csvRow([`Country Brief: ${data.country} (${data.code})`]));
  lines.push(csvRow([`Generated: ${data.generatedAt}`]));
  lines.push('');
  if (data.score != null) {
    lines.push(`Score,${data.score}`);
    lines.push(csvRow(['Level', data.level || '']));
    lines.push(csvRow(['Trend', data.trend || '']));
  }
  if (data.components) {
    lines.push('');
    lines.push('Component,Value');
    lines.push(`Unrest,${data.components.unrest}`);
    lines.push(`Conflict,${data.components.conflict}`);
    lines.push(`Security,${data.components.security}`);
    lines.push(`Information,${data.components.information}`);
  }
  if (data.signals) {
    lines.push('');
    lines.push('Signal,Count');
    for (const [k, v] of Object.entries(data.signals)) {
      lines.push(csvRow([k, typeof v === 'number' ? v : String(v)]));
    }
  }
  if (data.headlines && data.headlines.length > 0) {
    lines.push('');
    lines.push('Title,Source,Link,Published');
    data.headlines.forEach(h => lines.push(csvRow([h.title, h.source, h.link, h.pubDate || ''])));
  }
  if (data.brief) {
    lines.push('');
    lines.push('Intelligence Brief');
    lines.push(csvRow([data.brief]));
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  downloadFile(lines.join('\n'), `country-brief-${data.code}-${timestamp}.csv`, 'text/csv');
}

function csvRow(values: (string | number)[]): string {
  return values.map(value => {
    if (typeof value === 'number') return `"${value}"`;
    const text = value || '';
    const safe = /^[\t\r\n]|^\s*[=+@-]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  }).join(',');
}

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export class ExportPanel {
  private element: HTMLElement;
  private isOpen = false;
  private getData: () => ExportData;
  private availableFormats = new Set<DataExportFormat>();

  constructor(getDataFn: () => ExportData, formats: readonly DataExportFormat[] = SUPPORTED_EXPORT_FORMATS) {
    this.getData = getDataFn;
    this.element = document.createElement('div');
    this.element.className = 'export-panel-container';
    setTrustedHtml(this.element, trustedHtml(`
      <button class="export-btn" title="${t('common.exportData')}">⬇</button>
      <div class="export-menu hidden">
        <button class="export-option" data-format="csv">${t('common.exportCsv')}</button>
        <button class="export-option" data-format="json">${t('common.exportJson')}</button>
        <button class="export-option" data-format="pdf">${t('common.exportPdf')}</button>
      </div>
    `, "legacy direct innerHTML migration"));

    this.setAvailableFormats(formats);
    this.setupEventListeners();
  }

  /** Update the menu in place when a live entitlement snapshot changes. */
  public setAvailableFormats(formats: readonly DataExportFormat[]): void {
    this.availableFormats = new Set(formats);
    this.element.querySelectorAll<HTMLButtonElement>('.export-option').forEach((button) => {
      const format = button.dataset.format as DataExportFormat;
      button.hidden = !this.availableFormats.has(format);
    });
  }

  private setupEventListeners(): void {
    const btn = this.element.querySelector('.export-btn')!;
    const menu = this.element.querySelector('.export-menu')!;

    btn.addEventListener('click', () => {
      this.isOpen = !this.isOpen;
      menu.classList.toggle('hidden', !this.isOpen);
    });

    document.addEventListener('click', (e) => {
      if (!this.element.contains(e.target as Node)) {
        this.isOpen = false;
        menu.classList.add('hidden');
      }
    });

    this.element.querySelectorAll('.export-option').forEach(option => {
      option.addEventListener('click', () => {
        const button = option as HTMLButtonElement;
        const format = button.dataset.format as ExportFormat;
        if (!this.availableFormats.has(format)) return;
        if (format === 'pdf') {
          // The report renders and prints asynchronously, so the menu stays
          // open with the option in a busy state until it settles — and a
          // failure surfaces a toast instead of the source pattern's silence.
          void this.exportPdfWithFeedback(button, menu);
          return;
        }
        this.export(format);
        this.isOpen = false;
        menu.classList.add('hidden');
      });
    });
  }

  private async exportPdfWithFeedback(button: HTMLButtonElement, menu: Element): Promise<void> {
    if (button.disabled) return;
    const label = button.textContent;
    button.disabled = true;
    button.classList.add('is-exporting');
    button.textContent = t('components.exportGate.preparingPdf');
    try {
      await exportToPDF(this.getData());
    } catch (err) {
      console.warn('[export] PDF report failed:', err);
      showToast(t('components.exportGate.pdfFailed'));
    } finally {
      button.disabled = false;
      button.classList.remove('is-exporting');
      button.textContent = label;
      this.isOpen = false;
      menu.classList.add('hidden');
    }
  }

  private export(format: ExportFormat): void {
    const data = this.getData();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `worldmonitor-${timestamp}`;

    if (format === 'json') {
      exportToJSON(data, filename);
    } else {
      exportToCSV(data, filename);
    }
  }

  public getElement(): HTMLElement {
    return this.element;
  }
}
