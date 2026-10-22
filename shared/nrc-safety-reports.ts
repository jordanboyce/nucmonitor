// NRC Part 21 reports and Preliminary Notifications.
//
// Two more "reports associated with events" collections the NRC publishes as
// yearly HTML tables rather than feeds:
//
//   Part 21 reports — defect and noncompliance notifications vendors and
//   licensees file under 10 CFR Part 21 (a breaker model, a relay, a battery
//   lot). One row per report: log number, notifier, description, report date
//   and the ADAMS accession number of the letter.
//     https://www.nrc.gov/regulations-legislation/reports-associated-with-events/part-21-reports/YYYY
//
//   Preliminary Notifications (PNs) — the NRC regional offices' own early
//   notices of significant events (emergency declarations, significant
//   enforcement, media-interest events). One row per PN: number
//   (PNO-<region>-<year>-<seq>), date and a one-line description, grouped by
//   month under header rows.
//     https://www.nrc.gov/regulations-legislation/reports-associated-with-events/preliminary-notification-reports/YYYY
//
// Both parsers work on the raw HTML with no DOM so the edge function, the
// browser and node tests share them. They key on table row and cell order
// (the only structure the pages have) and tolerate the &nbsp; padding and
// stray links the NRC's CMS leaves in cells.

export const NRC_PART21_INDEX = 'https://www.nrc.gov/documents-reports/document-collections/events-reports-associated-with/event-notification-reports/part-21-reports';
export const NRC_PRELIMINARY_NOTIFICATIONS_INDEX = 'https://www.nrc.gov/documents-reports/document-collections/events-reports-associated-with/event-notification-reports/preliminary-notification-reports';
const NRC_ORIGIN = 'https://www.nrc.gov';

export function nrcPart21YearUrl(year: number): string {
  return `https://www.nrc.gov/regulations-legislation/reports-associated-with-events/part-21-reports/${year}`;
}

export function nrcPreliminaryNotificationYearUrl(year: number): string {
  return `https://www.nrc.gov/regulations-legislation/reports-associated-with-events/preliminary-notification-reports/${year}`;
}

export interface NrcPart21Report {
  /** NRC log number, e.g. "2026-23-00"; the last pair increments for revisions. */
  logNumber: string;
  notifier: string;
  description: string;
  /** ISO date (YYYY-MM-DD) when parseable. */
  reportDate?: string;
  /** ADAMS accession number of the notification letter, e.g. "ML26280A065". */
  accession?: string;
  /** NRC event notification number when the row cites one instead of (or as well as) an accession. */
  eventNumber?: string;
  /** Absolute link to the letter (ADAMS document) when the row carries one. */
  url?: string;
  year: number;
}

export interface NrcPreliminaryNotification {
  /** e.g. "PNO-III-2025-001". */
  number: string;
  /** Region token from the number: "I".."IV" or "HQ". */
  region?: string;
  /** ISO date (YYYY-MM-DD) when parseable. */
  date?: string;
  description: string;
  url?: string;
  year: number;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', sect: '§',
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1]?.toLowerCase() === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

function cellText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function firstHref(html: string): string | undefined {
  const m = html.match(/href\s*=\s*["']([^"']+)["']/i);
  if (!m) return undefined;
  const href = decodeHtmlEntities(m[1] ?? '').trim();
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('/')) return NRC_ORIGIN + href;
  return undefined;
}

/** "10/06/2026" (or with stray spaces) → "2026-10-06"; anything else → undefined. */
export function parseUsDate(text: string): string | undefined {
  const m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return undefined;
  const [, monthText = '', dayText = '', year = ''] = m;
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function tableRows(html: string): string[][] {
  const rows: string[][] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(html)) !== null) {
    const cells: string[] = [];
    const cellRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cell: RegExpExecArray | null;
    while ((cell = cellRe.exec(row[1] ?? '')) !== null) cells.push(cell[1] ?? '');
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function mainHtml(html: string): string {
  const m = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  return m?.[1] ?? html;
}

export function looksLikeNrcPart21Page(html: string): boolean {
  return /Part 21 Reports/i.test(html) && /<table\b/i.test(html) && /Log No/i.test(html);
}

export function looksLikeNrcPreliminaryNotificationPage(html: string): boolean {
  return /Preliminary Notification/i.test(html) && /<table\b/i.test(html);
}

export function parseNrcPart21Page(html: string, year: number): NrcPart21Report[] {
  const out: NrcPart21Report[] = [];
  for (const cells of tableRows(mainHtml(html))) {
    if (cells.length < 4) continue;
    const [logCell = '', notifierCell = '', descriptionCell = '', dateCell = '', refCell = ''] = cells;
    const logNumber = cellText(logCell);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(logNumber)) continue;
    const notifier = cellText(notifierCell);
    const description = cellText(descriptionCell);
    const reportDate = parseUsDate(cellText(dateCell));
    const refText = cellText(refCell);
    // ADAMS accession numbers: "ML" + 2-digit year + 3-digit day-of-year + 4 more characters (e.g. ML26280A065, ML040990170).
    const accession = refText.match(/\bML\d{5}[0-9A-Z]{4}\b/)?.[0];
    const eventNumber = refText.replace(accession ?? '', '').match(/\b\d{5}\b/)?.[0];
    const url = firstHref(refCell) ?? firstHref(logCell);
    if (!notifier && !description) continue;
    out.push({
      logNumber,
      notifier,
      description,
      ...(reportDate ? { reportDate } : {}),
      ...(accession ? { accession } : {}),
      ...(eventNumber ? { eventNumber } : {}),
      ...(url ? { url } : {}),
      year,
    });
  }
  return out;
}

export function parseNrcPreliminaryNotificationPage(html: string, year: number): NrcPreliminaryNotification[] {
  const out: NrcPreliminaryNotification[] = [];
  for (const cells of tableRows(mainHtml(html))) {
    if (cells.length < 3) continue;
    const [numberCell = '', dateCell = '', descriptionCell = ''] = cells;
    const number = cellText(numberCell);
    const m = number.match(/^PNO-([A-Z]+)-(\d{4})-(\d+)/i);
    if (!m) continue;
    const date = parseUsDate(cellText(dateCell));
    const description = cellText(descriptionCell);
    const url = firstHref(numberCell);
    out.push({
      number,
      region: (m[1] ?? '').toUpperCase(),
      ...(date ? { date } : {}),
      description,
      ...(url ? { url } : {}),
      year,
    });
  }
  return out;
}

function compareDesc(a: string | undefined, b: string | undefined): number {
  return (b ?? '').localeCompare(a ?? '');
}

/** Newest first: by report date, then by log number (which embeds the year and sequence). */
export function sortPart21Reports(reports: NrcPart21Report[]): NrcPart21Report[] {
  return [...reports].sort((a, b) => compareDesc(a.reportDate, b.reportDate) || compareDesc(a.logNumber, b.logNumber));
}

export function sortPreliminaryNotifications(items: NrcPreliminaryNotification[]): NrcPreliminaryNotification[] {
  return [...items].sort((a, b) => compareDesc(a.date, b.date) || compareDesc(a.number, b.number));
}

/** Drop duplicate rows (the same report listed on two year pages, or twice on one). */
export function dedupePart21Reports(reports: NrcPart21Report[]): NrcPart21Report[] {
  const seen = new Set<string>();
  return reports.filter((r) => {
    const key = `${r.logNumber}|${r.accession ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function dedupePreliminaryNotifications(items: NrcPreliminaryNotification[]): NrcPreliminaryNotification[] {
  const seen = new Set<string>();
  return items.filter((p) => {
    if (seen.has(p.number)) return false;
    seen.add(p.number);
    return true;
  });
}
