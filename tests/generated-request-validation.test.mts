import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { serverOptions } from '../server/gateway.ts';
import { validateGeneratedRequest } from '../server/request-validator.ts';
import { GENERATED_REQUEST_TYPES } from '../src/generated/server/request_validation.ts';
import {
  createMarketServiceRoutes,
  type MarketServiceHandler,
} from '../src/generated/server/worldmonitor/market/v1/service_server.ts';
import {
  createBatchServiceRoutes,
  type BatchServiceHandler,
} from '../src/generated/server/worldmonitor/batch/v1/service_server.ts';


const ROOT = join(import.meta.dirname, '..');
const GENERATED_SERVER_ROOT = join(ROOT, 'src/generated/server/worldmonitor');

function walkFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

function generatedMethodNames(): string[] {
  return walkFiles(GENERATED_SERVER_ROOT)
    .filter((path) => path.endsWith('service_server.ts'))
    .flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return [...source.matchAll(/validateRequest\("([^"]+)"/g)].map((match) => match[1]);
    });
}

describe('generated request validation', () => {
  it('registers the production validator and keeps valid requests on the handler path', async () => {
    let handlerCalls = 0;
    const handler = {
      analyzeStock: async () => {
        handlerCalls += 1;
        return { available: true };
      },
    } as unknown as MarketServiceHandler;
    const route = createMarketServiceRoutes(handler, serverOptions)
      .find(({ path }) => path === '/api/market/v1/analyze-stock');

    assert.ok(route);
    const response = await route.handler(new Request(
      'https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL&name=Apple',
    ));

    assert.equal(response.status, 200);
    assert.equal(handlerCalls, 1);
    assert.equal(serverOptions.validateRequest, validateGeneratedRequest);
  });

  it('rejects missing and oversized query fields before the handler runs', async () => {
    let handlerCalls = 0;
    const handler = {
      analyzeStock: async () => {
        handlerCalls += 1;
        return { available: true };
      },
    } as unknown as MarketServiceHandler;
    const route = createMarketServiceRoutes(handler, serverOptions)
      .find(({ path }) => path === '/api/market/v1/analyze-stock');

    assert.ok(route);
    const missing = await route.handler(new Request(
      'https://worldmonitor.app/api/market/v1/analyze-stock',
    ));
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), {
      violations: [
        { field: 'symbol', description: 'value is required' },
      ],
    });

    const oversized = await route.handler(new Request(
      `https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL&name=${'x'.repeat(121)}`,
    ));
    assert.equal(oversized.status, 400);
    assert.deepEqual(await oversized.json(), {
      violations: [
        { field: 'name', description: 'string length must be at most 120' },
      ],
    });
    assert.equal(handlerCalls, 0);
  });

  it('validates repeated nested request messages', async () => {
    let handlerCalls = 0;
    const handler = {
      executeBatch: async () => {
        handlerCalls += 1;
        return { results: [], succeeded: 0, failed: 0 };
      },
    } as BatchServiceHandler;
    const route = createBatchServiceRoutes(handler, serverOptions)
      .find(({ path }) => path === '/api/batch/v1/execute');

    assert.ok(route);
    const response = await route.handler(new Request(
      'https://worldmonitor.app/api/batch/v1/execute',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations: [{ id: 'a', path: '' }] }),
      },
    ));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      violations: [
        { field: 'operations[0].path', description: 'value is required' },
      ],
    });
    assert.equal(handlerCalls, 0);
  });

  it('uses undefined for valid requests and fails closed for unknown generated methods', () => {
    assert.equal(validateGeneratedRequest('analyzeStock', {
      symbol: 'AAPL',
      name: 'Apple',
      includeNews: true,
    }), undefined);
    assert.throws(
      () => validateGeneratedRequest('methodMissingFromGeneratedRegistry', {}),
      /No generated request-validation schema/,
    );
  });

  it('preserves optional zero-value defaults but still rejects invalid explicit values', () => {
    assert.equal(validateGeneratedRequest('getEnergyPrices', {
      commodities: [],
    }), undefined);
    assert.equal(validateGeneratedRequest('getStockAnalysisHistory', {
      symbols: ['AAPL'],
      limitPerSymbol: 0,
    }), undefined);
    assert.deepEqual(validateGeneratedRequest('getStockAnalysisHistory', {
      symbols: ['AAPL'],
      limitPerSymbol: 33,
    }), [
      { field: 'limitPerSymbol', description: 'number must be less than or equal to 32' },
    ]);
    assert.deepEqual(validateGeneratedRequest('getStockAnalysisHistory', {
      symbols: ['AAPL'],
      limitPerSymbol: Number.NaN,
    }), [
      { field: 'limitPerSymbol', description: 'value must be a finite number' },
    ]);
  });

  it('keeps semantically required batches non-empty', () => {
    assert.deepEqual(validateGeneratedRequest('getFredSeriesBatch', {
      seriesIds: [],
      limit: 0,
    }), [
      { field: 'seriesIds', description: 'array must contain at least 1 item(s)' },
    ]);
    assert.deepEqual(validateGeneratedRequest('executeBatch', {
      operations: [],
    }), [
      { field: 'operations', description: 'array must contain at least 1 item(s)' },
    ]);
  });

  it('accepts the macro-stress FRED batch within the handler limit', () => {
    assert.equal(validateGeneratedRequest('getFredSeriesBatch', {
      seriesIds: Array.from({ length: 11 }, (_, index) => `SERIES_${index}`),
      limit: 120,
    }), undefined);
    assert.deepEqual(validateGeneratedRequest('getFredSeriesBatch', {
      seriesIds: Array.from({ length: 21 }, (_, index) => `SERIES_${index}`),
      limit: 120,
    }), [
      { field: 'seriesIds', description: 'array must contain at most 20 item(s)' },
    ]);
  });

  it('enforces every supported scalar and cardinality rule family', () => {
    assert.deepEqual(validateGeneratedRequest('submitErrorReport', {
      message: 'too short',
    }), [
      { field: 'message', description: 'string length must be at least 10' },
    ]);
    assert.deepEqual(validateGeneratedRequest('getCountryStockIndex', {
      countryCode: 'USA',
    }), [
      { field: 'countryCode', description: 'string length must be exactly 2' },
    ]);
    assert.deepEqual(validateGeneratedRequest('getCountryStockIndex', {
      countryCode: 'us',
    }), [
      { field: 'countryCode', description: 'string must match pattern ^[A-Z]{2}$' },
    ]);
    assert.deepEqual(validateGeneratedRequest('getStockAnalysisHistory', {
      symbols: ['AAPL'],
      limitPerSymbol: -1,
    }), [
      { field: 'limitPerSymbol', description: 'number must be greater than or equal to 1' },
    ]);
    assert.deepEqual(validateGeneratedRequest('getUsCpiMonthly', {
      limit: -1,
    }), [
      { field: 'limit', description: 'number must be greater than or equal to 0' },
    ]);
    assert.deepEqual(validateGeneratedRequest('getUsCpiMonthly', {
      limit: 367,
    }), [
      { field: 'limit', description: 'number must be less than or equal to 366' },
    ]);
    assert.deepEqual(validateGeneratedRequest('getPhysicalDivergenceIndex', {
      metals: ['gold', 'silver', 'gold'],
    }), [
      { field: 'metals', description: 'array must contain at most 2 item(s)' },
      { field: 'metals', description: 'array items must be unique' },
    ]);
  });

  // The monitored-company and webhook RPCs that carried enum, claim-pattern and
  // contract-version rules left with their services. The surviving registry
  // still exercises exact constants, per-item patterns and nested elements.
  it('enforces exact constants, per-item patterns and nested repeated elements', () => {
    assert.deepEqual(validateGeneratedRequest('getTemporalBaseline', {
      type: 'military_flights',
      region: 'europe',
    }), [
      { field: 'region', description: 'string must equal global' },
    ]);
    assert.equal(validateGeneratedRequest('getTemporalBaseline', {
      type: 'military_flights',
      region: '',
    }), undefined, 'an ignored zero-value constant field is not a violation');

    assert.deepEqual(validateGeneratedRequest('getPhysicalDivergenceIndex', {
      metals: ['gold', 'platinum'],
    }), [
      { field: 'metals[1]', description: 'string must match pattern ^(?:gold|silver)$' },
    ]);

    assert.deepEqual(validateGeneratedRequest('recordBaselineSnapshot', {
      updates: [
        { type: 'military_flights', region: 'global' },
        { type: '', region: 'europe' },
      ],
    }), [
      { field: 'updates[1].type', description: 'value is required' },
      { field: 'updates[1].region', description: 'string must equal global' },
    ]);
  });

  it('distinguishes an absent proto3 optional scalar from an invalid value', () => {
    assert.equal(validateGeneratedRequest('getUsCpiMonthly', {}), undefined);
    assert.equal(validateGeneratedRequest('getUsCpiMonthly', { limit: 0 }), undefined);
    assert.deepEqual(validateGeneratedRequest('getUsCpiMonthly', {
      limit: -1,
    }), [
      { field: 'limit', description: 'number must be greater than or equal to 0' },
    ]);
  });

  it('covers every generated callback exactly once and wires Vite to the same validator', () => {
    const callbacks = generatedMethodNames();
    const uniqueCallbacks = new Set(callbacks);
    assert.equal(uniqueCallbacks.size, callbacks.length, 'generated method names must not collide');
    assert.deepEqual(
      [...uniqueCallbacks].sort(),
      Object.keys(GENERATED_REQUEST_TYPES).sort(),
      'the generated validator registry must cover every generated route callback',
    );

    const viteConfig = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    assert.match(viteConfig, /validateRequest:\s*validateGeneratedRequest/);
  });
});

// The enum branches (numeric proto3-JSON form, undeclared names, enum.not_in)
// were pinned on the monitored-company RPCs, which left with the trim; no
// surviving request field declares an enum rule. The UTF-8 byte ceiling is now
// the default one every string carries (DEFAULT_STRING_MAX_BYTES).
describe('string byte-ceiling validation branches', () => {
  const LIMIT = 64 * 1024;

  it('accepts a value at exactly the UTF-8 byte ceiling and rejects one byte over', () => {
    // 32,768 x 'é' = exactly 65,536 bytes. A clean request returns undefined,
    // not an empty array.
    assert.equal(validateGeneratedRequest('getBlsSeries', { seriesId: 'é'.repeat(LIMIT / 2) }), undefined);
    assert.deepEqual(
      validateGeneratedRequest('getBlsSeries', { seriesId: `${'é'.repeat(LIMIT / 2)}a` }),
      [{ field: 'seriesId', description: `string UTF-8 length must be at most ${LIMIT} bytes` }],
    );
  });

  it('counts astral surrogate pairs as their UTF-8 byte length', () => {
    // 16,385 x U+1F600 = 65,540 bytes across 32,770 UTF-16 code units; the fast
    // path must fall through to the encoder rather than answering from `.length`.
    assert.deepEqual(
      validateGeneratedRequest('getBlsSeries', { seriesId: '\u{1F600}'.repeat(LIMIT / 4 + 1) }),
      [{ field: 'seriesId', description: `string UTF-8 length must be at most ${LIMIT} bytes` }],
    );
    assert.equal(validateGeneratedRequest('getBlsSeries', { seriesId: '\u{1F600}'.repeat(LIMIT / 4) }), undefined);
  });
});
