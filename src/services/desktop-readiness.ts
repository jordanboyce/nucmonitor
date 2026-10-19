import { isFeatureAvailable, type RuntimeFeatureId } from './runtime-config';

export type LocalityClass = 'fully-local' | 'api-key' | 'cloud-fallback';

export interface DesktopParityFeature {
  id: string;
  panel: string;
  serviceFiles: string[];
  apiRoutes: string[];
  apiHandlers: string[];
  locality: LocalityClass;
  fallback: string;
  priority: 1 | 2 | 3;
}

export interface DesktopReadinessCheck {
  id: string;
  label: string;
  ready: boolean;
}

const keyBackedFeatures: RuntimeFeatureId[] = [
  'aiOllama',
  'aiOpenRouter',
  'economicFred',
  'internetOutages',
  'acledConflicts',
  'ucdpConflicts',
  'abuseChThreatIntel',
  'alienvaultOtxThreatIntel',
  'abuseIpdbThreatIntel',
  'aisRelay',
  'openskyRelay',
  'wingbitsEnrichment',
  'energyEia',
];

export const DESKTOP_PARITY_FEATURES: DesktopParityFeature[] = [
  {
    id: 'monitor',
    panel: 'MonitorPanel',
    serviceFiles: [],
    apiRoutes: [],
    apiHandlers: [],
    locality: 'fully-local',
    fallback: 'Keyword monitoring runs fully client-side on loaded news corpus.',
    priority: 1,
  },
  {
    id: 'summaries',
    panel: 'Summaries',
    serviceFiles: ['src/services/summarization.ts'],
    apiRoutes: ['/api/news/v1/summarize-article'],
    apiHandlers: ['server/worldmonitor/news/v1/handler.ts'],
    locality: 'api-key',
    fallback: 'Browser summarizer executes when hosted LLM providers are unavailable.',
    priority: 2,
  },
];

export function getNonParityFeatures(): DesktopParityFeature[] {
  return DESKTOP_PARITY_FEATURES.filter(feature => feature.locality !== 'fully-local');
}

export function getDesktopReadinessChecks(localBackendEnabled: boolean): DesktopReadinessCheck[] {
  const liveTrackingReady = isFeatureAvailable('aisRelay') || isFeatureAvailable('openskyRelay');

  return [
    { id: 'startup', label: 'Desktop startup + sidecar API health', ready: localBackendEnabled },
    { id: 'map', label: 'Map rendering (local layers + static geo assets)', ready: true },
    { id: 'core-intel', label: 'Core intelligence panels (Live News, Monitor, Strategic Risk)', ready: true },
    { id: 'summaries', label: 'Summaries (provider-backed or browser fallback)', ready: isFeatureAvailable('aiOllama') || isFeatureAvailable('aiOpenRouter') },
    { id: 'market', label: 'Market panel live data paths', ready: true },
    { id: 'live-tracking', label: 'At least one live-tracking mode (AIS or OpenSky)', ready: liveTrackingReady },
  ];
}

export function getKeyBackedAvailabilitySummary(): { available: number; total: number } {
  const available = keyBackedFeatures.filter(featureId => isFeatureAvailable(featureId)).length;
  return { available, total: keyBackedFeatures.length };
}
