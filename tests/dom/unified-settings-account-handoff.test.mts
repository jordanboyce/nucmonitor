/**
 * The settings modal owns account-scoped plaintext and lists. Exercise the
 * real class and its real subscribeAuthState wiring so removing the
 * constructor subscription cannot leave account A's data rendered for B.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { UnifiedSettingsConfig } from '@/components/UnifiedSettings';
import type { ApiKeyInfo } from '@/services/api-keys';
import type { ApiPlanLimitNotice } from '@/services/api-plan-limit-notices';
import type { AuthSession } from '@/services/auth-state';
import type {
  EntitlementState,
  EntitlementVerificationStatus,
} from '@/services/entitlements';

let session: AuthSession = signedIn('A');
const authListeners: Array<(state: AuthSession) => void> = [];

const apiKeyMocks = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
}));
const noticeMocks = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  list: vi.fn(),
}));
const entitlementMocks = vi.hoisted(() => ({
  state: null as EntitlementState | null,
  listeners: [] as Array<(state: EntitlementState | null) => void>,
  verificationStatus: 'idle' as EntitlementVerificationStatus,
  verificationListeners: [] as Array<(status: EntitlementVerificationStatus) => void>,
}));
const panelGatingMocks = vi.hoisted(() => ({
  hasPremiumAccess: true,
}));
const storageValues = new Map<string, string>();
const storage: Storage = {
  get length() { return storageValues.size; },
  clear: () => storageValues.clear(),
  getItem: (key) => storageValues.get(key) ?? null,
  key: (index) => [...storageValues.keys()][index] ?? null,
  removeItem: (key) => { storageValues.delete(key); },
  setItem: (key, value) => { storageValues.set(key, value); },
};

vi.mock('@/services/auth-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/auth-state')>()),
  getAuthState: () => session,
  subscribeAuthState: (listener: (state: AuthSession) => void) => {
    authListeners.push(listener);
    listener(session);
    return () => {
      const index = authListeners.indexOf(listener);
      if (index >= 0) authListeners.splice(index, 1);
    };
  },
}));

vi.mock('@/services/entitlements', () => ({
  getEntitlementState: () => entitlementMocks.state,
  getEntitlementVerificationStatus: () => entitlementMocks.verificationStatus,
  hasFeature: (feature: string) => Boolean(
    (entitlementMocks.state?.features as Record<string, unknown> | undefined)?.[feature],
  ),
  hasEmbedAccessForAccount: (role: 'free' | 'pro' | undefined) => (
    role === 'pro' || Boolean(entitlementMocks.state?.features.embedAccess)
  ),
  isEntitled: (planKey?: string) => (
    entitlementMocks.state !== null
    && (planKey === undefined || entitlementMocks.state.planKey === planKey)
  ),
  onEntitlementChange: (listener: (state: EntitlementState | null) => void) => {
    entitlementMocks.listeners.push(listener);
    if (entitlementMocks.state !== null) listener(entitlementMocks.state);
    return () => {
      const index = entitlementMocks.listeners.indexOf(listener);
      if (index >= 0) entitlementMocks.listeners.splice(index, 1);
    };
  },
  onEntitlementVerificationChange: (
    listener: (status: EntitlementVerificationStatus) => void,
  ) => {
    entitlementMocks.verificationListeners.push(listener);
    listener(entitlementMocks.verificationStatus);
    return () => {
      const index = entitlementMocks.verificationListeners.indexOf(listener);
      if (index >= 0) entitlementMocks.verificationListeners.splice(index, 1);
    };
  },
}));

vi.mock('@/services/panel-gating', () => ({
  hasPremiumAccess: () => panelGatingMocks.hasPremiumAccess,
}));

vi.mock('@/services/widget-store', () => ({
  isProUser: () => true,
}));

vi.mock('@/services/preferences-content', () => ({
  renderPreferences: () => ({
    html: '',
    attach: () => () => {},
  }),
}));

vi.mock('@/services/notifications-settings', () => ({
  renderNotificationsSettings: () => ({
    html: '',
    attach: () => () => {},
  }),
}));

vi.mock('@/config/feeds', () => ({
  CANONICAL_FEEDS: {},
  INTEL_SOURCES: [],
  SOURCE_REGION_MAP: {},
}));

vi.mock('@/config/panels', () => ({
  PANEL_CATEGORY_MAP: {},
  ALL_PANELS: {},
  VARIANT_DEFAULTS: { full: [] },
  getEffectivePanelConfig: () => ({ name: '', enabled: false }),
  getVariantPanelCategories: () => [],
  isPanelEntitled: () => true,
  FREE_MAX_PANELS: 3,
  countFreePanelCapUsage: () => 0,
  isFreePanelCapCounted: () => false,
}));

vi.mock('@/config/variant', () => ({
  SITE_VARIANT: 'full',
}));

vi.mock('@/services/billing', () => ({
  getSubscription: () => null,
  isSubscriptionLoaded: () => true,
  onSubscriptionChange: () => () => {},
  openBillingPortal: async () => ({ outcome: 'no-customer' as const }),
  prereserveBillingPortalTab: () => null,
  listBusinessSeats: async () => ({
    businessSubscriptionId: null,
    ownerDomain: null,
    ownerIsCorporateDomain: false,
    seats: [],
  }),
  inviteBusinessSeats: async () => ({ invited: [] }),
  removeBusinessSeat: async () => ({ status: 'removed' as const }),
}));

// Partial so the real status-tone helpers stay available: a full stub goes
// stale the moment billing-state gains an export the panel renders (#7315).
vi.mock('@/services/billing-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/billing-state')>()),
  deriveBillingUxState: () => 'active',
  getReactivationHref: () => '/pro#pricing',
}));

vi.mock('@/services/api-keys', () => ({
  createApiKey: (...args: unknown[]) => apiKeyMocks.create(...args),
  listApiKeys: (...args: unknown[]) => apiKeyMocks.list(...args),
  revokeApiKey: (...args: unknown[]) => apiKeyMocks.revoke(...args),
}));

vi.mock('@/services/api-plan-limit-notices', () => ({
  acknowledgePlanLimitNotice: (...args: unknown[]) => noticeMocks.acknowledge(...args),
  listCurrentPlanLimitNotices: (...args: unknown[]) => noticeMocks.list(...args),
}));

const { UnifiedSettings } = await import('@/components/UnifiedSettings');

type SettingsInternals = {
  overlay: HTMLElement;
  activeTab: 'api-keys';
  accountDataGeneration: number;
  accountEntitlementRefreshPending: boolean;
  apiKeys: ApiKeyInfo[];
  apiKeysLoading: boolean;
  apiKeysError: string;
  newlyCreatedKey: string | null;
  planLimitNotices: ApiPlanLimitNotice[];
  planLimitNoticesLoading: boolean;
  planLimitNoticesError: string;
  render(loadAccountData?: boolean): void;
  renderApiKeysList(): void;
  showCreatedBanner(key: string): void;
  loadApiKeys(): Promise<void>;
  loadPlanLimitNotices(): Promise<void>;
  handleCreateApiKey(): Promise<void>;
  handleRevokeApiKey(keyId: string): Promise<void>;
  handleAcknowledgePlanLimitNotice(noticeId: string): Promise<void>;
};

function signedIn(id: string): AuthSession {
  return {
    user: {
      id,
      name: `User ${id}`,
      email: `${id.toLowerCase()}@example.com`,
      role: 'pro',
    },
    isPending: false,
  };
}

function entitlement(options: {
  planKey: string;
  apiAccess: boolean;
  mcpAccess: boolean;
}): EntitlementState {
  return {
    planKey: options.planKey,
    features: {
      tier: options.planKey === 'free' ? 0 : 1,
      apiAccess: options.apiAccess,
      apiRateLimit: options.apiAccess ? 10_000 : 0,
      maxDashboards: options.planKey === 'free' ? 1 : 10,
      prioritySupport: options.planKey !== 'free',
      exportFormats: options.apiAccess ? ['json'] : [],
      mcpAccess: options.mcpAccess,
    },
    validUntil: Date.now() + 86_400_000,
  };
}

function emitEntitlementVerification(status: EntitlementVerificationStatus): void {
  entitlementMocks.verificationStatus = status;
  for (const listener of [...entitlementMocks.verificationListeners]) listener(status);
}

function notice(id = 'notice-a'): ApiPlanLimitNotice {
  return {
    _id: id,
    userId: 'A',
    planKey: 'api_business',
    dimension: 'api_daily_requests',
    state: 'warning',
    windowKey: 'A private window',
    usage: 90,
    limit: 100,
    usageRatio: 0.9,
    ctaKind: 'none',
  };
}

const config: UnifiedSettingsConfig = {
  getPanelSettings: () => ({}),
  savePanelSettings: () => {},
  getDisabledSources: () => new Set(),
  toggleSource: () => {},
  setSourcesEnabled: () => {},
  getAllSourceNames: () => [],
  getLocalizedPanelName: (_key, fallback) => fallback,
  resetLayout: () => {},
  isDesktopApp: false,
};

let settings: InstanceType<typeof UnifiedSettings>;
let internal: SettingsInternals;

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  authListeners.length = 0;
  entitlementMocks.listeners.length = 0;
  entitlementMocks.verificationListeners.length = 0;
  entitlementMocks.state = entitlement({
    planKey: 'api_business',
    apiAccess: true,
    mcpAccess: true,
  });
  entitlementMocks.verificationStatus = 'ready';
  panelGatingMocks.hasPremiumAccess = true;
  storageValues.clear();
  vi.stubGlobal('localStorage', storage);
  session = signedIn('A');
  apiKeyMocks.create.mockReset().mockResolvedValue({
    id: 'default',
    name: 'default',
    keyPrefix: 'wm_default',
    key: 'wm_default_plaintext',
  });
  apiKeyMocks.list.mockReset().mockResolvedValue([]);
  apiKeyMocks.revoke.mockReset().mockResolvedValue(undefined);
  noticeMocks.acknowledge.mockReset().mockResolvedValue(undefined);
  noticeMocks.list.mockReset().mockResolvedValue([]);

  settings = new UnifiedSettings(config);
  internal = settings as unknown as SettingsInternals;
  internal.overlay.classList.add('active');
  internal.activeTab = 'api-keys';
});

afterEach(() => {
  settings.destroy();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('UnifiedSettings real auth-subscription handoff', () => {
  it('keeps checking past 12 seconds while entitlement verification is still in flight', () => {
    vi.useFakeTimers();
    panelGatingMocks.hasPremiumAccess = false;
    entitlementMocks.state = null;
    entitlementMocks.verificationStatus = 'pending';

    try {
      settings.open('billing');
      expect(internal.overlay.textContent).toContain('Checking your plan');

      vi.advanceTimersByTime(12_000);

      expect(internal.overlay.textContent).toContain('Checking your plan');
      expect(internal.overlay.textContent).not.toContain('Plan status unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows retry only after entitlement verification becomes unavailable', () => {
    panelGatingMocks.hasPremiumAccess = false;
    entitlementMocks.state = null;
    entitlementMocks.verificationStatus = 'pending';
    settings.open('billing');

    expect(internal.overlay.textContent).toContain('Checking your plan');
    expect(internal.overlay.querySelector('.retry-plan-status-btn')).toBeNull();

    emitEntitlementVerification('unavailable');

    expect(internal.overlay.textContent).toContain('Plan status unavailable');
    expect(internal.overlay.querySelector('.retry-plan-status-btn')).not.toBeNull();
  });

  it('preserves notices and renders a current-account authentication error', async () => {
    internal.planLimitNotices = [notice()];
    internal.render(false);
    noticeMocks.list.mockRejectedValue(
      new Error('Authentication unavailable while loading API plan-limit notices. Try again.'),
    );

    await internal.loadPlanLimitNotices();

    expect(internal.planLimitNotices).toEqual([notice()]);
    expect(internal.planLimitNoticesError).toBe(
      'Authentication unavailable while loading API plan-limit notices. Try again.',
    );
    expect(internal.overlay.textContent).toContain('A private window');
    expect(internal.overlay.textContent).toContain(
      'Authentication unavailable while loading API plan-limit notices. Try again.',
    );
  });

});
