import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeSrc = readFileSync(resolve(__dirname, '../src/services/runtime.ts'), 'utf-8');
// #5911 split the desktop detector (and its VITE_DESKTOP_RUNTIME read) into a
// dependency-free leaf, and #5912 moved that leaf to src/config/ so config
// modules can import it (src/services/desktop-runtime.ts only re-exports it).
// The allow-list invariant follows the implementation: both halves are
// asserted, so the split cannot be used to smuggle in a whole-env snapshot.
const desktopRuntimeSrc = readFileSync(resolve(__dirname, '../src/config/desktop-runtime.ts'), 'utf-8');
const variantSrc = readFileSync(resolve(__dirname, '../src/config/variant.ts'), 'utf-8');

describe('runtime env guards', () => {
  it('reads only explicit import.meta.env properties through a guarded ENV wrapper', () => {
    assert.doesNotMatch(
      runtimeSrc,
      /return\s+import\.meta\.env\b/,
      'runtime.ts must not return the whole Vite env object to client code',
    );
    assert.doesNotMatch(
      runtimeSrc,
      /\b(?:const|let|var)\s+\w+\s*=\s*import\.meta\.env\b/,
      'runtime.ts must not snapshot import.meta.env into a local object',
    );
    for (const key of [
      'VITE_TAURI_API_BASE_URL',
      'VITE_TAURI_REMOTE_API_BASE_URL',
      'VITE_WS_API_URL',
      'VITE_WS_RELAY_URL',
    ]) {
      assert.ok(
        runtimeSrc.includes(`${key}: import.meta.env.${key}`),
        `runtime ENV wrapper must explicitly allow ${key}`,
      );
    }
  });

  it('holds the same allow-list discipline in the extracted desktop-runtime leaf', () => {
    assert.doesNotMatch(
      desktopRuntimeSrc,
      /return\s+import\.meta\.env\b/,
      'desktop-runtime.ts must not return the whole Vite env object to client code',
    );
    assert.doesNotMatch(
      desktopRuntimeSrc,
      /\b(?:const|let|var)\s+\w+\s*=\s*import\.meta\.env\b/,
      'desktop-runtime.ts must not snapshot import.meta.env into a local object',
    );
    assert.ok(
      desktopRuntimeSrc.includes('VITE_DESKTOP_RUNTIME: import.meta.env.VITE_DESKTOP_RUNTIME'),
      'desktop-runtime ENV wrapper must explicitly allow VITE_DESKTOP_RUNTIME',
    );
    assert.ok(
      desktopRuntimeSrc.includes("const FORCE_DESKTOP_RUNTIME = ENV.VITE_DESKTOP_RUNTIME === '1'"),
      'Desktop runtime flag should read from the guarded ENV wrapper',
    );
    // One owner for the flag: a second reader in runtime.ts would let the two
    // disagree about what "desktop" means.
    assert.doesNotMatch(
      runtimeSrc,
      /VITE_DESKTOP_RUNTIME/,
      'runtime.ts must source the desktop flag from desktop-runtime.ts, not re-read it',
    );
  });

  it('runtime-config.ts does not dynamically read the Vite env object for secrets', () => {
    const runtimeConfigSrc = readFileSync(resolve(__dirname, '../src/services/runtime-config.ts'), 'utf-8');
    assert.doesNotMatch(
      runtimeConfigSrc,
      /\.env\?\.\[[^\]]+\]/,
      'runtime-config.ts must not dynamically index import.meta.env for runtime secrets',
    );
  });

  it('reuses the guarded ENV wrapper for runtime env lookups', () => {
    assert.ok(runtimeSrc.includes('const WS_API_URL = ENV.VITE_WS_API_URL || \'\''), 'WS API URL should read from ENV');
    assert.ok(runtimeSrc.includes('const configuredBaseUrl = ENV.VITE_TAURI_API_BASE_URL;'), 'Tauri API base should read from ENV');
    assert.ok(runtimeSrc.includes('const configuredRemoteBase = ENV.VITE_TAURI_REMOTE_API_BASE_URL;'), 'Remote API base should read from ENV');
    assert.ok(runtimeSrc.includes('...extractHostnames(WS_API_URL, ENV.VITE_WS_RELAY_URL)'), 'Relay host extraction should read from ENV');
  });
});

describe('variant env guards', () => {
  // NucMonitor ships one dashboard: SITE_VARIANT is a constant, so variant.ts no
  // longer resolves a build variant from import.meta.env or location fallbacks.
  // The guard that survives is that it never touches import.meta.env at all,
  // which keeps it importable from node test runners and SSR.
  it('pins the single nuclear variant without reading import.meta.env', () => {
    assert.match(variantSrc, /export const SITE_VARIANT: SiteVariant = 'nuclear';/);
    assert.doesNotMatch(variantSrc, /import\.meta\.env/);
  });
});
