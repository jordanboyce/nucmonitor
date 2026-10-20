#!/usr/bin/env node
import { runBundle, MIN } from './_bundle-runner.mjs';

await runBundle('market-backup', [
  { label: 'Crypto-Quotes', script: 'seed-crypto-quotes.mjs', seedMetaKey: 'market:crypto', canonicalKey: 'market:crypto:v1', intervalMs: 5 * MIN, timeoutMs: 120_000 },
  // SSE/SZSE publish both series once per session (margin on a T+1 lag), so an
  // hourly cadence is retries, not extra data. timeoutMs clears the adapter's
  // own CHINA_STOCK_CONNECT_MAX_NETWORK_MS worst case (179s). No relay secret:
  // this member reaches the exchanges directly or through the proxy, never
  // through the edge hop.
  { label: 'Token-Panels', script: 'seed-token-panels.mjs', seedMetaKey: 'market:token-panels', canonicalKey: 'market:defi-tokens:v1', completionMetaKey: 'seed-completion:market:token-panels', intervalMs: 30 * MIN, timeoutMs: 120_000 },
  // SPDR GLD publishes holdings once daily (~16:30 ET). 2h cadence = retries on Cloudflare blocks + catches late publish.
  { label: 'Gold-ETF-Flows', script: 'seed-gold-etf-flows.mjs', seedMetaKey: 'market:gold-etf-flows', canonicalKey: 'market:gold-etf-flows:v1', intervalMs: 120 * MIN, timeoutMs: 60_000 },
  // IMF IFS publishes monthly with ~2-3 month lag. Daily cadence is plenty.
  { label: 'Gold-CB-Reserves', script: 'seed-gold-cb-reserves.mjs', seedMetaKey: 'market:gold-cb-reserves', canonicalKey: 'market:gold-cb-reserves:v1', intervalMs: 24 * 60 * MIN, timeoutMs: 180_000 },
  // SEC company_tickers.json updates roughly daily; the 8-K feed is near-real-time (#5695).
]);
