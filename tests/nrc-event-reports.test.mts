import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import {
  compareNrcEvents,
  looksLikeNrcEventReportPage,
  mergeNrcEventReports,
  normalizeNrcCategory,
  normalizeNrcDate,
  normalizeNrcEmergencyClass,
  nrcEventReportPageUrl,
  nrcHtmlToText,
  parseNrcEventReportPage,
  NRC_EVENT_NARRATIVE_MAX_CHARS,
} from '../shared/nrc-event-reports.ts';
import { collectNrcEventReports, parseDaysParam, reportWindow } from '../api/nrc-event-reports.ts';
import { enrichNrcEvents, facilitiesWithRecentEvents, matchEventFacility } from '../src/services/nrc-event-reports.ts';

// Hand-reconstructed pages (see tests/fixtures/nrc-event-reports/README.md):
// the layout follows the published ENR pages; the content is illustrative.
const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/nrc-event-reports/${name}`, import.meta.url), 'utf8');

const DAY1_URL = 'https://www.nrc.gov/reading-rm/doc-collections/event-status/event/2026/20261015en.html';
const DAY2_URL = 'https://www.nrc.gov/reading-rm/doc-collections/event-status/event/2026/20261016en.html';

describe('nrc event report parser', () => {
  const day1 = parseNrcEventReportPage(fixture('20261015en.html'), DAY1_URL);
  const byNumber = new Map(day1.map((e) => [e.eventNumber, e]));

  it('finds every event once, ignoring the index list and script text', () => {
    assert.deepEqual(day1.map((e) => e.eventNumber).sort(), ['57101', '57102', '57103']);
    assert.equal(byNumber.has('99999'), false);
  });

  it('reads the power-reactor grid by label', () => {
    const e = byNumber.get('57101')!;
    assert.equal(e.category, 'power-reactor');
    assert.equal(e.facility, 'VOGTLE');
    assert.equal(e.region, 2);
    assert.equal(e.state, 'GA');
    assert.equal(e.notificationDate, '2026-10-15');
    assert.equal(e.notificationTime, '03:41 [ET]');
    assert.equal(e.eventDate, '2026-10-15');
    assert.equal(e.emergencyClass, 'non-emergency');
    assert.equal(e.reportDate, '2026-10-15');
    assert.equal(e.sourceUrl, `${DAY1_URL}#en57101`);
    assert.deepEqual(e.cfrSections, [
      { code: '50.72(b)(2)(iv)(B)', description: 'RPS Actuation - Critical' },
      { code: '50.72(b)(3)(iv)(A)', description: 'Valid Specif Sys Actuation' },
    ]);
  });

  it('parses multi-unit events and the unit status table', () => {
    const e = byNumber.get('57101')!;
    assert.deepEqual(e.units, ['3', '4']);
    assert.equal(e.unitStatus.length, 2);
    assert.deepEqual(e.unitStatus[1], {
      unit: '4',
      scramCode: 'A/R',
      reactorCritical: true,
      initialPower: 98,
      initialMode: 'Power Operation',
      currentPower: 0,
      currentMode: 'Hot Standby',
    });
  });

  it('separates the title from the narrative and decodes entities', () => {
    const e = byNumber.get('57101')!;
    assert.equal(e.title, 'AUTOMATIC REACTOR TRIPS ON BOTH UNITS DUE TO LOSS OF A SWITCHYARD BUS');
    assert.match(e.narrative, /^The following information was provided by the licensee/);
    assert.match(e.narrative, /steam dumps & condenser/);
    assert.match(e.narrative, /\n\n/);
    assert.equal(e.narrative.includes('<'), false);
  });

  it('reads Agreement State events by licensee and reporting organisation', () => {
    const e = byNumber.get('57102')!;
    assert.equal(e.category, 'agreement-state');
    assert.equal(e.facility, 'Example Industrial Radiography LLC');
    assert.equal(e.reportingOrg, 'TEXAS DEPT OF STATE HEALTH SERVICES');
    assert.equal(e.city, 'Odessa');
    assert.equal(e.state, 'TX');
    assert.equal(e.region, 4);
    assert.deepEqual(e.units, []);
    assert.deepEqual(e.cfrSections, [{ code: 'Agreement State', description: '' }]);
  });

  it('classifies emergency declarations', () => {
    assert.equal(byNumber.get('57103')!.emergencyClass, 'unusual-event');
    assert.equal(normalizeNrcEmergencyClass('Notification of Unusual Event'), 'unusual-event');
    assert.equal(normalizeNrcEmergencyClass('Alert'), 'alert');
    assert.equal(normalizeNrcEmergencyClass('Site Area Emergency'), 'site-area-emergency');
    assert.equal(normalizeNrcEmergencyClass('General Emergency'), 'general-emergency');
    assert.equal(normalizeNrcEmergencyClass('Non Emergency'), 'non-emergency');
    assert.equal(normalizeNrcEmergencyClass(''), 'unknown');
  });

  it('flags updates and retractions, and strips the revision stamp', () => {
    const day2 = parseNrcEventReportPage(fixture('20261016en.html'), DAY2_URL);
    const update = day2.find((e) => e.eventNumber === '57103')!;
    assert.equal(update.updated, true);
    assert.equal(update.retracted, false);
    assert.match(update.narrative, /\* \* \* UPDATE ON 10\/15\/2026/);
    const retraction = day2.find((e) => e.eventNumber === '57090')!;
    assert.equal(retraction.category, 'non-power-reactor');
    assert.equal(retraction.retracted, true);
    assert.equal(retraction.region, undefined, 'region 0 (non-power reactors) is not an NRC region');
    assert.equal(retraction.title, 'RETRACTION - TECHNICAL SPECIFICATION VIOLATION');
    assert.equal(/EN Revision/i.test(retraction.narrative), false);
    const fuel = day2.find((e) => e.eventNumber === '57104')!;
    assert.equal(fuel.category, 'fuel-cycle');
    assert.deepEqual(fuel.cfrSections.map((c) => c.code), ['70.50(b)(1)', '70 App A (b)(1)']);
  });

  it('degrades a truncated page to the fields it has', () => {
    const events = parseNrcEventReportPage(fixture('malformed.html'), 'https://example.test/x.html');
    assert.equal(events.length, 1);
    const e = events[0]!;
    assert.equal(e.eventNumber, '57110');
    assert.equal(e.facility, 'DIABLO CANYON');
    assert.deepEqual(e.units, ['1']);
    assert.equal(e.emergencyClass, 'unknown');
    assert.equal(e.notificationDate, undefined);
    assert.equal(e.narrative, '');
    assert.equal(e.title, 'DIABLO CANYON event 57110');
    assert.equal(e.reportDate, '2026-10-17');
  });

  it('returns nothing for empty or unrelated pages', () => {
    assert.deepEqual(parseNrcEventReportPage('', 'u'), []);
    assert.deepEqual(parseNrcEventReportPage('<html><body><h1>Page not found</h1></body></html>', 'u'), []);
    assert.equal(looksLikeNrcEventReportPage('<h1>Page not found</h1>'), false);
    assert.equal(looksLikeNrcEventReportPage(fixture('20261015en.html')), true);
  });

  it('bounds very long narratives', () => {
    const long = `<table><tr><td>Power Reactor</td><td>Event Number: 57200</td></tr>
      <tr><td>Facility: HATCH<br>Region: 2 State: GA<br>Emergency Class: Non Emergency</td></tr></table>
      <table><tr><td>Event Text</td></tr><tr><td><b>LONG TITLE</b><br><br>${'Sentence of narrative. '.repeat(600)}</td></tr></table>`;
    const [e] = parseNrcEventReportPage(long, 'u', '2026-10-18');
    assert.ok(e!.narrative.length <= NRC_EVENT_NARRATIVE_MAX_CHARS + 2);
    assert.match(e!.narrative, /…$/);
  });
});

describe('nrc event report merge', () => {
  it('keeps the newest copy, marks it updated, and keeps the unit table', () => {
    const merged = mergeNrcEventReports([
      ...parseNrcEventReportPage(fixture('20261015en.html'), DAY1_URL),
      ...parseNrcEventReportPage(fixture('20261016en.html'), DAY2_URL),
    ]);
    assert.equal(merged.length, 5);
    const fire = merged.find((e) => e.eventNumber === '57103')!;
    assert.equal(fire.reportDate, '2026-10-16');
    assert.equal(fire.lastUpdateDate, '2026-10-16');
    assert.equal(fire.updated, true);
    assert.equal(fire.unitStatus.length, 1, 'unit table survives from the first copy');
    assert.equal(fire.sourceUrl, `${DAY2_URL}#en57103`);
    assert.equal(merged.find((e) => e.eventNumber === '57101')!.updated, false);
  });

  it('sorts newest notification first, then by severity', () => {
    const merged = mergeNrcEventReports([
      ...parseNrcEventReportPage(fixture('20261015en.html'), DAY1_URL),
      ...parseNrcEventReportPage(fixture('20261016en.html'), DAY2_URL),
    ]);
    assert.deepEqual(merged.map((e) => e.eventNumber), ['57104', '57103', '57101', '57102', '57090']);
    const sorted = [...merged].sort(compareNrcEvents);
    assert.deepEqual(sorted, merged);
  });
});

describe('nrc event report helpers', () => {
  it('normalises dates and categories', () => {
    assert.equal(normalizeNrcDate('10/5/2026'), '2026-10-05');
    assert.equal(normalizeNrcDate('October 16, 2026'), '2026-10-16');
    assert.equal(normalizeNrcDate('n/a'), undefined);
    assert.equal(normalizeNrcCategory('Power Reactor'), 'power-reactor');
    assert.equal(normalizeNrcCategory('Non-Power Reactor'), 'non-power-reactor');
    assert.equal(normalizeNrcCategory('Research Reactor'), 'non-power-reactor');
    assert.equal(normalizeNrcCategory('Fuel Cycle Facility'), 'fuel-cycle');
    assert.equal(normalizeNrcCategory('Hospital'), 'hospital');
    assert.equal(normalizeNrcCategory('Part 21'), 'part-21');
    assert.equal(normalizeNrcCategory('Other Nuclear Material'), 'materials');
    assert.equal(normalizeNrcCategory('Something new'), 'other');
  });

  it('builds daily page URLs', () => {
    assert.equal(nrcEventReportPageUrl(new Date(Date.UTC(2026, 0, 5))), 'https://www.nrc.gov/reading-rm/doc-collections/event-status/event/2026/20260105en.html');
  });

  it('keeps table structure in the text rendering', () => {
    assert.equal(nrcHtmlToText('<tr><td>a</td><td>b&amp;c</td></tr>'), 'a\tb&c\t\n');
  });
});

describe('nrc event report endpoint', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('clamps the days parameter', () => {
    assert.equal(parseDaysParam(null), 14);
    assert.equal(parseDaysParam('0'), 14);
    assert.equal(parseDaysParam('7'), 7);
    assert.equal(parseDaysParam('400'), 30);
  });

  it('walks back from the Eastern-time date', () => {
    // 03:00 UTC on Oct 17 is still Oct 16 in US Eastern time.
    const days = reportWindow(new Date(Date.UTC(2026, 9, 17, 3)), 3).map((d) => d.toISOString().slice(0, 10));
    assert.deepEqual(days, ['2026-10-16', '2026-10-15', '2026-10-14']);
  });

  it('merges pages, tolerates missing days and reports failures', async () => {
    const pages: Record<string, string> = {
      '20261016en.html': fixture('20261016en.html'),
      '20261015en.html': fixture('20261015en.html'),
    };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      const name = url.slice(url.lastIndexOf('/') + 1);
      if (name === '20261013en.html') return new Response('boom', { status: 503 });
      if (name === '20261012en.html') return new Response('<h1>Page Not Found</h1>', { status: 200 });
      const body = pages[name];
      return body ? new Response(body, { status: 200 }) : new Response('nf', { status: 404 });
    }) as typeof fetch;

    const payload = await collectNrcEventReports(new Date(Date.UTC(2026, 9, 16, 18)), 5);
    assert.deepEqual(payload.days.map((d) => `${d.date}:${d.status}`), [
      '2026-10-16:ok', '2026-10-15:ok', '2026-10-14:missing', '2026-10-13:error', '2026-10-12:missing',
    ]);
    assert.equal(payload.events.length, 5);
    assert.equal(payload.events.find((e) => e.eventNumber === '57103')!.updated, true);
  });
});

describe('nrc event registry linking', () => {
  it('links reactor events by plant name and licensee events by same-state name', () => {
    const merged = mergeNrcEventReports([
      ...parseNrcEventReportPage(fixture('20261015en.html'), DAY1_URL),
      ...parseNrcEventReportPage(fixture('20261016en.html'), DAY2_URL),
    ]);
    const enriched = new Map(enrichNrcEvents(merged).map((e) => [e.eventNumber, e]));
    assert.equal(enriched.get('57101')!.facilityMatch?.id, 'vogtle');
    assert.equal(enriched.get('57103')!.facilityMatch?.id, 'browns-ferry');
    // Agreement State licensees are never linked to registry sites.
    assert.equal(enriched.get('57102')!.facilityMatch, undefined);
    // Illustrative licensee names must not borrow a real site on generic words.
    assert.equal(enriched.get('57104')!.facilityMatch, undefined);
    assert.equal(enriched.get('57090')!.facilityMatch, undefined);
  });

  it('matches real licensee names without crossing state lines', () => {
    const ev = (facility: string, state: string, category: 'fuel-cycle' | 'non-power-reactor' | 'power-reactor') =>
      ({ facility, state, category }) as Parameters<typeof matchEventFacility>[0];
    assert.equal(matchEventFacility(ev('OREGON STATE UNIVERSITY', 'OR', 'non-power-reactor'))?.id, 'oregon-state-triga');
    assert.equal(matchEventFacility(ev('NUCLEAR FUEL SERVICES', 'TN', 'fuel-cycle'))?.id, 'nfs-erwin');
    assert.equal(matchEventFacility(ev('WESTINGHOUSE ELECTRIC COMPANY', 'SC', 'fuel-cycle'))?.id, 'westinghouse-columbia');
    assert.equal(matchEventFacility(ev('BROWNS FERRY', 'TN', 'power-reactor')), undefined);
  });

  it('lists sites with non-retracted events in the window', () => {
    const merged = enrichNrcEvents(mergeNrcEventReports(parseNrcEventReportPage(fixture('20261015en.html'), DAY1_URL)));
    const ids = facilitiesWithRecentEvents(merged, new Date(Date.UTC(2026, 9, 16, 12)), 72);
    assert.deepEqual([...ids].sort(), ['browns-ferry', 'vogtle']);
    assert.equal(facilitiesWithRecentEvents(merged, new Date(Date.UTC(2026, 9, 30)), 72).size, 0);
  });
});
