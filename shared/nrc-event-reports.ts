// NRC Event Notification Report (ENR) parser.
//
// The NRC Operations Center publishes one HTML page per calendar day listing
// every event a licensee (or an Agreement State, on a licensee's behalf)
// reported under 10 CFR 50.72, 50.73, 20.2201, Part 21 and friends:
//   https://www.nrc.gov/reading-rm/doc-collections/event-status/event/YYYY/YYYYMMDDen.html
//
// Each event is a small block of tables: a header row naming the event
// category and number, a label/value grid (Facility, Region, State, Unit,
// Notification Date, Emergency Class, 10 CFR Section, …), an optional unit
// table for power reactors (SCRAM code, initial/current power and mode), and
// the free-text "Event Text" with a title line and the licensee's narrative.
// Updates and retractions are appended to the narrative as
// "* * * UPDATE ON … * * *" / "* * * RETRACTION ON … * * *" paragraphs and the
// event is re-listed on the day of the update.
//
// The parser works on a text rendering of the page and keys every field off
// its label, never off table position, so a reordered grid or an extra column
// degrades to a missing field instead of a wrong one. It is pure (no DOM, no
// imports) so the edge function, the browser and node tests share it.

export type NrcEventCategory =
  | 'power-reactor'
  | 'non-power-reactor'
  | 'fuel-cycle'
  | 'agreement-state'
  | 'materials'
  | 'hospital'
  | 'part-21'
  | 'other';

export type NrcEmergencyClass =
  | 'non-emergency'
  | 'unusual-event'
  | 'alert'
  | 'site-area-emergency'
  | 'general-emergency'
  | 'unknown';

export interface NrcEventUnit {
  unit: string;
  scramCode?: string;
  reactorCritical?: boolean;
  initialPower?: number;
  initialMode?: string;
  currentPower?: number;
  currentMode?: string;
}

export interface NrcCfrSection {
  code: string;
  description: string;
}

export interface NrcEventReport {
  eventNumber: string;
  category: NrcEventCategory;
  /** Category label exactly as the NRC printed it. */
  categoryLabel: string;
  /** Facility (reactors, fuel cycle) or licensee (materials, Agreement State). */
  facility: string;
  /** Reporting organisation for Agreement State events. */
  reportingOrg?: string;
  /** Unit numbers flagged in the "Unit: [1] [ ] [3]" field. */
  units: string[];
  region?: number;
  state?: string;
  city?: string;
  /** ISO date (YYYY-MM-DD). */
  notificationDate?: string;
  notificationTime?: string;
  eventDate?: string;
  eventTime?: string;
  lastUpdateDate?: string;
  emergencyClass: NrcEmergencyClass;
  emergencyClassLabel?: string;
  cfrSections: NrcCfrSection[];
  unitStatus: NrcEventUnit[];
  title: string;
  /** Licensee narrative, whitespace-normalised and bounded. */
  narrative: string;
  retracted: boolean;
  updated: boolean;
  /** ISO date of the daily report this copy came from. */
  reportDate?: string;
  sourceUrl: string;
}

export const NRC_EVENT_REPORTS_INDEX = 'https://www.nrc.gov/reading-rm/doc-collections/event-status/event/';
export const NRC_EVENT_NARRATIVE_MAX_CHARS = 4000;

export const NRC_EMERGENCY_CLASS_LABELS: Record<NrcEmergencyClass, string> = {
  'non-emergency': 'Non-emergency',
  'unusual-event': 'Unusual Event',
  alert: 'Alert',
  'site-area-emergency': 'Site Area Emergency',
  'general-emergency': 'General Emergency',
  unknown: 'Unclassified',
};

/** Higher is more severe; drives sorting and badges. */
export const NRC_EMERGENCY_CLASS_RANK: Record<NrcEmergencyClass, number> = {
  'general-emergency': 5,
  'site-area-emergency': 4,
  alert: 3,
  'unusual-event': 2,
  'non-emergency': 1,
  unknown: 0,
};

export const NRC_EVENT_CATEGORY_LABELS: Record<NrcEventCategory, string> = {
  'power-reactor': 'Power reactor',
  'non-power-reactor': 'Research / test reactor',
  'fuel-cycle': 'Fuel cycle',
  'agreement-state': 'Agreement State',
  materials: 'Materials',
  hospital: 'Hospital / medical',
  'part-21': 'Part 21',
  other: 'Other',
};

/** Daily ENR page URL for a UTC calendar date. */
export function nrcEventReportPageUrl(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${NRC_EVENT_REPORTS_INDEX}${y}/${y}${m}${d}en.html`;
}

// ── HTML → text ────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', deg: '°', sect: '§',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return NAMED_ENTITIES[lower] ?? match;
  });
}

/**
 * Text rendering that keeps the structure the parser needs: table cells end in
 * a tab, rows/paragraphs/line breaks end in a newline.
 */
export function nrcHtmlToText(html: string): string {
  return decodeEntities(
    String(html || '')
      // Source whitespace is insignificant in HTML; only tags make structure.
      .replace(/\s+/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|head|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(td|th)\s*>/gi, '\t')
      .replace(/<\/(tr|p|div|h[1-6]|li|table|caption)\s*>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\r\n?/g, '\n')
    .replace(/[  ]+/g, ' ')
    .replace(/ *\t */g, '\t')
    .replace(/ *\n */g, '\n');
}

// ── Field normalisation ────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** "10/16/2026" or "October 16, 2026" → "2026-10-16". */
export function normalizeNrcDate(value: string | undefined): string | undefined {
  const text = String(value || '').trim();
  let m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  m = text.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    if (month) return `${m[3]}-${String(month).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  }
  return undefined;
}

export function normalizeNrcCategory(label: string): NrcEventCategory {
  const l = label.toLowerCase();
  if (/non[- ]?power/.test(l) || /research|test reactor/.test(l)) return 'non-power-reactor';
  if (/power reactor/.test(l)) return 'power-reactor';
  if (/fuel cycle/.test(l)) return 'fuel-cycle';
  if (/agreement state/.test(l)) return 'agreement-state';
  if (/hospital|medical/.test(l)) return 'hospital';
  if (/part 21/.test(l)) return 'part-21';
  if (/material/.test(l)) return 'materials';
  return 'other';
}

export function normalizeNrcEmergencyClass(label: string | undefined): NrcEmergencyClass {
  const l = String(label || '').toLowerCase();
  if (!l.trim()) return 'unknown';
  if (/non[- ]?emergency/.test(l)) return 'non-emergency';
  if (/general emergency/.test(l)) return 'general-emergency';
  if (/site area/.test(l)) return 'site-area-emergency';
  if (/unusual event/.test(l)) return 'unusual-event';
  if (/\balert\b/.test(l)) return 'alert';
  return 'unknown';
}

// Every label the ENR grid uses. Longest-first so "Event Date" never matches
// inside "Notification Date" and "Unit" never steals "Unit:" from the table.
const FIELD_LABELS = [
  'Person (Organization)',
  'Notification Date',
  'Notification Time',
  'Last Update Date',
  'NRC Notified By',
  'HQ OPS Officer',
  'Emergency Class',
  '10 CFR Section',
  'Event Number',
  'Event Date',
  'Event Time',
  'License #',
  'Agreement',
  'Licensee',
  'Facility',
  'Rep Org',
  'RX Type',
  'Region',
  'County',
  'Docket',
  'State',
  'City',
  'Unit',
] as const;
type FieldLabel = (typeof FIELD_LABELS)[number];

const MULTILINE_FIELDS: ReadonlySet<FieldLabel> = new Set(['10 CFR Section', 'Person (Organization)']);

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const LABEL_RE = new RegExp(`(?:^|[\\t ])(${FIELD_LABELS.map(escapeRegex).join('|')})\\s*:`, 'gi');
const CANONICAL_LABEL = new Map(FIELD_LABELS.map((l) => [l.toLowerCase(), l]));

interface LabelHit { label: FieldLabel; start: number; valueStart: number }

function findLabels(line: string): LabelHit[] {
  const hits: LabelHit[] = [];
  LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LABEL_RE.exec(line)) !== null) {
    const label = CANONICAL_LABEL.get(m[1]!.toLowerCase());
    if (!label) continue;
    hits.push({ label, start: m.index + (m[0].length - m[0].trimStart().length), valueStart: m.index + m[0].length });
  }
  return hits;
}

function isUnitTableHeader(line: string): boolean {
  const l = line.toLowerCase();
  return l.includes('scram') && (l.includes('initial pwr') || l.includes('initial power'));
}

function isEventTextMarker(line: string): boolean {
  return /^\s*event text\s*$/i.test(line.replace(/\t/g, ' '));
}

function cells(line: string): string[] {
  return line.split('\t').map((c) => c.trim());
}

function parseUnitTable(header: string, rows: string[]): NrcEventUnit[] {
  const cols = cells(header).map((c) => c.toLowerCase());
  const idx = (pred: (c: string) => boolean): number => cols.findIndex(pred);
  const iUnit = idx((c) => c === 'unit');
  const iScram = idx((c) => c.includes('scram'));
  const iCrit = idx((c) => c.includes('crit'));
  const iInitPwr = idx((c) => c.startsWith('initial') && (c.includes('pwr') || c.includes('power')));
  const iInitMode = idx((c) => c.startsWith('initial') && c.includes('mode'));
  const iCurPwr = idx((c) => c.startsWith('current') && (c.includes('pwr') || c.includes('power')));
  const iCurMode = idx((c) => c.startsWith('current') && c.includes('mode'));
  const num = (v: string | undefined): number | undefined => {
    const n = Number.parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10);
    return Number.isFinite(n) && n >= 0 && n <= 120 ? n : undefined;
  };
  const text = (v: string | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);
  const out: NrcEventUnit[] = [];
  for (const row of rows) {
    const c = cells(row);
    const unit = text(c[iUnit >= 0 ? iUnit : 0]);
    if (!unit || !/^\d{1,2}$/.test(unit)) continue;
    const crit = text(c[iCrit]);
    out.push({
      unit,
      scramCode: iScram >= 0 ? text(c[iScram]) : undefined,
      reactorCritical: crit === undefined ? undefined : /^y/i.test(crit),
      initialPower: iInitPwr >= 0 ? num(c[iInitPwr]) : undefined,
      initialMode: iInitMode >= 0 ? text(c[iInitMode]) : undefined,
      currentPower: iCurPwr >= 0 ? num(c[iCurPwr]) : undefined,
      currentMode: iCurMode >= 0 ? text(c[iCurMode]) : undefined,
    });
  }
  return out;
}

function parseCfrSections(lines: string[]): NrcCfrSection[] {
  const out: NrcCfrSection[] = [];
  for (const raw of lines) {
    for (const part of raw.split('\t')) {
      const line = part.trim();
      if (!line) continue;
      // "50.72(b)(2)(iv)(B) - RPS Actuation - Critical", "70 App A (b)(1) - …",
      // or a bare designation such as "Agreement State" / "21.21(d)(3)(i)".
      const dash = line.search(/\s[-–]\s/);
      if (dash > 0) out.push({ code: line.slice(0, dash).trim(), description: line.slice(dash + 3).trim() });
      else out.push({ code: line, description: '' });
    }
  }
  return out;
}

function boundNarrative(text: string): string {
  const normalized = text
    .split('\n')
    .map((l) => l.replace(/\t+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (normalized.length <= NRC_EVENT_NARRATIVE_MAX_CHARS) return normalized;
  const cut = normalized.slice(0, NRC_EVENT_NARRATIVE_MAX_CHARS);
  const lastBreak = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return `${cut.slice(0, lastBreak > NRC_EVENT_NARRATIVE_MAX_CHARS * 0.6 ? lastBreak + 1 : cut.length).trim()} …`;
}

function looksLikeTitle(line: string): boolean {
  const letters = line.replace(/[^A-Za-z]/g, '');
  if (letters.length < 4 || line.length > 200) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length > 0.8;
}

// Footer chrome and the "EN Revision Imported Date" stamp the NRC prepends to
// revised event text are not part of the narrative.
const FOOTER_RE = /^(page last reviewed|privacy policy|site map|contact us|accessibility|freedom of information|en revision (imported|text))/i;

function parseEventBlock(lines: string[], categoryLabel: string, eventNumber: string, pageUrl: string, reportDate?: string): NrcEventReport {
  const fields = new Map<FieldLabel, string>();
  const multi = new Map<FieldLabel, string[]>();
  let continuing: FieldLabel | null = null;
  let unitHeader: string | null = null;
  const unitRows: string[] = [];
  let i = 0;

  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (isEventTextMarker(line)) { i++; break; }
    if (isUnitTableHeader(line)) {
      unitHeader = line;
      continuing = null;
      while (i + 1 < lines.length && /^\s*\d{1,2}\t/.test(lines[i + 1]!)) unitRows.push(lines[++i]!);
      continue;
    }
    const hits = findLabels(line);
    if (hits.length === 0) {
      const plain = line.replace(/\t/g, ' ').trim();
      if (!plain) { continuing = null; continue; }
      // A multi-line cell (CFR sections, people) continues until a blank line
      // or the next label; cells and tables always end in a line break.
      if (continuing) { multi.get(continuing)!.push(plain); continue; }
      // No "Event Text" marker: once the grid has its emergency class, the
      // first all-caps line is the title.
      if (fields.has('Emergency Class') && looksLikeTitle(plain)) break;
      continue;
    }
    // Text before the first label on a line belongs to the cell still open
    // from the line above (the last CFR line shares a row with the next cell).
    const prefix = line.slice(0, hits[0]!.start).replace(/\t/g, ' ').trim();
    if (continuing && prefix) multi.get(continuing)!.push(prefix);
    continuing = null;
    hits.forEach((hit, k) => {
      const end = k + 1 < hits.length ? hits[k + 1]!.start : line.length;
      const value = line.slice(hit.valueStart, end).replace(/\t/g, ' ').trim();
      if (MULTILINE_FIELDS.has(hit.label)) {
        const bucket = multi.get(hit.label) ?? [];
        if (value) bucket.push(value);
        multi.set(hit.label, bucket);
        if (k === hits.length - 1) continuing = hit.label;
      } else if (!fields.has(hit.label)) {
        fields.set(hit.label, value);
      }
    });
  }

  const textLines = lines.slice(i).filter((l) => !FOOTER_RE.test(l.trim()));
  while (textLines.length && !textLines[0]!.trim()) textLines.shift();
  let title = '';
  if (textLines.length && looksLikeTitle(textLines[0]!.replace(/\t/g, ' ').trim())) {
    title = textLines.shift()!.replace(/\t/g, ' ').trim();
  }
  const narrative = boundNarrative(textLines.join('\n'));

  const unitField = fields.get('Unit') ?? '';
  const bracketed = [...unitField.matchAll(/\[\s*(\d{1,2})\s*\]/g)].map((m) => m[1]!);
  const unitStatus = unitHeader ? parseUnitTable(unitHeader, unitRows) : [];
  const units = bracketed.length ? bracketed : unitStatus.map((u) => u.unit);
  const region = Number.parseInt(fields.get('Region') ?? '', 10);
  const state = (fields.get('State') ?? '').match(/\b([A-Z]{2})\b/)?.[1];
  const emergencyClassLabel = fields.get('Emergency Class') || undefined;
  const fullText = textLines.join('\n');
  const facility = (fields.get('Facility') || fields.get('Licensee') || '').trim();

  return {
    eventNumber,
    category: normalizeNrcCategory(categoryLabel),
    categoryLabel: categoryLabel || 'Unknown',
    facility,
    reportingOrg: fields.get('Rep Org') || undefined,
    units,
    region: Number.isFinite(region) && region >= 1 && region <= 4 ? region : undefined,
    state,
    city: fields.get('City') || undefined,
    notificationDate: normalizeNrcDate(fields.get('Notification Date')),
    notificationTime: fields.get('Notification Time') || undefined,
    eventDate: normalizeNrcDate(fields.get('Event Date')),
    eventTime: fields.get('Event Time') || undefined,
    lastUpdateDate: normalizeNrcDate(fields.get('Last Update Date')),
    emergencyClass: normalizeNrcEmergencyClass(emergencyClassLabel),
    emergencyClassLabel,
    cfrSections: parseCfrSections(multi.get('10 CFR Section') ?? []),
    unitStatus,
    title: title || (facility ? `${facility} event ${eventNumber}` : `Event ${eventNumber}`),
    narrative,
    retracted: /\*\s*\*\s*\*\s*retract/i.test(fullText) || /^retraction\b/i.test(title),
    updated: /\*\s*\*\s*\*\s*update/i.test(fullText),
    reportDate,
    sourceUrl: `${pageUrl}#en${eventNumber}`,
  };
}

const EVENT_NUMBER_RE = /Event Number\s*:\s*(\d{4,7})/i;

/**
 * Parse one daily ENR page. `pageUrl` becomes each event's source link (with
 * the page's `#en{number}` anchor); `reportDate` falls back to the page title.
 */
export function parseNrcEventReportPage(html: string, pageUrl: string, reportDate?: string): NrcEventReport[] {
  const text = nrcHtmlToText(html);
  const lines = text.split('\n');
  const pageDate = reportDate
    ?? normalizeNrcDate(text.match(/Event Notification Report for\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/i)?.[1]);

  const starts: Array<{ line: number; number: string; category: string }> = [];
  lines.forEach((line, idx) => {
    const m = line.match(EVENT_NUMBER_RE);
    if (!m) return;
    let category = line.slice(0, m.index).replace(/\t/g, ' ').trim();
    if (!category) {
      for (let back = idx - 1; back >= 0 && back >= idx - 3; back--) {
        const prev = lines[back]!.replace(/\t/g, ' ').trim();
        if (prev) { category = prev; break; }
      }
    }
    // Index lists at the top of the page ("Power Reactor Event Number: 57123")
    // repeat the header without a grid; the later, full copy wins in the merge.
    starts.push({ line: idx, number: m[1]!, category: category.slice(0, 60) });
  });

  const byNumber = new Map<string, NrcEventReport>();
  starts.forEach((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1]!.line : lines.length;
    const block = lines.slice(start.line + 1, end);
    const remainder = lines[start.line]!.slice((lines[start.line]!.match(EVENT_NUMBER_RE)!.index ?? 0)).replace(EVENT_NUMBER_RE, '');
    if (remainder.trim()) block.unshift(remainder);
    const event = parseEventBlock(block, start.category, start.number, pageUrl, pageDate);
    const prior = byNumber.get(start.number);
    if (!prior || completeness(event) > completeness(prior)) byNumber.set(start.number, event);
  });
  return [...byNumber.values()];
}

function completeness(e: NrcEventReport): number {
  return (e.facility ? 4 : 0) + (e.notificationDate ? 2 : 0) + (e.narrative ? 2 : 0) + e.cfrSections.length + (e.emergencyClass !== 'unknown' ? 1 : 0);
}

/**
 * Merge events seen across several daily pages. The copy from the newest
 * report wins (it carries any update text); an event listed on more than one
 * day is flagged as updated, and a retraction anywhere sticks.
 */
export function mergeNrcEventReports(events: NrcEventReport[]): NrcEventReport[] {
  const groups = new Map<string, NrcEventReport[]>();
  for (const e of events) {
    const list = groups.get(e.eventNumber) ?? [];
    list.push(e);
    groups.set(e.eventNumber, list);
  }
  const merged: NrcEventReport[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => (b.reportDate ?? '').localeCompare(a.reportDate ?? '') || completeness(b) - completeness(a));
    const latest = list[0]!;
    const reportDays = new Set(list.map((e) => e.reportDate ?? ''));
    // Update copies sometimes drop the unit table or CFR list; keep the
    // fullest earlier copy of those rather than losing them.
    const withUnits = list.find((e) => e.unitStatus.length > 0);
    const withCfr = list.find((e) => e.cfrSections.length > 0);
    merged.push({
      ...latest,
      unitStatus: latest.unitStatus.length ? latest.unitStatus : withUnits?.unitStatus ?? [],
      cfrSections: latest.cfrSections.length ? latest.cfrSections : withCfr?.cfrSections ?? [],
      retracted: list.some((e) => e.retracted),
      updated: latest.updated || reportDays.size > 1,
    });
  }
  return merged.sort(compareNrcEvents);
}

/** Newest notification first, then severity, then event number. */
export function compareNrcEvents(a: NrcEventReport, b: NrcEventReport): number {
  return (b.notificationDate ?? b.reportDate ?? '').localeCompare(a.notificationDate ?? a.reportDate ?? '')
    || NRC_EMERGENCY_CLASS_RANK[b.emergencyClass] - NRC_EMERGENCY_CLASS_RANK[a.emergencyClass]
    || Number(b.eventNumber) - Number(a.eventNumber);
}

/** Cheap sanity check that a fetched page is an ENR page and not an error shell. */
export function looksLikeNrcEventReportPage(html: string): boolean {
  const text = String(html || '').slice(0, 200_000);
  return /Event Notification Report/i.test(text) || EVENT_NUMBER_RE.test(text);
}
