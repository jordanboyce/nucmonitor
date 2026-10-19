// market: not re-exported (#4571) — eager service client; kept tree-shakeable out of main.js
export * from './earthquakes';
export * from './clustering';
export * from './related-assets';
export * from './velocity';
export * from './storage';
export * from './weather';
// economic is NOT re-exported here (#4571): it runs a module-load side effect
// (new EconomicServiceClient() + circuit breakers), so an `export *` re-export
// keeps it un-tree-shakeable in eager main.js. Its consumers import it directly
// (`@/services/economic`) or dynamically (data-loader), so it tree-shakes out.
export * from './infrastructure';
// cable-activity: not re-exported (#4649) — eager service client; kept tree-shakeable out of main.js
export * from './cable-health';
export * from './wildfires';
export * from './climate';
export * from './eonet';
export { analysisWorker } from './analysis-worker';
export { activityTracker } from './activity-tracker';
export * from './data-freshness';
export { generateSummary, translateText } from './summarization';
export * from './radiation';
export * from './breaking-news-alerts';
