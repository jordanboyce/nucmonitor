import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const MARKET_SERVICE_URL = pathToFileURL(resolve(root, 'src/services/market/index.ts')).href;
const CIRCUIT_BREAKER_URL = pathToFileURL(resolve(root, 'src/utils/circuit-breaker.ts')).href;

function freshImportUrl(url) {
  return `${url}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function overrideGlobal(name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
  };
}

function installBrowserEnv() {
  const location = {
    hostname: 'worldmonitor.app',
    protocol: 'https:',
    host: 'worldmonitor.app',
    origin: 'https://worldmonitor.app',
  };
  const navigator = { userAgent: 'node-test', onLine: true };
  const restoreWindow = overrideGlobal('window', { location, navigator });
  const restoreLocation = overrideGlobal('location', location);
  const restoreNavigator = overrideGlobal('navigator', navigator);
  return () => {
    restoreNavigator();
    restoreLocation();
    restoreWindow();
  };
}

function response(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  throw new Error('Timed out waiting for market request');
}

describe('physical market service freshness', () => {
});
