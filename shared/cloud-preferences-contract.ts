export const PREFERENCE_VARIANTS = ['full', 'nuclear'] as const;

export type PreferenceVariant = (typeof PREFERENCE_VARIANTS)[number];

export function isPreferenceVariant(value: unknown): value is PreferenceVariant {
  return typeof value === 'string' && (PREFERENCE_VARIANTS as readonly string[]).includes(value);
}

// Omission-safe keys: an older writer that predates one of these leaves it out
// of the blob, and the server keeps the stored value (see
// preserveOmittedRollingDeploymentFields in convex/userPreferences.ts).
export const ROLLING_DEPLOYMENT_PREFERENCE_KEYS = [
  'wm-font-scale',
  'wm-live-media-idle-stop',
] as const;
