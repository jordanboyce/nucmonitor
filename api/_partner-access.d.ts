export type AccessMode = 'public-demo' | 'partner';

export type PartnerVerdict =
  | { ok: true; userId: string; email: string }
  | {
      ok: false;
      status: 401 | 403 | 503;
      error: 'sign_in_required' | 'partner_access_required' | 'access_unverifiable';
    };

export interface PartnerAccessDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  verifyJwt?: (token: string) => Promise<Record<string, unknown> | null>;
  now?: number;
}

export function getAccessMode(env?: Record<string, string | undefined>): AccessMode;
export function isPartnerMode(env?: Record<string, string | undefined>): boolean;
export function isAllowlistedEmail(email: string, env?: Record<string, string | undefined>): boolean;
export function getBearerToken(req: Request): string;
export function verifyPartnerRequest(req: Request, deps?: PartnerAccessDeps): Promise<PartnerVerdict>;
export function __resetPartnerAccessForTests(): void;
