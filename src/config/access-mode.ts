/**
 * Deployment access mode (docs/partner-access.md), fixed at build time by
 * VITE_ACCESS_MODE and mirrored on the server by ACCESS_MODE.
 *
 *   public-demo (default)  anyone can open the dashboard; a banner marks it as
 *                          a demo of public data. Shared reads use the
 *                          CDN-cached anonymous URL shapes.
 *   partner                a signed-in, invited partner is required before the
 *                          app boots, and every read carries the session.
 */
export type AccessMode = 'public-demo' | 'partner';

export const ACCESS_MODE: AccessMode =
  String(import.meta.env.VITE_ACCESS_MODE ?? '').trim().toLowerCase() === 'partner' ? 'partner' : 'public-demo';

export const IS_PARTNER_MODE = ACCESS_MODE === 'partner';

/** Where to send someone who needs access. Optional; the gate omits the link when unset. */
export const PARTNER_CONTACT_EMAIL = String(import.meta.env.VITE_PARTNER_CONTACT_EMAIL ?? '').trim();

/**
 * A bootstrap read URL: the shared anonymous `&public=1` shape in demo mode,
 * the session-gated shape in partner mode (the server serves no anonymous
 * reads there).
 */
export function bootstrapReadPath(query: string): string {
  return IS_PARTNER_MODE ? `/api/bootstrap?${query}` : `/api/bootstrap?${query}&public=1`;
}

/** Credentials for those reads: none on the public CDN shape, the session otherwise. */
export const SHARED_READ_CREDENTIALS: RequestCredentials = IS_PARTNER_MODE ? 'include' : 'omit';
