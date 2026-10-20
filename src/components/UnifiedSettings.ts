import { CANONICAL_FEEDS, SOURCE_REGION_MAP } from '@/config/feeds';
import { WEB_APP_ORIGIN } from '@/config/web-origin';
import { openExternalUrl } from '@/services/external-navigation';
import {
  PANEL_CATEGORY_MAP,
  ALL_PANELS,
  getEffectivePanelConfig,
  getVariantPanelCategories,
  isPanelEntitled,
  FREE_MAX_PANELS,
  countFreePanelCapUsage,
  isFreePanelCapCounted,
  isPanelInVariantDefaults,
} from '@/config/panels';
import { isProUser } from '@/services/widget-store';
import { SITE_VARIANT } from '@/config/variant';
import { t } from '@/services/i18n';
import { createSettingsButton } from '@/components/settings-button';
import { confirmDialog } from '@/components/confirm-dialog';
import type { UnifiedSettingsTabId } from '@/components/settings-types';
import {
  getPanelToggleA11yState,
  getSettingsTabNavigationIndex,
  normalizeSettingsTab,
  restoreSettingsToggleFocus,
  updateSettingsTabSelection,
} from '@/components/unified-settings-interactions';
import type { MapProvider } from '@/config/basemap';
import { escapeHtml } from '@/utils/sanitize';
import { safeStorageRemove, safeStorageSet } from '@/utils/safe-storage';
import type { PanelConfig } from '@/types';
import { renderPreferences } from '@/services/preferences-content';
import { renderNotificationsSettings, type NotificationsSettingsResult } from '@/services/notifications-settings';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { signOut } from '@/services/clerk';
import { requestOwnAccountDeletion } from '@/services/account-deletion';
import { track, trackApiAction } from '@/services/analytics';
import {
  hasEmbedAccessForAccount,
  hasFeature,
  onEntitlementChange,
  onEntitlementVerificationChange,
} from '@/services/entitlements';
import { createApiKey, listApiKeys, revokeApiKey, type ApiKeyInfo } from '@/services/api-keys';
import { createEmbedKey, listEmbedKeys, revokeEmbedKey, type EmbedKeyInfo } from '@/services/embed-keys';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { legalLinksHtml, LEGAL_LINK_ATTR } from '@/utils/legal-links';
import { createFocusTrap, type FocusTrap } from '@/utils/focus-trap';
import {
  overlayHistory,
  type OverlayCloseOrigin,
  type OverlayId,
} from '@/utils/overlay-history';
import { isMobileDevice } from '@/utils';
import {
  FONT_SCALE_STEPS,
  fontScaleLabel,
  parseFontScale,
} from '@/services/font-scale-settings';
import { showToast } from '@/utils/toast';
import { declareOverlay } from '@/utils/open-modal';

export interface UnifiedSettingsConfig {
  getPanelSettings: () => Record<string, PanelConfig>;
  savePanelSettings: (panels: Record<string, PanelConfig>) => void;
  getDisabledSources: () => Set<string>;
  toggleSource: (name: string) => void;
  setSourcesEnabled: (names: string[], enabled: boolean) => void;
  getAllSourceNames: () => string[];
  getLocalizedPanelName: (key: string, fallback: string) => string;
  resetLayout: () => void;
  isDesktopApp: boolean;
  onMapProviderChange?: (provider: MapProvider) => void;
  /**
   * The user finished editing Settings → SOURCES and the enabled set is not
   * what it was when the overlay opened.
   *
   * Sources apply to `ctx.disabledSources` on click (no draft/Save step like
   * panels), but nothing subscribed to that write, so the change only reached
   * the dashboard at the next `REFRESH_INTERVALS.feeds` tick
   * (#6380). This is the subscription.
   *
   * Fired on teardown rather than per click on purpose: the overlay covers the
   * dashboard, so nothing is observable until it closes, and a per-click
   * refetch would be a request storm while the user works through the grid
   * (the budget guarded by e2e/dashboard-news-request-budget.spec.ts). Once per
   * settings session, and only when the selection genuinely moved.
   */
  onSourcesChanged?: () => void;
}

type TabId = UnifiedSettingsTabId;
type AccountRequest = { userId: string; generation: number };

/**
 * Plan-card palette per billing status tone (#7315).
 *
 * The tone comes from the shared coverage predicate in billing-state.ts, never
 * from a status string compared here — a cancelled plan still inside its paid
 * window is a paying customer and must not be painted like a dead account.
 *
 * `unknown` (a provider status this client does not model) is deliberately the
 * neutral grey, not red: we are inside the isEntitled() branch, so claiming a
 * problem we have not established would repeat the bug in a new colour.
 *
 * Colours live on `--billing-tone-*` in main.css so [data-theme="light"] can
 * raise every tone to WCAG AA for the 13px-bold plan name. The card only
 * stamps `data-billing-tone`; it must not inline hex, or those overrides
 * never apply. The status sentence stays on theme-aware var(--text-dim).
 */

export class UnifiedSettings {
  private overlay: HTMLElement;
  private focusTrap: FocusTrap;
  private config: UnifiedSettingsConfig;
  private activeTab: TabId = 'settings';
  private legalLinkHandoffAttached = false;
  private activeSourceRegion = 'all';
  private sourceFilter = '';
  private activePanelCategory = 'all';
  private panelFilter = '';
  private escapeHandler: (e: KeyboardEvent) => void;
  private prefsCleanup: (() => void) | null = null;
  private notifCleanup: (() => void) | null = null;
  private pendingNotifs: NotificationsSettingsResult | null = null;
  private draftPanelSettings: Record<string, PanelConfig> = {};
  private panelsJustSaved = false;
  private savedTimeout: ReturnType<typeof setTimeout> | null = null;
  private confirmingClose = false;
  private historyRegistered = false;
  /**
   * `sourceSelectionSignature()` as of the last open(), or null while closed.
   *
   * A signature rather than a "something was toggled" flag: a source click can
   * legitimately fail to mutate anything (the free-tier cap toasts and returns
   * without touching the set), and toggling a source off and back on again is a
   * net no-op the dashboard must not be asked to reload for.
   */
  private sourceSelectionBaseline: string | null = null;
  private apiKeys: ApiKeyInfo[] = [];
  private apiKeysLoading = false;
  private apiKeysError = '';
  private newlyCreatedKey: string | null = null;
  // ---- Embeds tab (partner-embed `wme_` keys) ----
  private embedKeys: EmbedKeyInfo[] = [];
  private embedKeysLoading = false;
  private embedKeyCreating = false;
  private embedKeysError = '';
  private newlyCreatedEmbedKey: string | null = null;
  // ---- Business Pro seats (plan 2026-07-24-001 U7) ----
  private accountUserId: string | null = getAuthState().user?.id ?? null;
  private accountDataGeneration = 0;
  private accountEntitlementRefreshPending = false;
  private unsubscribeAuth: (() => void) | null = null;
  private unsubscribeEntitlement: (() => void) | null = null;
  private unsubscribeEntitlementVerification: (() => void) | null = null;
  private deletionDialog: HTMLElement | null = null;
  private deletionFocusTrap: FocusTrap | null = null;
  private deletionBusy = false;
  private deletionError = '';
  private deletionPhraseHandler: (() => void) | null = null;

  constructor(config: UnifiedSettingsConfig) {
    this.config = config;

    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay';
    this.overlay.id = 'unifiedSettingsModal';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    declareOverlay(this.overlay, { reload: 'blocking' });
    this.overlay.setAttribute('aria-label', t('header.settings'));
    this.focusTrap = createFocusTrap(this.overlay);

    this.resetPanelDraft();

    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (this.deletionDialog) {
          e.stopPropagation();
          if (!this.deletionBusy) this.closeDeletionDialog();
          return;
        }
        this.close();
      }
    };

    this.overlay.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      if (this.deletionDialog) return;

      if (target === this.overlay) {
        this.close();
        return;
      }

      if (target.closest('.unified-settings-close')) {
        this.close();
        return;
      }

      if (target.closest('.retry-plan-status-btn')) {
        window.location.reload();
        return;
      }

      if (target.closest('[data-delete-account]')) {
        this.openDeletionDialog();
        return;
      }

      const tab = target.closest<HTMLElement>('.unified-settings-tab');
      if (tab?.dataset.tab) {
        this.switchTab(tab.dataset.tab as TabId);
        return;
      }

      const panelCatPill = target.closest<HTMLElement>('[data-panel-cat]');
      if (panelCatPill?.dataset.panelCat) {
        this.activePanelCategory = panelCatPill.dataset.panelCat;
        this.panelFilter = '';
        const searchInput = this.overlay.querySelector<HTMLInputElement>('.panels-search input');
        if (searchInput) searchInput.value = '';
        this.renderPanelCategoryPills();
        this.renderPanelsTab();
        return;
      }

      if (target.closest('.panels-reset-layout')) {
        this.config.resetLayout();
        return;
      }

      if (target.closest('.panels-save-layout')) {
        this.savePanelChanges();
        return;
      }

      const panelItem = target.closest<HTMLElement>('.panel-toggle-item');
      if (panelItem?.dataset.panel) {
        if (panelItem.dataset.proLocked) {
          // Absolute + routed: a relative /pro resolves against tauri://localhost
          // in the desktop WebView, where no such route is served (#5911).
          void openExternalUrl(`${WEB_APP_ORIGIN}/pro`);
          return;
        }
        const panelKey = panelItem.dataset.panel;
        const shouldRestoreFocus = document.activeElement === panelItem;
        this.toggleDraftPanel(panelKey);
        restoreSettingsToggleFocus(
          shouldRestoreFocus,
          this.overlay.querySelectorAll<HTMLElement>('.panel-toggle-item'),
          'panel',
          panelKey,
        );
        return;
      }

      const sourceItem = target.closest<HTMLElement>('.source-toggle-item');
      if (sourceItem?.dataset.source) {
        const sourceName = sourceItem.dataset.source;
        const shouldRestoreFocus = document.activeElement === sourceItem;
        this.config.toggleSource(sourceName);
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        restoreSettingsToggleFocus(
          shouldRestoreFocus,
          this.overlay.querySelectorAll<HTMLElement>('.source-toggle-item'),
          'source',
          sourceName,
        );
        return;
      }

      const pill = target.closest<HTMLElement>('.unified-settings-region-pill');
      if (pill?.dataset.region) {
        this.activeSourceRegion = pill.dataset.region;
        this.sourceFilter = '';
        const searchInput = this.overlay.querySelector<HTMLInputElement>('.sources-search input');
        if (searchInput) searchInput.value = '';
        this.renderRegionPills();
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        return;
      }

      if (target.closest('.sources-select-all')) {
        const visible = this.getVisibleSourceNames();
        this.config.setSourcesEnabled(visible, true);
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        return;
      }

      if (target.closest('.sources-select-none')) {
        const visible = this.getVisibleSourceNames();
        this.config.setSourcesEnabled(visible, false);
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        return;
      }

      if (target.closest('.api-keys-create-btn')) {
        void this.handleCreateApiKey();
        return;
      }

      const revokeBtn = target.closest<HTMLElement>('.api-keys-revoke-btn');
      if (revokeBtn?.dataset.keyId) {
        void this.handleRevokeApiKey(revokeBtn.dataset.keyId);
        return;
      }

      if (target.closest('.api-keys-copy-btn')) {
        const key = this.newlyCreatedKey;
        if (key) {
          void navigator.clipboard.writeText(key).then(() => {
            const btn = this.overlay.querySelector<HTMLElement>('.api-keys-copy-btn');
            if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }
          });
        }
        return;
      }

      if (target.closest('.embed-keys-create-btn')) {
        void this.handleCreateEmbedKey();
        return;
      }

      const embedRevokeBtn = target.closest<HTMLElement>('.embed-keys-revoke-btn');
      if (embedRevokeBtn?.dataset.keyId) {
        void this.handleRevokeEmbedKey(embedRevokeBtn.dataset.keyId);
        return;
      }

      if (target.closest('.embed-keys-copy-btn')) {
        const key = this.newlyCreatedEmbedKey;
        if (key) {
          void navigator.clipboard.writeText(key).then(() => {
            const btn = this.overlay.querySelector<HTMLElement>('.embed-keys-copy-btn');
            if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }
          });
        }
        return;
      }

    });

    this.overlay.addEventListener('change', (e) => {
      const select = (e.target as HTMLElement).closest<HTMLSelectElement>('[data-panel-font-scale]');
      const panelKey = select?.dataset.panelFontScale;
      if (!select || !panelKey) return;
      const panel = this.draftPanelSettings[panelKey];
      if (!panel) return;

      if (select.value === 'global') {
        delete panel.fontScale;
      } else {
        const scale = parseFontScale(select.value);
        if (scale === undefined) {
          select.value = panel.fontScale === undefined ? 'global' : String(panel.fontScale);
          return;
        }
        panel.fontScale = scale;
      }

      this.panelsJustSaved = false;
      select.closest('.panel-settings-item')
        ?.querySelector('.panel-toggle-item')
        ?.classList.toggle(
          'changed',
          this.isPanelDraftChanged(panelKey, panel, this.config.getPanelSettings()),
        );
      this.updatePanelsFooter();
    });

    this.overlay.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.closest('.panels-search')) {
        this.panelFilter = target.value;
        this.renderPanelsTab();
      } else if (target.closest('.sources-search')) {
        this.sourceFilter = target.value;
        this.renderSourcesGrid();
        this.updateSourcesCounter();
      }
    });

    this.render();
    document.body.appendChild(this.overlay);
    this.unsubscribeAuth = subscribeAuthState((state) => {
      this.handleAccountIdentityChange(state.user?.id ?? null);
    });
  }

  private handleAccountIdentityChange(nextUserId: string | null): void {
    if (nextUserId === this.accountUserId) return;

    this.closeDeletionDialog();
    this.accountUserId = nextUserId;
    this.accountDataGeneration += 1;
    this.accountEntitlementRefreshPending = true;
    this.apiKeys = [];
    this.apiKeysLoading = false;
    this.apiKeysError = '';
    this.newlyCreatedKey = null;
    this.embedKeys = [];
    this.embedKeysLoading = false;
    this.embedKeyCreating = false;
    this.embedKeysError = '';
    this.newlyCreatedEmbedKey = null;

    // Replace any rendered A-owned plaintext/list data synchronously. Account
    // loaders stay suppressed until the new entitlement snapshot rerenders.
    if (this.overlay.classList.contains('active')) {
      this.render(false);
    }
  }

  private captureAccountRequest(): AccountRequest | null {
    const userId = getAuthState().user?.id ?? null;
    if (!userId || userId !== this.accountUserId) return null;
    return { userId, generation: this.accountDataGeneration };
  }

  private isAccountRequestCurrent(request: AccountRequest): boolean {
    return request.generation === this.accountDataGeneration
      && request.userId === this.accountUserId
      && request.userId === getAuthState().user?.id;
  }

  public open(tab?: TabId, replaceOverlayId?: OverlayId): void {
    const requestedTab = tab ?? this.activeTab;
    const unavailable =
      requestedTab === 'embeds' && !hasEmbedAccessForAccount(getAuthState().user?.role);
    this.activeTab = unavailable ? 'settings' : requestedTab;
    this.resetPanelDraft();
    // Only on a FRESH session. open() is re-entrant on an overlay that is
    // already up (the deep-dive "Notify me about this country" jump to the
    // notifications tab, an overlayHistory replace), and re-snapshotting there
    // would adopt a source change already made in this session as the baseline
    // — silently discarding the very reload this exists to trigger.
    if (this.sourceSelectionBaseline === null) {
      this.sourceSelectionBaseline = this.sourceSelectionSignature();
    }
    this.render();
    this.overlay.classList.add('active');
    this.focusTrap.activate();
    if (isMobileDevice()) {
      this.historyRegistered = true;
      const close = (origin: OverlayCloseOrigin) => this.close(origin);
      if (replaceOverlayId) overlayHistory.replace(replaceOverlayId, 'settings', close);
      else overlayHistory.open('settings', close);
    }
    safeStorageSet('wm-settings-open', '1');
    document.addEventListener('keydown', this.escapeHandler);
    (this.overlay.querySelector('.unified-settings-tabs') as HTMLElement)?.addEventListener('keydown', (e: KeyboardEvent) => this.handleKeyDown(e));
    track('settings-open', { tab: tab ?? 'default' });

    // Re-render API Keys panel when entitlements arrive (cold-load race:
    // hasFeature('apiAccess') returns false until the Convex subscription
    // delivers data, so a paid API Starter user sees the upgrade CTA briefly).
    this.unsubscribeEntitlement?.();
    this.unsubscribeEntitlement = onEntitlementChange((state) => {
      if (this.accountEntitlementRefreshPending) {
        // Entitlements are account-scoped. Rebuild every account surface so a
        // direct A→B handoff removes/adds embed and API tabs using B's snapshot.
        // Keep the marker through the reset(null) emission; the first real B
        // snapshot must rebuild once more before ordinary targeted refreshes.
        if (state !== null) this.accountEntitlementRefreshPending = false;
        this.render();
        return;
      }

      const hasEmbedsTab = this.overlay.querySelector('[data-tab="embeds"]') !== null;
      if (hasEmbedsTab !== hasEmbedAccessForAccount(getAuthState().user?.role)) {
        // Entitlements can legitimately progress from a free/default snapshot
        // to Pro after the account handoff's first non-null emission. Rebuild
        // the tab shape whenever embed capability changes in either
        // direction.
        this.render();
        return;
      }

      const panel = this.overlay.querySelector<HTMLElement>('[data-panel-id="api-keys"]');
      if (panel) {
        setTrustedHtml(panel, trustedHtml(this.renderApiKeysContent(), "legacy direct innerHTML migration"));
        this.attachApiKeysHandlers();
        if (this.activeTab === 'api-keys' && getAuthState().user && hasFeature('apiAccess')) {
          void this.loadApiKeys();
        }
      }
      const embedsPanel = this.overlay.querySelector<HTMLElement>('[data-panel-id="embeds"]');
      if (embedsPanel) {
        setTrustedHtml(embedsPanel, trustedHtml(this.renderEmbedKeysContent(), "legacy direct innerHTML migration"));
        this.attachEmbedKeysHandlers();
        if (this.activeTab === 'embeds' && getAuthState().user && hasEmbedAccessForAccount(getAuthState().user?.role)) {
          void this.loadEmbedKeys();
        }
      }
      this.replaceUpgradeSection();
    });
    this.unsubscribeEntitlementVerification?.();
    this.unsubscribeEntitlementVerification = onEntitlementVerificationChange(() => {
      this.replaceUpgradeSection();
    });
  }

  /**
   * Swap the .upgrade-pro-section wrapper in place. Click handlers are
   * delegated at overlay level, so replacing the node needs no rebind.
   */
  private replaceUpgradeSection(): void {
    const upgradeSection = this.overlay.querySelector('.upgrade-pro-section');
    if (!upgradeSection) return;
    const fresh = document.createElement('template');
    setTrustedHtml(fresh, trustedHtml(this.renderUpgradeSection().trim(), "legacy direct innerHTML migration"));
    const next = fresh.content.firstElementChild;
    if (next) upgradeSection.replaceWith(next);
  }

  public close(origin: OverlayCloseOrigin = 'control'): void {
    if (origin === 'history') this.historyRegistered = false;
    // An in-flight deletion owns the overlay until it settles. The overlay
    // click handler and escapeHandler already refuse while deletionBusy is
    // set; without this guard the mobile back gesture reaches teardownSettings
    // -> closeDeletionDialog, which clears the latch mid-await and re-permits
    // a second confirmAccountDeletion against the same account. Re-arm the
    // history entry the gesture just consumed, matching the unsaved-changes
    // branch below, so a later back press still closes the overlay. This sits
    // after the flag is cleared above, because that is what makes the
    // re-registration condition reachable.
    if (this.deletionBusy) {
      if (origin === 'history' && !this.historyRegistered) {
        this.historyRegistered = true;
        overlayHistory.open('settings', (nextOrigin) => this.close(nextOrigin));
      }
      return;
    }
    // Unsaved panel changes → confirm before tearing down. The confirm is a
    // non-blocking in-app dialog (#4559): close() stays synchronous (8 callers)
    // and defers teardown to the user's choice instead of a blocking confirm().
    if (origin !== 'replacement' && this.hasPendingPanelChanges()) {
      if (origin === 'history' && !this.historyRegistered) {
        this.historyRegistered = true;
        overlayHistory.open('settings', (nextOrigin) => this.close(nextOrigin));
      }
      if (this.confirmingClose) return; // a confirm is already on screen
      this.confirmingClose = true;
      void confirmDialog({ message: t('header.unsavedChanges') }).then((discard) => {
        this.confirmingClose = false;
        if (discard) this.teardownSettings('control');
      });
      return;
    }
    this.teardownSettings(origin);
  }

  public hasPendingChanges(): boolean {
    return this.hasPendingPanelChanges();
  }

  private teardownSettings(origin: OverlayCloseOrigin = 'control'): void {
    if (origin === 'control' && this.historyRegistered) {
      overlayHistory.close('settings');
    }
    this.historyRegistered = false;
    this.overlay.classList.remove('active');
    this.focusTrap.deactivate();
    this.prefsCleanup?.();
    this.prefsCleanup = null;
    this.notifCleanup?.();
    this.notifCleanup = null;
    this.pendingNotifs = null;
    this.unsubscribeEntitlement?.();
    this.unsubscribeEntitlement = null;
    this.unsubscribeEntitlementVerification?.();
    this.unsubscribeEntitlementVerification = null;
    this.closeDeletionDialog();
    this.resetPanelDraft();
    safeStorageRemove('wm-settings-open');
    document.removeEventListener('keydown', this.escapeHandler);
    // Last: the host reloads data in response, and the overlay covering the
    // dashboard has to be gone before that lands for the user to see it.
    this.notifySourceSelectionChanged();
  }

  /**
   * Order-independent fingerprint of the currently DISABLED source names.
   *
   * NUL is the separator because source names contain spaces ("BBC World"):
   * any separator a name can itself hold collapses `["A B"]` and `["A", "B"]`
   * into one string, which is a silent miss for exactly the swap-one-source-
   * for-another case this comparison exists to catch.
   */
  private sourceSelectionSignature(): string {
    return [...this.config.getDisabledSources()].sort().join('\u0000');
  }

  /**
   * Tell the host the source selection moved during this settings session.
   *
   * Every close path funnels through teardownSettings — the close button, Esc,
   * the overlay backdrop, mobile history back, and the discard branch of the
   * unsaved-panel-changes confirm — so this is the single chokepoint. `destroy()`
   * deliberately does not reach it: the dashboard is going away.
   */
  private notifySourceSelectionChanged(): void {
    const baseline = this.sourceSelectionBaseline;
    this.sourceSelectionBaseline = null;
    // null baseline = never opened. A teardown without an open has no session
    // to compare against, and firing there would reload on a spurious close.
    if (baseline === null || baseline === this.sourceSelectionSignature()) return;
    this.config.onSourcesChanged?.();
  }

  public refreshPanelToggles(): void {
    this.resetPanelDraft();
    if (this.activeTab === 'panels') this.renderPanelsTab();
  }

  public getButton(): HTMLButtonElement {
    return createSettingsButton(() => this.open());
  }

  public destroy(): void {
    if (this.historyRegistered) overlayHistory.close('settings');
    this.historyRegistered = false;
    if (this.savedTimeout) clearTimeout(this.savedTimeout);
    this.prefsCleanup?.();
    this.prefsCleanup = null;
    this.notifCleanup?.();
    this.notifCleanup = null;
    this.pendingNotifs = null;
    this.unsubscribeEntitlement?.();
    this.unsubscribeEntitlement = null;
    this.unsubscribeEntitlementVerification?.();
    this.unsubscribeEntitlementVerification = null;
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = null;
    this.closeDeletionDialog();
    document.removeEventListener('keydown', this.escapeHandler);
    // Teardown, not a user-initiated close: release the trap's document
    // listener without handing focus back to a trigger that is also going away.
    this.focusTrap.deactivate({ restoreFocus: false });
    this.overlay.remove();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!(e.target instanceof HTMLElement)) return;
    const tablist = this.overlay.querySelector('.unified-settings-tabs');
    if (!tablist || !tablist.contains(e.target)) return;
    const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('button[role="tab"]'));
    const currentIndex = tabs.indexOf(e.target.closest('button[role="tab"]') as HTMLButtonElement);
    const nextIndex = getSettingsTabNavigationIndex(e.key, currentIndex, tabs.length);
    if (nextIndex === null) return;

    e.preventDefault();

    const nextTab = tabs[nextIndex];
    const tabId = nextTab?.dataset.tab as TabId | undefined;
    if (!tabId || !nextTab) return;
    this.switchTab(tabId);
    nextTab.focus();
  }

  private render(loadAccountData = true): void {
    this.prefsCleanup?.();
    this.prefsCleanup = null;
    this.notifCleanup?.();
    this.notifCleanup = null;
    this.pendingNotifs = null;

    const isSignedIn = getAuthState().user !== null;
    const prefs = renderPreferences({
      isDesktopApp: this.config.isDesktopApp,
      onMapProviderChange: this.config.onMapProviderChange,
      onSettingSaved: () => showToast(t('modals.settingsWindow.saved')),
      isSignedIn,
    });
    const showNotificationsTab = !this.config.isDesktopApp;
    const notifs = showNotificationsTab
      ? renderNotificationsSettings({ isSignedIn })
      : null;
    // Gated on `embedAccess`, NOT `apiAccess`: both Pro tiers are
    // `apiAccess: false`, so an
    // apiAccess gate would hide embed keys from most of the customers who
    // bought embedding. A tab of its own rather than a section of API Keys so
    // the two credential classes never look interchangeable.
    const showEmbedsTab = hasEmbedAccessForAccount(getAuthState().user?.role);
    const availableTabs: TabId[] = [
      'settings',
      ...(isSignedIn ? ['billing' as const] : []),
      'panels',
      'sources',
      ...(showNotificationsTab ? ['notifications' as const] : []),
      'api-keys',
      ...(showEmbedsTab ? ['embeds' as const] : []),
    ];
    this.activeTab = normalizeSettingsTab(this.activeTab, availableTabs);
    const tabClass = (id: TabId) => `unified-settings-tab${this.activeTab === id ? ' active' : ''}`;

    setTrustedHtml(this.overlay, trustedHtml(`
      <div class="modal unified-settings-modal">
        <div class="modal-header">
          <span class="modal-title">${t('header.settings')}</span>
          <button class="modal-close unified-settings-close" aria-label="Close">\u00d7</button>
        </div>
        <div class="unified-settings-tabs" role="tablist" aria-label="Settings">
          <button class="${tabClass('settings')}" tabindex="${this.activeTab === 'settings' ? 0 : -1}" data-tab="settings" role="tab" aria-selected="${this.activeTab === 'settings'}" id="us-tab-settings" aria-controls="us-tab-panel-settings">${t('header.tabSettings')}</button>
          ${isSignedIn ? `<button class="${tabClass('billing')}" tabindex="${this.activeTab === 'billing' ? 0 : -1}" data-tab="billing" role="tab" aria-selected="${this.activeTab === 'billing'}" id="us-tab-billing" aria-controls="us-tab-panel-billing">Account</button>` : ''}
          <button class="${tabClass('panels')}" tabindex="${this.activeTab === 'panels' ? 0 : -1}" data-tab="panels" role="tab" aria-selected="${this.activeTab === 'panels'}" id="us-tab-panels" aria-controls="us-tab-panel-panels">${t('header.tabPanels')}</button>
          <button class="${tabClass('sources')}" tabindex="${this.activeTab === 'sources' ? 0 : -1}" data-tab="sources" role="tab" aria-selected="${this.activeTab === 'sources'}" id="us-tab-sources" aria-controls="us-tab-panel-sources">${t('header.tabSources')}</button>
          ${showNotificationsTab ? `<button class="${tabClass('notifications')}" tabindex="${this.activeTab === 'notifications' ? 0 : -1}" data-tab="notifications" role="tab" aria-selected="${this.activeTab === 'notifications'}" id="us-tab-notifications" aria-controls="us-tab-panel-notifications">${t('header.tabNotifications')}</button>` : ''}
          <button class="${tabClass('api-keys')}" tabindex="${this.activeTab === 'api-keys' ? 0 : -1}" data-tab="api-keys" role="tab" aria-selected="${this.activeTab === 'api-keys'}" id="us-tab-api-keys" aria-controls="us-tab-panel-api-keys">API Keys <span class="panel-pro-badge">PRO</span></button>
          ${showEmbedsTab ? `<button class="${tabClass('embeds')}" tabindex="${this.activeTab === 'embeds' ? 0 : -1}" data-tab="embeds" role="tab" aria-selected="${this.activeTab === 'embeds'}" id="us-tab-embeds" aria-controls="us-tab-panel-embeds">Embeds <span class="panel-pro-badge">PRO</span></button>` : ''}
        </div>
        <div class="unified-settings-tab-panel${this.activeTab === 'settings' ? ' active' : ''}" data-panel-id="settings" id="us-tab-panel-settings" role="tabpanel" aria-labelledby="us-tab-settings">
          ${prefs.html}
        </div>
        ${isSignedIn ? `
        <div class="unified-settings-tab-panel${this.activeTab === 'billing' ? ' active' : ''}" data-panel-id="billing" id="us-tab-panel-billing" role="tabpanel" aria-labelledby="us-tab-billing">
          <div class="billing-settings-intro">
            <h2>Account</h2>
            <p>Your access level and account controls.</p>
          </div>
          ${this.renderUpgradeSection()}
          ${this.renderAccountDeletionSection()}
        </div>
        ` : ''}
        <div class="unified-settings-tab-panel${this.activeTab === 'panels' ? ' active' : ''}" data-panel-id="panels" id="us-tab-panel-panels" role="tabpanel" aria-labelledby="us-tab-panels">
          <div class="unified-settings-region-wrapper">
            <div class="unified-settings-region-bar" id="usPanelCatBar"></div>
          </div>
          <div class="panels-search">
            <input type="text" placeholder="${t('header.filterPanels')}" aria-label="${t('header.filterPanels')}" value="${escapeHtml(this.panelFilter)}" />
          </div>
          <div class="panel-toggle-grid" id="usPanelToggles"></div>
          <div class="panels-footer">
            <span class="panels-status" id="usPanelsStatus" aria-live="polite"></span>
            <button class="panels-save-layout">${t('modals.story.save')}</button>
            <button class="panels-reset-layout" title="${t('header.resetLayoutTooltip')}" aria-label="${t('header.resetLayoutTooltip')}">${t('header.resetLayout')}</button>
          </div>
        </div>
        <div class="unified-settings-tab-panel${this.activeTab === 'sources' ? ' active' : ''}" data-panel-id="sources" id="us-tab-panel-sources" role="tabpanel" aria-labelledby="us-tab-sources">
          <div class="unified-settings-region-wrapper">
            <div class="unified-settings-region-bar" id="usRegionBar"></div>
          </div>
          <div class="sources-search">
            <input type="text" placeholder="${t('header.filterSources')}" aria-label="${t('header.filterSources')}" value="${escapeHtml(this.sourceFilter)}" />
          </div>
          <div class="sources-toggle-grid" id="usSourceToggles"></div>
          <div class="sources-footer">
            <span class="sources-counter" id="usSourcesCounter"></span>
            <button class="sources-select-all">${t('common.selectAll')}</button>
            <button class="sources-select-none">${t('common.selectNone')}</button>
          </div>
        </div>
        ${notifs ? `
        <div class="unified-settings-tab-panel${this.activeTab === 'notifications' ? ' active' : ''}" data-panel-id="notifications" id="us-tab-panel-notifications" role="tabpanel" aria-labelledby="us-tab-notifications">
          ${notifs.html}
        </div>
        ` : ''}
        <div class="unified-settings-tab-panel${this.activeTab === 'api-keys' ? ' active' : ''}" data-panel-id="api-keys" id="us-tab-panel-api-keys" role="tabpanel" aria-labelledby="us-tab-api-keys">
          ${this.renderApiKeysContent()}
        </div>
        ${showEmbedsTab ? `
        <div class="unified-settings-tab-panel${this.activeTab === 'embeds' ? ' active' : ''}" data-panel-id="embeds" id="us-tab-panel-embeds" role="tabpanel" aria-labelledby="us-tab-embeds">
          ${this.renderEmbedKeysContent()}
        </div>
        ` : ''}
        ${legalLinksHtml(WEB_APP_ORIGIN)}
      </div>
    `, "legacy direct innerHTML migration"));

    const settingsPanel = this.overlay.querySelector('#us-tab-panel-settings');
    if (settingsPanel) {
      this.prefsCleanup = prefs.attach(settingsPanel as HTMLElement);
    }

    // Defer notifications attach until the tab is first activated —
    // otherwise Pro users pay a getChannelsData() fetch on every modal
    // open even if they never visit this tab.
    this.pendingNotifs = notifs;
    if (this.activeTab === 'notifications') this.attachNotificationsTab();

    const closeBtn = this.overlay.querySelector<HTMLButtonElement>('.unified-settings-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.close();
      });
    }

    this.attachLegalLinkHandoff();

    this.renderPanelCategoryPills();
    this.renderPanelsTab();
    this.renderRegionPills();
    this.renderSourcesGrid();
    this.updateSourcesCounter();

    this.attachApiKeysHandlers();
    this.attachEmbedKeysHandlers();
    if (loadAccountData) {
      if (this.activeTab === 'api-keys' && getAuthState().user && hasFeature('apiAccess')) {
        void this.loadApiKeys();
      }
      if (this.activeTab === 'embeds' && getAuthState().user && hasEmbedAccessForAccount(getAuthState().user?.role)) {
        void this.loadEmbedKeys();
      }
    }
  }

  /**
   * Desktop hands legal links to the OS browser (#5911 precedent). A plain
   * `target="_blank"` anchor inside the Tauri WebView opens another WebView
   * window with no chrome, which is how a user ends up stranded on the Terms
   * with no way back. Delegated on the overlay so it covers the legal row AND
   * every checkout-consent line rendered inside a tab panel, including the ones
   * re-rendered after this handler is attached.
   */
  private attachLegalLinkHandoff(): void {
    if (!this.config.isDesktopApp || this.legalLinkHandoffAttached) return;
    // The overlay element outlives every re-render, so an unguarded attach
    // would stack one listener per render and open N windows on one click.
    this.legalLinkHandoffAttached = true;
    this.overlay.addEventListener('click', (e) => {
      const link = (e.target as HTMLElement | null)?.closest?.(`a[${LEGAL_LINK_ATTR}]`);
      const href = link instanceof HTMLAnchorElement ? link.href : '';
      if (!href) return;
      e.preventDefault();
      void openExternalUrl(href);
    });
  }

  private switchTab(tab: TabId): void {
    this.activeTab = tab;

    updateSettingsTabSelection(
      this.overlay.querySelectorAll<HTMLElement>('.unified-settings-tab'),
      this.overlay.querySelectorAll<HTMLElement>('.unified-settings-tab-panel'),
      tab,
    );

    if (tab === 'api-keys' && getAuthState().user && hasFeature('apiAccess')) {
      void this.loadApiKeys();
    }

    if (tab === 'embeds' && getAuthState().user && hasEmbedAccessForAccount(getAuthState().user?.role)) {
      void this.loadEmbedKeys();
    }

    if (tab === 'notifications') {
      this.attachNotificationsTab();
    }
  }

  private attachNotificationsTab(): void {
    if (this.notifCleanup || !this.pendingNotifs) return;
    const notifPanel = this.overlay.querySelector('#us-tab-panel-notifications');
    if (notifPanel) {
      this.notifCleanup = this.pendingNotifs.attach(notifPanel as HTMLElement);
    }
  }

  // Pending state shown while the plan is still resolving — used both before
  // the entitlement snapshot arrives and, for an entitled owner, while the
  // subscription watch is still settling (#6772).
  private renderUpgradeSection(): string {
    // One access level: whoever is signed in here is a partner with full access.
    return `
        <div class="upgrade-pro-section upgrade-pro-active" data-billing-tone="active">
          <div class="upgrade-pro-title">Partner access</div>
          <div class="upgrade-pro-desc">Full access to every panel, export and alert. Contact your NucMonitor administrator to add teammates or API keys.</div>
        </div>
      `;
  }

  private renderAccountDeletionSection(): string {
    return `
      <section class="account-deletion-zone" data-account-deletion>
        <h3 class="account-deletion-title">Delete account</h3>
        <p class="account-deletion-desc">Permanently delete this NucMonitor account. Subscriptions cancel immediately with no refund of remaining prepaid time. API keys, embed keys, and MCP tokens stop working. Billing records needed for accounting, disputes, and lawful requests are kept with the customer contact details they carry; they stop naming your login account, though payment-provider webhook logs written before deletion keep the identifiers they were delivered with. Dashboard preferences and desktop keychain secrets on this device are not wiped remotely.</p>
        <button type="button" class="delete-account-btn" data-delete-account>Delete account</button>
      </section>
    `;
  }

  private syncDeletionConfirmEnabled(): void {
    const overlay = this.deletionDialog;
    if (!overlay) return;
    const input = overlay.querySelector<HTMLInputElement>('[data-deletion-phrase]');
    const confirm = overlay.querySelector<HTMLButtonElement>('[data-deletion-confirm]');
    if (!input || !confirm) return;
    confirm.disabled = this.deletionBusy || input.value.trim() !== 'DELETE';
    input.disabled = this.deletionBusy;
    const error = overlay.querySelector('[data-deletion-error]');
    if (error) error.textContent = this.deletionError;
  }

  private openDeletionDialog(): void {
    if (this.deletionDialog || this.deletionBusy) return;
    this.deletionError = '';
    const overlay = document.createElement('div');
    this.deletionDialog = overlay;
    overlay.className = 'account-deletion-dialog-overlay active';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    declareOverlay(overlay, { reload: 'blocking' });
    overlay.setAttribute('aria-labelledby', 'account-deletion-dialog-title');
    setTrustedHtml(
      overlay,
      trustedHtml(
        `
      <div class="account-deletion-dialog">
        <h2 id="account-deletion-dialog-title" class="account-deletion-dialog-title">Delete this account?</h2>
        <p class="account-deletion-dialog-copy">This cannot be undone. Subscriptions cancel, keys stop working immediately, and billing records are kept for accounting, disputes, and lawful requests — including the contact details they carry. Sign out on other devices and clear this device's site data afterwards — those are out of server reach.</p>
        <label class="account-deletion-dialog-label" for="account-deletion-phrase">Type DELETE to confirm</label>
        <input id="account-deletion-phrase" class="account-deletion-dialog-input" data-deletion-phrase type="text" autocomplete="off" spellcheck="false" />
        <p class="account-deletion-dialog-error" data-deletion-error role="alert"></p>
        <div class="account-deletion-dialog-actions">
          <button type="button" class="confirm-dialog-btn" data-deletion-cancel>Cancel</button>
          <button type="button" class="confirm-dialog-btn confirm-dialog-confirm" data-deletion-confirm disabled>Delete account</button>
        </div>
      </div>
    `,
        'account deletion confirm dialog; static copy only',
      ),
    );
    overlay.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target === overlay || target.closest('[data-deletion-cancel]')) {
        if (!this.deletionBusy) this.closeDeletionDialog();
        return;
      }
      if (target.closest('[data-deletion-confirm]')) {
        void this.confirmAccountDeletion();
      }
    });
    const input = overlay.querySelector<HTMLInputElement>('[data-deletion-phrase]');
    this.deletionPhraseHandler = () => this.syncDeletionConfirmEnabled();
    input?.addEventListener('input', this.deletionPhraseHandler);
    document.body.appendChild(overlay);
    this.syncDeletionConfirmEnabled();
    // aria-modal is a promise to the keyboard: without a trap, Tab walks out
    // of a destructive-action dialog into the settings modal behind it, which
    // is still interactive. Escape stays with escapeHandler (no onEscape here)
    // so an in-flight deletion still cannot be dismissed.
    this.deletionFocusTrap = createFocusTrap(overlay, { initialFocus: () => input });
    this.deletionFocusTrap.activate();
  }

  private closeDeletionDialog(): void {
    const overlay = this.deletionDialog;
    if (!overlay) return;
    const input = overlay.querySelector<HTMLInputElement>('[data-deletion-phrase]');
    if (input && this.deletionPhraseHandler) {
      input.removeEventListener('input', this.deletionPhraseHandler);
    }
    this.deletionPhraseHandler = null;
    // Deactivate before the node leaves the document so the trap can hand
    // focus back to the [data-delete-account] button that opened it.
    this.deletionFocusTrap?.deactivate();
    this.deletionFocusTrap = null;
    overlay.remove();
    this.deletionDialog = null;
    this.deletionBusy = false;
    this.deletionError = '';
  }

  private async confirmAccountDeletion(): Promise<void> {
    const overlay = this.deletionDialog;
    const input = overlay?.querySelector<HTMLInputElement>('[data-deletion-phrase]');
    if (!overlay || !input || input.value.trim() !== 'DELETE' || this.deletionBusy) return;
    this.deletionBusy = true;
    this.deletionError = '';
    this.syncDeletionConfirmEnabled();
    try {
      await requestOwnAccountDeletion();
      this.closeDeletionDialog();
      // Tear down directly rather than via close(): the account is gone, so an
      // unsaved draft in another panel has nothing to be saved to, and close()
      // would stop to ask "discard changes?" for it while signOut() proceeds.
      this.teardownSettings('control');
      await signOut();
      showToast('Account deleted. Sign out on other devices and clear this device\'s site data.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Account deletion failed. Try again.';
      if (message.includes('Account changed')) {
        // Only speak if this attempt still owns the dialog. When the account
        // switch already tore it down, the user has moved on and a late
        // "Account changed... Try again." is about a request they no longer
        // remember starting.
        const stillOurs = this.deletionDialog === overlay;
        this.closeDeletionDialog();
        if (stillOurs) showToast(message);
        return;
      }
      // The dialog is the only place the error text renders, and an account
      // switch can tear it down mid-await. Without this fallback the failure
      // is written into a detached overlay and the user is told nothing.
      if (!this.deletionDialog) {
        showToast(message);
        return;
      }
      // The server is still working when the poll gives up — its external
      // retry ladder outlasts the client timeout by design. Clearing the
      // phrase leaves Confirm disabled so the reflex second submission is not
      // one click away, while still releasing the busy latch so the dialog can
      // be dismissed; re-submitting takes a deliberate re-type.
      if (message.includes('still running')) {
        this.deletionBusy = false;
        this.deletionError = message;
        const phrase = this.deletionDialog
          ?.querySelector<HTMLInputElement>('[data-deletion-phrase]');
        if (phrase) phrase.value = '';
        this.syncDeletionConfirmEnabled();
        return;
      }
      this.deletionBusy = false;
      this.deletionError = message;
      this.syncDeletionConfirmEnabled();
    }
  }

  private categoryMatchesVariant(catDef: { variants?: string[] }): boolean {
    return !catDef.variants || catDef.variants.includes(SITE_VARIANT);
  }

  private getAvailablePanelCategories(): Array<{ key: string; label: string }> {
    return [
      { key: 'all', label: t('header.sourceRegionAll') },
      ...getVariantPanelCategories(this.config.getPanelSettings(), SITE_VARIANT)
        .map(({ key, labelKey }) => ({ key, label: t(labelKey) })),
    ];
  }

  private getVisiblePanelEntries(): Array<[string, PanelConfig]> {
    const panelSettings = this.draftPanelSettings;
    let entries = Object.entries(panelSettings)
      .filter(([key]) => key !== 'runtime-config' || this.config.isDesktopApp)
      .filter(([key]) => !key.startsWith('cw-'));

    if (this.activePanelCategory !== 'all') {
      const catDef = PANEL_CATEGORY_MAP[this.activePanelCategory];
      if (catDef) {
        if (!this.categoryMatchesVariant(catDef)) {
          return [];
        }
        const allowed = new Set(catDef.panelKeys);
        entries = entries.filter(([key]) => allowed.has(key));
      }
    }

    if (this.panelFilter) {
      const lower = this.panelFilter.toLowerCase();
      entries = entries.filter(([key, panel]) =>
        key.toLowerCase().includes(lower) ||
        panel.name.toLowerCase().includes(lower) ||
        this.config.getLocalizedPanelName(key, panel.name).toLowerCase().includes(lower)
      );
    }

    return entries;
  }

  private renderPanelCategoryPills(): void {
    const bar = this.overlay.querySelector('#usPanelCatBar');
    if (!bar) return;

    const categories = this.getAvailablePanelCategories();
    setTrustedHtml(bar, trustedHtml(categories.map(c =>
      `<button class="unified-settings-region-pill${this.activePanelCategory === c.key ? ' active' : ''}" data-panel-cat="${c.key}">${escapeHtml(c.label)}</button>`
    ).join(''), "legacy direct innerHTML migration"));
  }

  private renderPanelsTab(): void {
    const container = this.overlay.querySelector('#usPanelToggles');
    if (!container) return;

    const savedSettings = this.config.getPanelSettings();
    const pro = isProUser();
    const entries = this.getVisiblePanelEntries();
    const panelFontScaleLabel = t('preferences.panelFontScale', { defaultValue: 'Text size' });
    const followGlobalFontScaleLabel = t('preferences.followGlobalFontScale', { defaultValue: 'Use global' });
    setTrustedHtml(container, trustedHtml(entries.map(([key, panel]) => {
      // Preserve saved config for dynamic cw-* panels; unknown keys should not
      // collapse to getEffectivePanelConfig's disabled synthetic fallback.
      const resolvedPanel = ALL_PANELS[key] ? getEffectivePanelConfig(key, SITE_VARIANT) : panel;
      const entitled = isPanelEntitled(key, resolvedPanel, pro);
      const locked = !entitled;
      const changed = !locked && this.isPanelDraftChanged(key, panel, savedSettings);
      const displayName = this.config.getLocalizedPanelName(key, resolvedPanel.name ?? panel.name);
      const a11yState = getPanelToggleA11yState(locked, panel.enabled, displayName);
      // Sandboxed MCP iframes cannot inherit the host panel's CSS scale.
      const supportsPanelFontScale = key !== 'map' && !key.startsWith('mcp-');
      return `
        <div class="panel-settings-item">
          <button type="button" class="panel-toggle-item ${panel.enabled && !locked ? 'active' : ''}${changed ? ' changed' : ''}${locked ? ' pro-locked' : ''}" data-panel="${escapeHtml(key)}" ${a11yState.ariaPressed === null ? '' : `aria-pressed="${a11yState.ariaPressed}"`} ${a11yState.ariaLabel === null ? '' : `aria-label="${escapeHtml(a11yState.ariaLabel)}"`} ${locked ? 'data-pro-locked="1"' : ''}>
            <div class="panel-toggle-checkbox" aria-hidden="true">${panel.enabled && !locked ? '\u2713' : ''}${locked ? '\uD83D\uDD12' : ''}</div>
            <span class="panel-toggle-label">${escapeHtml(displayName)}</span>
            ${(locked || resolvedPanel.premium) ? '<span class="panel-toggle-pro-badge" aria-hidden="true">PRO</span>' : ''}
          </button>
          ${supportsPanelFontScale ? `<label class="panel-font-scale-control">
            <span>${escapeHtml(panelFontScaleLabel)}</span>
            <select data-panel-font-scale="${escapeHtml(key)}" aria-label="${escapeHtml(`${displayName}: ${panelFontScaleLabel}`)}"${locked ? ' disabled' : ''}>
              <option value="global"${panel.fontScale === undefined ? ' selected' : ''}>${escapeHtml(followGlobalFontScaleLabel)}</option>
              ${FONT_SCALE_STEPS.map(scale => `<option value="${scale}"${panel.fontScale === scale ? ' selected' : ''}>${fontScaleLabel(scale)}</option>`).join('')}
            </select>
          </label>` : ''}
        </div>
      `;
    }).join(''), "legacy direct innerHTML migration"));

    this.updatePanelsFooter();
  }

  private clonePanelSettings(source: Record<string, PanelConfig> = this.config.getPanelSettings()): Record<string, PanelConfig> {
    const cloned: Record<string, PanelConfig> = Object.fromEntries(
      Object.entries(source).map(([key, panel]) => [key, { ...panel }]),
    );
    for (const key of Object.keys(ALL_PANELS)) {
      if (!(key in cloned)) {
        cloned[key] = { ...getEffectivePanelConfig(key, SITE_VARIANT), enabled: isPanelInVariantDefaults(key) };
      }
    }
    return cloned;
  }

  private resetPanelDraft(): void {
    this.draftPanelSettings = this.clonePanelSettings();
    this.panelsJustSaved = false;
  }

  private getSavedPanelEnabled(key: string, savedSettings: Record<string, PanelConfig>): boolean {
    const savedPanel = savedSettings[key];
    if (savedPanel) return savedPanel.enabled;
    return Boolean(ALL_PANELS[key]) && isPanelInVariantDefaults(key);
  }

  private getSavedPanelFontScale(
    key: string,
    savedSettings: Record<string, PanelConfig>,
  ): PanelConfig['fontScale'] {
    return savedSettings[key]?.fontScale;
  }

  private isPanelDraftChanged(
    key: string,
    panel: PanelConfig,
    savedSettings: Record<string, PanelConfig>,
  ): boolean {
    return this.getSavedPanelEnabled(key, savedSettings) !== panel.enabled
      || this.getSavedPanelFontScale(key, savedSettings) !== panel.fontScale;
  }

  private hasPendingPanelChanges(): boolean {
    const savedSettings = this.config.getPanelSettings();
    return Object.entries(this.draftPanelSettings).some(
      ([key, panel]) => this.isPanelDraftChanged(key, panel, savedSettings),
    );
  }

  private toggleDraftPanel(key: string): void {
    const panel = this.draftPanelSettings[key];
    if (!panel) return;
    // Preserve saved config for dynamic cw-* panels; unknown keys should not
    // collapse to getEffectivePanelConfig's disabled synthetic fallback.
    const resolvedPanel = ALL_PANELS[key] ? getEffectivePanelConfig(key, SITE_VARIANT) : panel;
    if (!panel.enabled && !isPanelEntitled(key, resolvedPanel, isProUser())) return;
    if (!panel.enabled && !isProUser() && isFreePanelCapCounted(key)) {
      const enabledCount = countFreePanelCapUsage(this.draftPanelSettings);
      if (enabledCount >= FREE_MAX_PANELS) {
        showToast(t('modals.settingsWindow.freePanelLimit', { max: String(FREE_MAX_PANELS) }));
        return;
      }
    }
    panel.enabled = !panel.enabled;
    this.panelsJustSaved = false;
    this.renderPanelsTab();
  }

  private savePanelChanges(): void {
    if (!this.hasPendingPanelChanges()) return;
    this.config.savePanelSettings(Object.fromEntries(Object.entries(this.draftPanelSettings).map(([k, v]) => [k, { ...v }])));
    this.draftPanelSettings = this.clonePanelSettings();
    this.panelsJustSaved = true;
    this.renderPanelsTab();
    if (this.savedTimeout) clearTimeout(this.savedTimeout);
    this.savedTimeout = setTimeout(() => {
      this.panelsJustSaved = false;
      this.savedTimeout = null;
      this.updatePanelsFooter();
    }, 2000);
  }

  private updatePanelsFooter(): void {
    const status = this.overlay.querySelector<HTMLElement>('#usPanelsStatus');
    const saveButton = this.overlay.querySelector<HTMLButtonElement>('.panels-save-layout');
    const hasPendingChanges = this.hasPendingPanelChanges();

    if (saveButton) {
      saveButton.disabled = !hasPendingChanges;
    }

    if (status) {
      status.textContent = this.panelsJustSaved ? t('modals.settingsWindow.saved') : '';
      status.classList.toggle('visible', this.panelsJustSaved);
    }
  }

  private getAvailableRegions(): Array<{ key: string; label: string }> {
    // A region pill shows when at least one of its sources is actually being
    // loaded — getAllSourceNames() covers the active preset PLUS any cross-
    // variant panels the user enabled, so customized-in regions appear too.
    const allowed = new Set(this.config.getAllSourceNames());
    const regions: Array<{ key: string; label: string }> = [
      { key: 'all', label: t('header.sourceRegionAll') }
    ];

    for (const [regionKey, regionDef] of Object.entries(SOURCE_REGION_MAP)) {
      const hasFeeds = regionDef.feedKeys.some(fk =>
        (CANONICAL_FEEDS[fk] ?? []).some(f => allowed.has(f.name)));
      if (hasFeeds) {
        regions.push({ key: regionKey, label: t(regionDef.labelKey) });
      }
    }

    return regions;
  }

  private getSourcesByRegion(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    // Resolve region membership from CANONICAL_FEEDS (the all-variant union),
    // then intersect with the sources actually loaded — getAllSourceNames()
    // already covers the active preset + any custom panels the user enabled —
    // so a customized-in panel's sources show under their proper region pill,
    // not just the 'all' view.
    const allowed = new Set(this.config.getAllSourceNames());

    for (const [regionKey, regionDef] of Object.entries(SOURCE_REGION_MAP)) {
      const sources: string[] = [];
      for (const fk of regionDef.feedKeys) {
        for (const f of CANONICAL_FEEDS[fk] ?? []) {
          if (allowed.has(f.name)) sources.push(f.name);
        }
      }
      if (sources.length > 0) {
        map.set(regionKey, sources.sort((a, b) => a.localeCompare(b)));
      }
    }

    return map;
  }

  private getVisibleSourceNames(): string[] {
    let sources: string[];
    if (this.activeSourceRegion === 'all') {
      sources = this.config.getAllSourceNames();
    } else {
      const byRegion = this.getSourcesByRegion();
      sources = byRegion.get(this.activeSourceRegion) || [];
    }

    if (this.sourceFilter) {
      const lower = this.sourceFilter.toLowerCase();
      sources = sources.filter(s => s.toLowerCase().includes(lower));
    }

    return sources;
  }

  private renderRegionPills(): void {
    const bar = this.overlay.querySelector('#usRegionBar');
    if (!bar) return;

    const regions = this.getAvailableRegions();
    setTrustedHtml(bar, trustedHtml(regions.map(r =>
      `<button class="unified-settings-region-pill${this.activeSourceRegion === r.key ? ' active' : ''}" data-region="${r.key}">${escapeHtml(r.label)}</button>`
    ).join(''), "legacy direct innerHTML migration"));
  }

  private renderSourcesGrid(): void {
    const container = this.overlay.querySelector('#usSourceToggles');
    if (!container) return;

    const sources = this.getVisibleSourceNames();
    const disabled = this.config.getDisabledSources();

    setTrustedHtml(container, trustedHtml(sources.map(source => {
      const isEnabled = !disabled.has(source);
      const escaped = escapeHtml(source);
      return `
        <button type="button" class="source-toggle-item ${isEnabled ? 'active' : ''}" aria-pressed="${isEnabled}" data-source="${escaped}">
          <div class="source-toggle-checkbox" aria-hidden="true">${isEnabled ? '\u2713' : ''}</div>
          <span class="source-toggle-label">${escaped}</span>
        </button>
      `;
    }).join(''), "legacy direct innerHTML migration"));
  }

  private updateSourcesCounter(): void {
    const counter = this.overlay.querySelector('#usSourcesCounter');
    if (!counter) return;

    const disabled = this.config.getDisabledSources();
    const allSources = this.config.getAllSourceNames();
    const enabledTotal = allSources.length - disabled.size;

    counter.textContent = t('header.sourcesEnabled', { enabled: String(enabledTotal), total: String(allSources.length) });
  }

  // ---------------------------------------------------------------------------
  // API Keys tab
  // ---------------------------------------------------------------------------

  private attachApiKeysHandlers(): void {
    // Enter to submit (only exists when entitled user sees full UI)
    const apiKeyInput = this.overlay.querySelector<HTMLInputElement>('.api-keys-name-input');
    if (apiKeyInput) {
      apiKeyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void this.handleCreateApiKey();
      });
    }

    // Gate CTA click (sign-in for anonymous)
    const gateBtn = this.overlay.querySelector<HTMLElement>('.api-keys-gate-btn');
    if (gateBtn) {
      gateBtn.addEventListener('click', () => {
        if (!getAuthState().user) {
          this.close();
          import('@/services/clerk').then(m => m.openSignIn()).catch(() => {});
        }
      });
    }
  }

  private renderApiKeysContent(): string {
    const authState = getAuthState();

    if (!authState.user) {
      const lockIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`;
      return `
        <div class="panel-locked-state">
          <div class="panel-locked-icon">${lockIcon}</div>
          <div class="panel-locked-desc">Sign in to unlock API Keys</div>
          <button class="panel-locked-cta api-keys-gate-btn">Sign In</button>
        </div>`;
    }

    return `
      <div class="api-keys-section">
        <div class="api-keys-header">
          <p class="api-keys-desc">Create API keys to access NucMonitor data programmatically. Keys are shown once on creation — store them securely.</p>
        </div>
        <div class="api-keys-create-form">
          <input type="text" class="api-keys-name-input" placeholder="Key name (e.g. my-app)" aria-label="API key name" maxlength="64" />
          <button class="btn btn-primary api-keys-create-btn">Create Key</button>
        </div>
        <div class="api-keys-created-banner" id="usApiKeysBanner" style="display:none;"></div>
        <div class="api-keys-error" id="usApiKeysError" style="display:none;"></div>
        <div class="api-keys-list" id="usApiKeysList">
          <div class="api-keys-loading">Loading...</div>
        </div>
      </div>`;
  }

  private async loadApiKeys(): Promise<void> {
    const request = this.captureAccountRequest();
    if (!request || this.apiKeysLoading) return;
    this.apiKeysLoading = true;
    this.apiKeysError = '';
    this.renderApiKeysList();

    try {
      const keys = await listApiKeys();
      if (!this.isAccountRequestCurrent(request)) return;
      this.apiKeys = keys;
    } catch (err) {
      if (!this.isAccountRequestCurrent(request)) return;
      this.apiKeysError = err instanceof Error ? err.message : 'Failed to load keys';
    } finally {
      if (this.isAccountRequestCurrent(request)) {
        this.apiKeysLoading = false;
        this.renderApiKeysList();
      }
    }
  }

  private async handleCreateApiKey(): Promise<void> {
    const input = this.overlay.querySelector<HTMLInputElement>('.api-keys-name-input');
    const btn = this.overlay.querySelector<HTMLButtonElement>('.api-keys-create-btn');
    const name = input?.value.trim();
    if (!name || !input || !btn) return;
    const request = this.captureAccountRequest();
    if (!request) return;

    btn.disabled = true;
    btn.textContent = 'Creating...';
    this.apiKeysError = '';
    this.newlyCreatedKey = null;
    this.hideBanner();

    try {
      const result = await createApiKey(name);
      if (!this.isAccountRequestCurrent(request)) return;
      trackApiAction('key-created');
      this.newlyCreatedKey = result.key;
      input.value = '';
      this.showCreatedBanner(result.key);
      await this.loadApiKeys();
    } catch (err) {
      if (!this.isAccountRequestCurrent(request)) return;
      const msg = err instanceof Error ? err.message : 'Failed to create key';
      this.apiKeysError = msg.includes('KEY_LIMIT_REACHED')
        ? 'Maximum of 5 active keys reached. Revoke an existing key first.'
        : msg.includes('API_ACCESS_REQUIRED')
        ? 'API keys require an API access subscription (API Starter or higher).'
        : msg;
      this.renderApiKeysError();
    } finally {
      if (this.isAccountRequestCurrent(request)) {
        btn.disabled = false;
        btn.textContent = 'Create Key';
      }
    }
  }

  private async handleRevokeApiKey(keyId: string): Promise<void> {
    const request = this.captureAccountRequest();
    if (!request) return;
    const keyInfo = this.apiKeys.find(k => k.id === keyId);
    const keyName = keyInfo?.name ?? 'this key';
    if (!confirm(`Revoke "${keyName}"? This cannot be undone. Any applications using this key will stop working.`)) return;

    try {
      await revokeApiKey(keyId);
      if (!this.isAccountRequestCurrent(request)) return;
      trackApiAction('key-revoked');
      await this.loadApiKeys();
    } catch (err) {
      if (!this.isAccountRequestCurrent(request)) return;
      this.apiKeysError = err instanceof Error ? err.message : 'Failed to revoke key';
      this.renderApiKeysError();
    }
  }

  private showCreatedBanner(key: string): void {
    const banner = this.overlay.querySelector<HTMLElement>('#usApiKeysBanner');
    if (!banner) return;

    banner.style.display = 'block';
    setTrustedHtml(banner, trustedHtml(`
      <div class="api-keys-banner-title">Key created — copy it now, it won't be shown again</div>
      <div class="api-keys-banner-key">
        <code class="api-keys-key-value">${escapeHtml(key)}</code>
        <button class="btn btn-secondary api-keys-copy-btn">Copy</button>
      </div>
    `, "legacy direct innerHTML migration"));
  }

  private hideBanner(): void {
    const banner = this.overlay.querySelector<HTMLElement>('#usApiKeysBanner');
    if (banner) {
      banner.style.display = 'none';
      setTrustedHtml(banner, trustedHtml('', "legacy direct innerHTML migration"));
    }
  }

  private renderApiKeysError(): void {
    const el = this.overlay.querySelector<HTMLElement>('#usApiKeysError');
    if (!el) return;
    if (this.apiKeysError) {
      el.style.display = 'block';
      el.textContent = this.apiKeysError;
    } else {
      el.style.display = 'none';
      el.textContent = '';
    }
  }

  private renderApiKeysList(): void {
    const container = this.overlay.querySelector('#usApiKeysList');
    if (!container) return;

    if (this.apiKeysLoading && this.apiKeys.length === 0) {
      setTrustedHtml(container, trustedHtml('<div class="api-keys-loading">Loading...</div>', "legacy direct innerHTML migration"));
      return;
    }

    this.renderApiKeysError();

    const active = this.apiKeys.filter(k => !k.revokedAt);
    const revoked = this.apiKeys.filter(k => k.revokedAt);

    if (active.length === 0 && revoked.length === 0) {
      setTrustedHtml(container, trustedHtml('<div class="api-keys-empty">No API keys yet. Create one above to get started.</div>', "legacy direct innerHTML migration"));
      return;
    }

    const formatDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

    const renderKey = (k: ApiKeyInfo) => {
      const isRevoked = !!k.revokedAt;
      return `
        <div class="api-keys-item${isRevoked ? ' revoked' : ''}">
          <div class="api-keys-item-main">
            <span class="api-keys-item-name">${escapeHtml(k.name)}</span>
            <code class="api-keys-item-prefix">${escapeHtml(k.keyPrefix)}${'*'.repeat(8)}</code>
          </div>
          <div class="api-keys-item-meta">
            <span>Created ${formatDate(k.createdAt)}</span>
            ${k.lastUsedAt ? `<span>Last used ${formatDate(k.lastUsedAt)}</span>` : ''}
            ${isRevoked ? `<span class="api-keys-item-revoked-badge">Revoked ${formatDate(k.revokedAt!)}</span>` : ''}
          </div>
          ${!isRevoked ? `<button class="btn btn-ghost api-keys-revoke-btn" data-key-id="${escapeHtml(k.id)}">Revoke</button>` : ''}
        </div>
      `;
    };

    setTrustedHtml(container, trustedHtml(active.map(renderKey).join('')
      + (revoked.length > 0 ? `<div class="api-keys-revoked-section"><div class="api-keys-revoked-label">Revoked</div>${revoked.map(renderKey).join('')}</div>` : ''), "legacy direct innerHTML migration"));
  }

  // ---------------------------------------------------------------------------
  // Embeds tab — partner-embed keys (`wme_…`)
  //
  // Gated on `embedAccess`, never `apiAccess`: both Pro tiers sell embedding
  // without REST access, and the API Keys tab above would hide embed keys from
  // exactly the customers this feature exists for.
  //
  // A separate tab rather than a second list inside API Keys, because the two
  // credentials have opposite handling rules and must never read as
  // interchangeable: an embed key is MEANT to be published in the partner's
  // page HTML; a `wm_` key there hands over the account's whole REST allowance.
  // ---------------------------------------------------------------------------

  private attachEmbedKeysHandlers(): void {
    const input = this.overlay.querySelector<HTMLInputElement>('.embed-keys-name-input');
    if (!input) return;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.handleCreateEmbedKey();
    });
  }

  private renderEmbedKeysContent(): string {
    const authState = getAuthState();

    if (!authState.user) {
      const lockIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`;
      return `
        <div class="panel-locked-state">
          <div class="panel-locked-icon">${lockIcon}</div>
          <div class="panel-locked-desc">Sign in to manage embed keys</div>
        </div>`;
    }

    if (!hasEmbedAccessForAccount(authState.user?.role)) {
      // Defensive — the tab is hidden entirely without embedAccess, so this
      // only shows if the subscription lapsed while the modal was open.
      const upgradeIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="16 12 12 8 8 12"/><line x1="12" y1="16" x2="12" y2="8"/></svg>`;
      return `
        <div class="panel-locked-state">
          <div class="panel-locked-icon">${upgradeIcon}</div>
          <div class="panel-locked-desc">Put NucMonitor panels on your own site with a scoped embed key.</div>
        </div>`;
    }

    return `
      <div class="embed-keys-section">
        <div class="embed-keys-header">
          <p class="embed-keys-desc">Embed keys authorise NucMonitor panels on your site and nothing else, and each one is shown once at creation. Paste it into the <code>data-key</code> attribute of the <a class="embed-keys-docs-link" ${LEGAL_LINK_ATTR} href="${escapeHtml(`${WEB_APP_ORIGIN}/docs/embed-live-map`)}" target="_blank" rel="noopener noreferrer">embed loader</a>.</p>
        </div>
        <div class="embed-keys-note">
          <strong>These are meant to be public.</strong> An embed key sits in your page's HTML where anyone can read it — that is the point, and it is why it exists as its own credential. Never put an API key (<code>wm_…</code>) there instead: that one carries your whole REST allowance. New reads with a revoked key are denied within about a minute. Already rendered paid-only panels remain visible until reload. A live map already showing its paid tier holds a session grant for up to 30 more minutes, then drops to the free tier.
        </div>
        <div class="embed-keys-create-form">
          <input type="text" class="embed-keys-name-input" placeholder="Key name (e.g. marketing-site)" aria-label="Embed key name" maxlength="64" />
          <button class="btn btn-primary embed-keys-create-btn" ${this.embedKeyCreating ? 'disabled' : ''}>${this.embedKeyCreating ? 'Creating...' : 'Create Embed Key'}</button>
        </div>
        <div class="embed-keys-created-banner" id="usEmbedKeysBanner" style="display:none;"></div>
        <div class="embed-keys-error" id="usEmbedKeysError" style="display:none;"></div>
        <div class="embed-keys-list" id="usEmbedKeysList">
          <div class="embed-keys-loading">Loading...</div>
        </div>
      </div>`;
  }

  private async loadEmbedKeys(): Promise<void> {
    const request = this.captureAccountRequest();
    if (!request || this.embedKeysLoading) return;
    this.embedKeysLoading = true;
    this.embedKeysError = '';
    this.renderEmbedKeysList();

    try {
      const keys = await listEmbedKeys();
      if (!this.isAccountRequestCurrent(request)) return;
      this.embedKeys = keys;
    } catch (err) {
      if (!this.isAccountRequestCurrent(request)) return;
      this.embedKeysError = err instanceof Error ? err.message : 'Failed to load embed keys';
    } finally {
      if (this.isAccountRequestCurrent(request)) {
        this.embedKeysLoading = false;
        this.renderEmbedKeysList();
      }
    }
  }

  private async handleCreateEmbedKey(): Promise<void> {
    if (this.embedKeyCreating) return;
    const input = this.overlay.querySelector<HTMLInputElement>('.embed-keys-name-input');
    const btn = this.overlay.querySelector<HTMLButtonElement>('.embed-keys-create-btn');
    const name = input?.value.trim();
    if (!name || !input || !btn) return;
    const request = this.captureAccountRequest();
    if (!request) return;

    this.embedKeyCreating = true;
    btn.disabled = true;
    btn.textContent = 'Creating...';
    this.embedKeysError = '';
    this.newlyCreatedEmbedKey = null;
    this.hideEmbedKeysBanner();

    try {
      const result = await createEmbedKey(name);
      if (!this.isAccountRequestCurrent(request)) return;
      this.newlyCreatedEmbedKey = result.key;
      const currentInput = this.overlay.querySelector<HTMLInputElement>('.embed-keys-name-input');
      if (currentInput) currentInput.value = '';
      this.showEmbedKeysCreatedBanner(result.key);
      await this.loadEmbedKeys();
    } catch (err) {
      if (!this.isAccountRequestCurrent(request)) return;
      const msg = err instanceof Error ? err.message : 'Failed to create embed key';
      this.embedKeysError = msg.includes('KEY_LIMIT_REACHED')
        ? 'Maximum of 5 active embed keys reached. Revoke an existing key first.'
        : msg.includes('EMBED_ACCESS_REQUIRED')
        ? 'Embed keys require an active paid plan.'
        : msg;
      this.renderEmbedKeysError();
    } finally {
      if (this.isAccountRequestCurrent(request)) {
        this.embedKeyCreating = false;
        const currentBtn = this.overlay.querySelector<HTMLButtonElement>('.embed-keys-create-btn');
        if (currentBtn) {
          currentBtn.disabled = false;
          currentBtn.textContent = 'Create Embed Key';
        }
      }
    }
  }

  private async handleRevokeEmbedKey(keyId: string): Promise<void> {
    const request = this.captureAccountRequest();
    if (!request) return;
    const keyInfo = this.embedKeys.find(k => k.id === keyId);
    const keyName = keyInfo?.name ?? 'this key';
    if (!confirm(`Revoke "${keyName}"? This cannot be undone. New reads with this key will be denied within about a minute. Already rendered paid-only panels remain visible until reload. A live map can retain its paid tier for up to 30 more minutes.`)) return;

    try {
      await revokeEmbedKey(keyId);
      if (!this.isAccountRequestCurrent(request)) return;
      await this.loadEmbedKeys();
    } catch (err) {
      if (!this.isAccountRequestCurrent(request)) return;
      this.embedKeysError = err instanceof Error ? err.message : 'Failed to revoke embed key';
      this.renderEmbedKeysError();
    }
  }

  private showEmbedKeysCreatedBanner(key: string): void {
    const banner = this.overlay.querySelector<HTMLElement>('#usEmbedKeysBanner');
    if (!banner) return;

    banner.style.display = 'block';
    setTrustedHtml(banner, trustedHtml(`
      <div class="embed-keys-banner-title">Embed key created — copy it now, it won't be shown again</div>
      <div class="embed-keys-banner-key">
        <code class="embed-keys-key-value">${escapeHtml(key)}</code>
        <button class="btn btn-secondary embed-keys-copy-btn">Copy</button>
      </div>
    `, "legacy direct innerHTML migration"));
  }

  private hideEmbedKeysBanner(): void {
    const banner = this.overlay.querySelector<HTMLElement>('#usEmbedKeysBanner');
    if (banner) {
      banner.style.display = 'none';
      setTrustedHtml(banner, trustedHtml('', "legacy direct innerHTML migration"));
    }
  }

  private renderEmbedKeysError(): void {
    const el = this.overlay.querySelector<HTMLElement>('#usEmbedKeysError');
    if (!el) return;
    if (this.embedKeysError) {
      el.style.display = 'block';
      el.textContent = this.embedKeysError;
    } else {
      el.style.display = 'none';
      el.textContent = '';
    }
  }

  private renderEmbedKeysList(): void {
    const container = this.overlay.querySelector('#usEmbedKeysList');
    if (!container) return;

    if (this.embedKeysLoading && this.embedKeys.length === 0) {
      setTrustedHtml(container, trustedHtml('<div class="embed-keys-loading">Loading...</div>', "legacy direct innerHTML migration"));
      return;
    }

    this.renderEmbedKeysError();

    const active = this.embedKeys.filter(k => !k.revokedAt);
    const revoked = this.embedKeys.filter(k => k.revokedAt);

    if (active.length === 0 && revoked.length === 0) {
      setTrustedHtml(container, trustedHtml('<div class="embed-keys-empty">No embed keys yet. Create one above, then paste it into the loader snippet from the Embed button on the map.</div>', "legacy direct innerHTML migration"));
      return;
    }

    const formatDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

    const renderKey = (k: EmbedKeyInfo) => {
      const isRevoked = !!k.revokedAt;
      return `
        <div class="embed-keys-item${isRevoked ? ' revoked' : ''}">
          <div class="embed-keys-item-main">
            <span class="embed-keys-item-name">${escapeHtml(k.name)}</span>
            <code class="embed-keys-item-prefix">${escapeHtml(k.keyPrefix)}${'*'.repeat(8)}</code>
          </div>
          <div class="embed-keys-item-meta">
            <span>Created ${formatDate(k.createdAt)}</span>
            ${k.lastUsedAt ? `<span>Last used ${formatDate(k.lastUsedAt)}</span>` : ''}
            ${isRevoked ? `<span class="embed-keys-item-revoked-badge">Revoked ${formatDate(k.revokedAt!)}</span>` : ''}
          </div>
          ${!isRevoked ? `<button class="btn btn-ghost embed-keys-revoke-btn" data-key-id="${escapeHtml(k.id)}">Revoke</button>` : ''}
        </div>
      `;
    };

    setTrustedHtml(container, trustedHtml(active.map(renderKey).join('')
      + (revoked.length > 0 ? `<div class="embed-keys-revoked-section"><div class="embed-keys-revoked-label">Revoked</div>${revoked.map(renderKey).join('')}</div>` : ''), "legacy direct innerHTML migration"));
  }
}
