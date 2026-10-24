import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loader = readFileSync(resolve(__dirname, '../public/embed.js'), 'utf-8');

describe('embed.js partner loader', () => {
  for (const [layers, expected] of [[null, null], ['', ''], ['  ', ''], ['conflicts,weather', 'conflicts,weather']]) {
    it(`forwards the layer selection ${JSON.stringify(layers)} without changing its meaning`, () => {
      const attributes = { src: 'https://www.worldmonitor.app/embed.js', 'data-layers': layers };
      let frame;
      runInNewContext(loader, {
        URL,
        window: { location: { href: 'https://partner.example/' } },
        document: {
          currentScript: {
            getAttribute: (name) => attributes[name] ?? null,
            parentNode: { insertBefore: (iframe) => { frame = iframe; } },
          },
          createElement: () => ({ style: {}, setAttribute() {} }),
        },
      });
      assert.equal(new URL(frame.src).searchParams.get('layers'), expected);
    });
  }

  it('creates a keyless iframe and never forwards a credential', () => {
    assert.match(loader, /document\.currentScript/);
    assert.match(loader, /iframe\.src = url/);
    assert.match(loader, /\/embed\?panel=/);
    assert.equal(/postMessage/.test(loader), false);
    assert.equal(/getAttribute\('data-key'\)/.test(loader), false);
    assert.equal(/[?&]key=/.test(loader), false);
  });

  it('forwards the map view to the iframe URL so the loader is not stuck on defaults', () => {
    assert.match(loader, /\['layers', 'center', 'zoom', 'variant'\]/);
    assert.match(loader, /getAttribute\('data-' \+ name\)/);
    assert.match(loader, /encodeURIComponent\(value\)/);
    // The view attributes must be appended BEFORE src is assigned, or the
    // iframe loads the default view and then never reloads.
    const viewIdx = loader.indexOf("'layers', 'center', 'zoom', 'variant'");
    const srcIdx = loader.indexOf('iframe.src = url');
    assert.ok(viewIdx !== -1 && viewIdx < srcIdx, 'view params must be built before iframe.src');
  });
});
