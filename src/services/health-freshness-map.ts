import type { DataSourceId } from '@/types';

export const HEALTH_CHECK_SOURCE_MAP: Record<string, readonly DataSourceId[]> = {
  newsInsights: ['rss'],
  outages: ['outages'],
  naturalEvents: ['usgs'],
  weatherAlerts: ['weather'],
  imdCycloneMarine: ['weather'],
  wildfires: ['firms'],
  climateAnomalies: ['climate'],
  climateDisasters: ['climate'],
  climateAirQuality: ['climate'],
  radiationWatch: ['radiation'],
  bisPolicy: ['bis'],
  bisDsr: ['bis'],
  bisPropertyResidential: ['bis'],
  bisPropertyCommercial: ['bis'],
};

const HEALTH_MAPPED_SOURCE_IDS = new Set<DataSourceId>(
  Object.values(HEALTH_CHECK_SOURCE_MAP).flat(),
);

export function isHealthMappedSource(sourceId: DataSourceId): boolean {
  return HEALTH_MAPPED_SOURCE_IDS.has(sourceId);
}

export function getHealthMappedSourceIds(): DataSourceId[] {
  return [...HEALTH_MAPPED_SOURCE_IDS];
}
