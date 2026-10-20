// Static guard: every bundle-driven seeder's canonical-key TTL must be
// AT LEAST 3× its bundle's `intervalMs` (the gold-standard from
// api/health.js:268-281 and memory `seed-meta-populated-canonical-missing-
// ttl-cron-match`).
//
// Why: when canonical TTL ≈ cron interval, ANY drift (cron queue delay,
// LLM-call slowness, bundle ordering) leaves the canonical key TTL'd-out
// for a window before the next successful run rewrites it. seed-meta has
// a much longer TTL so it survives showing rc>0; /api/health then reports
// `EMPTY records=0` while the meta says everything's fresh — the operator
// sees no diagnostic trail.
//
// The trap has bitten WM at least 3 times so far:
//   - PR #3610 (bisPolicy/bisExchange/bisCredit, 12h TTL == 12h cron)
//   - PR #3622 (marketImplications, 75min TTL vs 60min cron — 1.25×)
//   - PR #3622 (iranEvents, 2d TTL vs 14d operator-cadence — 0.28×)
//
// This test catches new instances on every contribution rather than after
// the first production failure.
//
// ## Known violations (allowlisted)
//
// At test-creation time, scanning all `scripts/seed-bundle-*.mjs` surfaced
// ~30 sections currently below the 3× threshold. Each is listed below
// with its current ratio. The test fails if:
//
//   (a) A NEW section drops below the threshold (regression — must fix or
//       add to the allowlist with a comment justifying why)
//   (b) An ALLOWLISTED entry is no longer violating (resolved — remove
//       the entry, otherwise the allowlist drifts)
//
// As future PRs bump TTLs, contributors should remove the corresponding
// allowlist entry. Goal: empty allowlist.
//
// ## Scope
//
//   INCLUDES: every section across `scripts/seed-bundle-*.mjs` where the
//   section has `script:` + `intervalMs:` AND the script uses
//   `runSeed(...)` with `ttlSeconds:`. That's the standard bundle+runSeed
//   shape.
//
//   EXCLUDES: non-bundle seeders (manually-triggered like seed-iran-
//   events.mjs OR external-cron like seed-forecasts.mjs's market-
//   implications). Those don't have a discoverable cron interval in code;
//   they were audited manually in PR #3622.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractBundleSections,
  listBundleFiles,
  resolveExpr,
} from './helpers/bundle-section-parser.mjs';

const __filename = fileURLToPath(import.meta.url);     // ESM: must declare explicitly (Greptile P1 on PR #3625)
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const SCRIPTS_DIR = join(ROOT, 'scripts');

const SAFETY_FACTOR = 3;     // canonical TTL must be ≥ this × cron interval

// Allowlist of bundle sections currently below threshold — keyed by
// `<bundle-label>:<script>` to allow precise removal. Format:
//   '<label>:<script>': '<short justification>'
//
// Each entry should be removed when its corresponding seeder is fixed.
// Adding a new entry requires a comment explaining why the violation is
// acceptable (or "TODO: fix in follow-up PR").
const KNOWN_VIOLATIONS = {
  // ── Climate ──
  'CO2-Monitoring:seed-co2-monitoring.mjs': '72h TTL vs 72h cron (1×) — needs bump to ≥216h',
  'Cross-Source-Signals:seed-cross-source-signals.mjs': '30min TTL vs 15min cron (2×) — borderline',
  'IEA-Oil-Stocks:seed-iea-oil-stocks.mjs': '40d TTL vs 40d cron (1×) — needs bump to ≥120d',

  // ── Macro / IMF / WB cohort ──
  'IMF-Macro:seed-imf-macro.mjs': '35d TTL vs 30d cron (1.17×)',
  'IMF-Growth:seed-imf-growth.mjs': '35d TTL vs 30d cron (1.17×)',
  'IMF-Labor:seed-imf-labor.mjs': '35d TTL vs 30d cron (1.17×)',
  'IMF-External:seed-imf-external.mjs': '35d TTL vs 30d cron (1.17×)',
  'National-Debt:seed-national-debt.mjs': '65d TTL vs 30d cron (2.17×) — close, could just bump to 90d',
  'WB-External-Debt:seed-wb-external-debt.mjs': '35d TTL vs 30d cron (1.17×)',

  // ── Recovery cohort (annual data, infrequent crons) ──
  'Fiscal-Space:seed-recovery-fiscal-space.mjs': '35d TTL vs 30d cron (1.17×)',
  'Reserve-Adequacy:seed-recovery-reserve-adequacy.mjs': '35d TTL vs 30d cron (1.17×)',
  'External-Debt:seed-recovery-external-debt.mjs': '35d TTL vs 30d cron (1.17×)',
  'Reexport-Share:seed-recovery-reexport-share.mjs': '35d TTL vs 30d cron (1.17×)',
  'Sovereign-Wealth:seed-sovereign-wealth.mjs': '35d TTL vs 30d cron (1.17×)',

  // ── Portwatch ──
  'PW-Disruptions:seed-portwatch-disruptions.mjs': '2h TTL vs 1h cron (2×) — borderline',
  'PW-Main:seed-portwatch.mjs': '12h TTL vs 6h cron (2×) — borderline',
  'PW-Chokepoints-Ref:seed-portwatch-chokepoints-ref.mjs': '7d TTL vs 7d cron (1×)',
  'Chokepoint-Baselines:seed-chokepoint-baselines.mjs': '400d TTL vs 400d cron (1×) — annual; canonical should outlive 3 cycles',

  // ── Other ──
  'USA-Spending:seed-usa-spending.mjs': '2h TTL vs 1h cron (2×) — borderline',
  'Displacement:seed-displacement-summary.mjs': '24h TTL vs 24h cron (1×)',
};

// The section parser and safe expression resolver live in
// tests/helpers/bundle-section-parser.mjs, shared with
// tests/bundle-budget-admission.test.mjs and covered by
// tests/bundle-section-parser.test.mjs.

function extractRunSeedTtl(seederSrc) {
  const m = seederSrc.match(/ttlSeconds:\s*([^,}\n]+)/);
  return m ? m[1].trim() : null;
}

// ── Tests ────────────────────────────────────────────────────────────────
