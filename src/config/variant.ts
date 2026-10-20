/**
 * NucMonitor ships a single dashboard. The variant type survives as a
 * one-member union so persisted settings and URL parameters that still carry
 * a variant id can be validated against it.
 */
export const SITE_VARIANTS = ['nuclear'] as const;

export type SiteVariant = (typeof SITE_VARIANTS)[number];

export function isSiteVariant(value: string | null | undefined): value is SiteVariant {
  return typeof value === 'string' && (SITE_VARIANTS as readonly string[]).includes(value);
}

export const SITE_VARIANT: SiteVariant = 'nuclear';
