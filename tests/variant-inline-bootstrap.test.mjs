import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');
const vercelConfig = JSON.parse(readFileSync(resolve(__dirname, '../vercel.json'), 'utf-8'));
const csp = vercelConfig.headers
  .find((entry) => entry.headers?.some(
    (header) => header.key === 'X-Frame-Options' && header.value === 'SAMEORIGIN',
  ))
  ?.headers
  ?.find((header) => header.key === 'Content-Security-Policy')
  ?.value ?? '';
const variantBootstrapScript = indexHtml.match(/<script data-wm-prepaint>([\s\S]*?)<\/script>/)?.[1];

describe('variant inline bootstrap', () => {
  it('detects the nuclear hub hosts before the app bundle loads', () => {
    // NucMonitor answers on nuclear.<domain> and on any nucmonitor-branded
    // host (nucmonitor.app, nucmonitor.vercel.app) — mirrors src/config/variant.ts.
    assert.ok(
      indexHtml.includes("if(h.startsWith('nuclear.')||h.indexOf('nucmonitor')!==-1)v='nuclear'"),
      'index.html inline bootstrap must set data-variant=nuclear for nuclear.* and nucmonitor hosts',
    );
    for (const gone of ['happy', 'tech', 'finance', 'commodity', 'energy']) {
      assert.ok(
        !indexHtml.includes(`h.startsWith('${gone}.')`),
        `index.html inline bootstrap must no longer detect the removed ${gone}.worldmonitor.app host`,
      );
    }
  });

  it('allows the inline variant bootstrap through the CSP', () => {
    assert.ok(variantBootstrapScript, 'index.html must include the inline variant bootstrap script');
    assert.ok(
      variantBootstrapScript.includes('worldmonitor-variant') && variantBootstrapScript.includes('document.documentElement.dataset.variant'),
      'the marked pre-paint script must retain variant bootstrapping',
    );

    const hash = createHash('sha256').update(variantBootstrapScript).digest('base64');
    assert.ok(
      csp.includes(`'sha256-${hash}'`),
      `Vercel Content-Security-Policy must include sha256-${hash} for the inline variant bootstrap script`,
    );
  });
});
