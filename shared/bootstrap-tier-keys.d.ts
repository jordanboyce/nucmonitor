export type BootstrapTier = 'fast' | 'slow' | 'on-demand';

export const BOOTSTRAP_CACHE_KEYS: Readonly<Record<string, string> & {
  weatherAlerts: string;
}>;
export const BOOTSTRAP_TIERS: Readonly<Record<string, BootstrapTier>>;
export const PUBLIC_WEATHER_BOOTSTRAP_KEY: 'weatherAlerts';

export function bootstrapTierKeyNames(tier: BootstrapTier): string[];
