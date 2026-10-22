import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodeHtmlEntities,
  dedupePart21Reports,
  dedupePreliminaryNotifications,
  looksLikeNrcPart21Page,
  looksLikeNrcPreliminaryNotificationPage,
  nrcPart21YearUrl,
  nrcPreliminaryNotificationYearUrl,
  parseNrcPart21Page,
  parseNrcPreliminaryNotificationPage,
  parseUsDate,
  sortPart21Reports,
  sortPreliminaryNotifications,
} from '../shared/nrc-safety-reports.ts';

// Trimmed from the live 2026 Part 21 page (October 2026): the CMS leaves a
// stray link in the header cell and &nbsp; padding in date and description
// cells, and some rows cite an event number instead of an accession number.
const PART21_HTML = `<!doctype html><html><head><title>Part 21 Reports: 2026 | Nuclear Regulatory Commission</title></head><body>
<main>
<h1>Part 21 Reports: 2026</h1>
<table> <thead> <tr> <th>Log No.</th> <th>Notifier</th> <th>Description<a href="/docs/ML2628/ML26280A065.pdf">/docs/ML2628/ML26280A065.pdf</a></th> <th>Report Date</th> <th>Event No. / Accession No.</th> </tr> </thead> <tbody>
<tr> <td><a href="/docs/ML2628/ML26280A065.pdf">2026-23-00</a></td> <td>ABB Inc.</td> <td>Notification of defect/deviation pursuant to 10 CFR 21.21(d)(4) regarding a defect in Trip Latch Assembly 196951K01</td> <td>10/06/2026</td> <td><a href="/docs/ML2628/ML26280A065.pdf">ML26280A065</a></td> </tr>
<tr> <td><a href="/docs/ML2626/ML26261A125.pdf">2026-20-00</a></td> <td>DC Cook Nuclear Plant</td> <td>Initial Report Notification Pursuant to 10 CFR Part 21.21 (d)(3)(i) Associated with C&amp;D Technologies Inc., Battery: Model LCR-33 NUC, Manufacturing Date: February 2016&nbsp;</td> <td>09/17/2026</td> <td><a href="/docs/ML2626/ML26261A125.pdf">ML26261A125</a></td> </tr>
<tr> <td><a href="/docs/ML2625/ML26259A395.pdf">2026-18-01</a></td> <td>Westinghouse Electric Company LLC</td> <td>Updated Notification of the Potential Existence of Defects Pursuant to 10 CFR Part 21 Associated with DS and DHP Breaker Motor Cutoff Switches</td> <td>09/16/2026&nbsp;</td> <td><a href="/docs/ML2625/ML26259A395.pdf">ML26259A395</a></td> </tr>
<tr> <td>2026-18-00</td> <td>Westinghouse Electric Company LLC</td> <td>Notification of the Potential Existence of Defects Pursuant to 10 CFR Part 21 Associated with DS and DHP Breaker Motor Cutoff Switches&nbsp;</td> <td>&nbsp;09/02/2026&nbsp;</td> <td>EN 57892</td> </tr>
<tr> <td colspan="5"><p>&nbsp;</p></td> </tr>
</tbody> </table>
</main></body></html>`;

const PN_HTML = `<!doctype html><html><head><title>Preliminary Notification (PN) Reports for 2025 | Nuclear Regulatory Commission</title></head><body>
<main>
<h1>Preliminary Notification (PN) Reports for 2025</h1>
<table summary="Layout Table for 2025 Preliminary Notices"> <tbody>
<tr id="may"> <th colspan="3" scope="col">May</th> </tr>
<tr> <td scope="row"><a href="/docs/ML2514/ML25143A124.pdf">PNO-III-2025-001</a></td> <td>05/23/2025</td> <td>Quad Cities Nuclear Power Station Declaration of an Unusual Event Following a Fire on the Unit 2, 125v Dc Battery</td> </tr>
<tr> <td colspan="3" scope="row"><p></p></td> </tr>
<tr id="jan"> <th colspan="3" scope="col">January</th> </tr>
<tr> <td scope="row"><a href="https://www.nrc.gov/docs/ML2501/ML25010A001.pdf">PNO-HQ-2025-001</a></td> <td>01/09/2025</td> <td>Lost Industrial Radiography Source &amp; Recovery</td> </tr>
</tbody> </table>
</main></body></html>`;

describe('NRC Part 21 report parser', () => {
  it('recognises the yearly page and parses every report row', () => {
    assert.ok(looksLikeNrcPart21Page(PART21_HTML));
    assert.ok(!looksLikeNrcPart21Page('<html><title>Page not found</title></html>'));

    const reports = parseNrcPart21Page(PART21_HTML, 2026);
    assert.equal(reports.length, 4);
    assert.deepEqual(reports[0], {
      logNumber: '2026-23-00',
      notifier: 'ABB Inc.',
      description: 'Notification of defect/deviation pursuant to 10 CFR 21.21(d)(4) regarding a defect in Trip Latch Assembly 196951K01',
      reportDate: '2026-10-06',
      accession: 'ML26280A065',
      url: 'https://www.nrc.gov/docs/ML2628/ML26280A065.pdf',
      year: 2026,
    });
  });

  it('decodes entities and strips the &nbsp; padding the CMS leaves in cells', () => {
    const reports = parseNrcPart21Page(PART21_HTML, 2026);
    const cook = reports.find((r) => r.logNumber === '2026-20-00');
    assert.ok(cook);
    assert.equal(cook.notifier, 'DC Cook Nuclear Plant');
    assert.match(cook.description, /C&D Technologies Inc\., Battery/);
    assert.ok(!cook.description.endsWith(' '));
    const padded = reports.find((r) => r.logNumber === '2026-18-01');
    assert.equal(padded?.reportDate, '2026-09-16');
  });

  it('keeps rows that cite an event number instead of an accession and links from the log cell when present', () => {
    const reports = parseNrcPart21Page(PART21_HTML, 2026);
    const en = reports.find((r) => r.logNumber === '2026-18-00');
    assert.ok(en);
    assert.equal(en.reportDate, '2026-09-02');
    assert.equal(en.accession, undefined);
    assert.equal(en.eventNumber, '57892');
    assert.equal(en.url, undefined);
  });

  it('sorts newest first and drops duplicates across year pages', () => {
    const a = parseNrcPart21Page(PART21_HTML, 2026);
    const merged = dedupePart21Reports([...a, ...a]);
    assert.equal(merged.length, 4);
    const sorted = sortPart21Reports([...merged].reverse());
    assert.deepEqual(sorted.map((r) => r.logNumber), ['2026-23-00', '2026-20-00', '2026-18-01', '2026-18-00']);
  });
});

describe('NRC Preliminary Notification parser', () => {
  it('recognises the yearly page and skips month header rows', () => {
    assert.ok(looksLikeNrcPreliminaryNotificationPage(PN_HTML));
    const pns = parseNrcPreliminaryNotificationPage(PN_HTML, 2025);
    assert.equal(pns.length, 2);
    assert.deepEqual(pns[0], {
      number: 'PNO-III-2025-001',
      region: 'III',
      date: '2025-05-23',
      description: 'Quad Cities Nuclear Power Station Declaration of an Unusual Event Following a Fire on the Unit 2, 125v Dc Battery',
      url: 'https://www.nrc.gov/docs/ML2514/ML25143A124.pdf',
      year: 2025,
    });
    assert.equal(pns[1].region, 'HQ');
    assert.equal(pns[1].url, 'https://www.nrc.gov/docs/ML2501/ML25010A001.pdf');
    assert.equal(pns[1].description, 'Lost Industrial Radiography Source & Recovery');
  });

  it('sorts newest first and dedupes by number', () => {
    const pns = parseNrcPreliminaryNotificationPage(PN_HTML, 2025);
    const sorted = sortPreliminaryNotifications(dedupePreliminaryNotifications([...pns, ...pns].reverse()));
    assert.deepEqual(sorted.map((p) => p.number), ['PNO-III-2025-001', 'PNO-HQ-2025-001']);
  });
});

describe('NRC safety report helpers', () => {
  it('builds the yearly page URLs the NRC serves without a redirect', () => {
    assert.equal(nrcPart21YearUrl(2026), 'https://www.nrc.gov/regulations-legislation/reports-associated-with-events/part-21-reports/2026');
    assert.equal(nrcPreliminaryNotificationYearUrl(2025), 'https://www.nrc.gov/regulations-legislation/reports-associated-with-events/preliminary-notification-reports/2025');
  });

  it('parses US dates and rejects nonsense', () => {
    assert.equal(parseUsDate(' 09/02/2026 '), '2026-09-02');
    assert.equal(parseUsDate('13/40/2026'), undefined);
    assert.equal(parseUsDate('2026-09-02'), undefined);
  });

  it('decodes named, decimal and hex entities', () => {
    assert.equal(decodeHtmlEntities('A&amp;B &#167; 21 &#x2013; x&nbsp;y &unknown;'), 'A&B § 21 – x y &unknown;');
  });
});
