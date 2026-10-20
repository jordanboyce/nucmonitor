import { getCurrentLanguageTag, t } from '@/services/i18n';
import { getAiFlowSettings, setAiFlowSetting, getStreamQuality, setStreamQuality, STREAM_QUALITY_OPTIONS } from '@/services/ai-flow-settings';
import { getMapProvider, setMapProvider, MAP_PROVIDER_OPTIONS, MAP_THEME_OPTIONS, getMapTheme, setMapTheme, type MapProvider } from '@/config/basemap';
import {
  formatIdleStopMinutes,
  getLiveMediaIdleStop,
  getLiveStreamsAlwaysOn,
  LIVE_MEDIA_IDLE_STOP_OPTIONS,
  parseLiveMediaIdleStop,
  setLiveMediaIdleStop,
  setLiveStreamsAlwaysOn,
} from '@/services/live-stream-settings';
import { getGlobeVisualPreset, setGlobeVisualPreset, GLOBE_VISUAL_PRESET_OPTIONS, type GlobeVisualPreset } from '@/services/globe-render-settings';
import type { StreamQuality } from '@/services/ai-flow-settings';
import { getThemePreference, setThemePreference, type ThemePreference } from '@/utils/theme-manager';
import { getFontFamily, setFontFamily, type FontFamily } from '@/services/font-settings';
import {
  FONT_SCALE_CHANGED_EVENT,
  FONT_SCALE_STEPS,
  fontScaleLabel,
  getFontScale,
  parseFontScale,
  setFontScale,
  type FontScaleChangedDetail,
} from '@/services/font-scale-settings';
import { escapeHtml } from '@/utils/sanitize';
import { exportSettings, importSettings, type ImportResult } from '@/utils/settings-persistence';
import { getSyncState, getLastSyncAt, syncNow, isCloudSyncEnabled } from '@/utils/cloud-prefs-sync';

const SYNC_STATE_LABELS: Record<string, string> = {
  synced: 'Synced', pending: 'Pending', syncing: 'Syncing\u2026',
  conflict: 'Conflict', offline: 'Offline', 'signed-out': 'Signed out', error: 'Error',
};
const SYNC_STATE_COLORS: Record<string, string> = {
  synced: 'var(--color-ok, #34d399)', pending: 'var(--color-warn, #fbbf24)', syncing: 'var(--color-warn, #fbbf24)',
  conflict: 'var(--color-error, #f87171)', offline: 'var(--text-faint, #888)', 'signed-out': 'var(--text-faint, #888)', error: 'var(--color-error, #f87171)',
};
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';


const DESKTOP_RELEASES_URL = 'https://github.com/koala73/worldmonitor/releases';

export interface PreferencesHost {
  isDesktopApp: boolean;
  onMapProviderChange?: (provider: MapProvider) => void;
  onSettingSaved?: () => void;
  isSignedIn?: boolean;
}

export interface PreferencesResult {
  html: string;
  attach: (container: HTMLElement) => () => void;
}

function toggleRowHtml(
  id: string,
  label: string,
  desc: string,
  checked: boolean,
  disabled = false,
): string {
  // The visible text lives outside the wrapping <label>, so the checkbox
  // needs an explicit aria-labelledby/-describedby to have an accessible name.
  return `
    <div class="ai-flow-toggle-row${disabled ? ' is-disabled' : ''}">
      <div class="ai-flow-toggle-label-wrap">
        <div class="ai-flow-toggle-label" id="${id}-label">${label}</div>
        <div class="ai-flow-toggle-desc" id="${id}-desc">${desc}</div>
      </div>
      <label class="ai-flow-switch${disabled ? ' is-disabled' : ''}">
        <input type="checkbox" id="${id}" aria-labelledby="${id}-label" aria-describedby="${id}-desc"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>
        <span class="ai-flow-slider"></span>
      </label>
    </div>
  `;
}

function renderMapThemeDropdown(container: HTMLElement, provider: MapProvider): void {
  const select = container.querySelector<HTMLSelectElement>('#us-map-theme');
  if (!select) return;
  const currentTheme = getMapTheme(provider);
  setTrustedHtml(select, trustedHtml(MAP_THEME_OPTIONS[provider]
    .map(opt => `<option value="${opt.value}"${opt.value === currentTheme ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`)
    .join(''), "legacy direct innerHTML migration"));
}

function updateSyncStatusUI(container: HTMLElement): void {
  const dot = container.querySelector<HTMLElement>('#usSyncDot');
  const label = container.querySelector<HTMLElement>('#usSyncLabel');
  const time = container.querySelector<HTMLElement>('#usSyncTime');
  if (!dot || !label || !time) return;

  const state = getSyncState();
  const lastSync = getLastSyncAt();

  dot.style.background = (SYNC_STATE_COLORS[state] ?? SYNC_STATE_COLORS.error) as string;
  label.textContent = SYNC_STATE_LABELS[state] ?? 'Unknown';
  time.textContent = `Last synced: ${lastSync ? new Date(lastSync).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : 'Never'}`;
}

function updateAiStatus(container: HTMLElement): void {
  const settings = getAiFlowSettings();
  const dot = container.querySelector('#usStatusDot');
  const text = container.querySelector('#usStatusText');
  if (!dot || !text) return;

  dot.className = 'ai-flow-status-dot';
  if (settings.cloudLlm && settings.browserModel) {
    dot.classList.add('active');
    text.textContent = t('components.insights.aiFlowStatusCloudAndBrowser');
  } else if (settings.cloudLlm) {
    dot.classList.add('active');
    text.textContent = t('components.insights.aiFlowStatusActive');
  } else if (settings.browserModel) {
    dot.classList.add('browser-only');
    text.textContent = t('components.insights.aiFlowStatusBrowserOnly');
  } else {
    dot.classList.add('disabled');
    text.textContent = t('components.insights.aiFlowStatusDisabled');
  }
}

function handlePreferenceChange(
  target: HTMLInputElement,
  container: HTMLElement,
  host: PreferencesHost,
): boolean | Promise<boolean> {
  switch (target.id) {
    case 'us-stream-quality':
      setStreamQuality(target.value as StreamQuality);
      return true;
    case 'us-globe-visual-preset':
      setGlobeVisualPreset(target.value as GlobeVisualPreset);
      return true;
    case 'us-theme':
      setThemePreference(target.value as ThemePreference);
      return true;
    case 'us-font-family':
      setFontFamily(target.value as FontFamily);
      return true;
    case 'us-font-scale': {
      const scale = parseFontScale(target.value);
      if (scale === undefined) return false;
      setFontScale(scale);
      return true;
    }
    case 'us-map-provider': {
      const provider = target.value as MapProvider;
      setMapProvider(provider);
      renderMapThemeDropdown(container, provider);
      host.onMapProviderChange?.(provider);
      window.dispatchEvent(new CustomEvent('map-theme-changed'));
      return true;
    }
    case 'us-map-theme':
      setMapTheme(getMapProvider(), target.value);
      window.dispatchEvent(new CustomEvent('map-theme-changed'));
      return true;
    case 'us-live-streams-always-on':
      setLiveStreamsAlwaysOn(target.checked);
      return true;
    case 'us-live-media-idle-stop': {
      const idleStop = parseLiveMediaIdleStop(target.value);
      if (idleStop === undefined) return false;
      setLiveMediaIdleStop(idleStop);
      return true;
    }
    case 'us-cloud':
      setAiFlowSetting('cloudLlm', target.checked);
      updateAiStatus(container);
      return true;
    case 'us-browser': {
      setAiFlowSetting('browserModel', target.checked);
      const warn = container.querySelector<HTMLElement>('.ai-flow-toggle-warn');
      if (warn) warn.style.display = target.checked ? 'block' : 'none';
      // Headline Memory is a child of Browser Local Model — keep its
      // toggle's enabled/disabled state in sync without re-rendering
      // the whole panel. The runtime gate (`isHeadlineMemoryEnabled`)
      // already AND-gates both flags; this just mirrors that visually.
      const hmInput = container.querySelector<HTMLInputElement>('#us-headline-memory');
      const hmRow = hmInput?.closest('.ai-flow-toggle-row');
      const hmSwitch = hmInput?.closest('.ai-flow-switch');
      if (hmInput && !host.isDesktopApp) {
        hmInput.disabled = !target.checked;
        hmRow?.classList.toggle('is-disabled', !target.checked);
        hmSwitch?.classList.toggle('is-disabled', !target.checked);
      }
      updateAiStatus(container);
      return true;
    }
    case 'us-map-flash':
      setAiFlowSetting('mapNewsFlash', target.checked);
      return true;
    case 'us-headline-memory':
      setAiFlowSetting('headlineMemory', target.checked);
      return true;
    case 'us-badge-anim':
      setAiFlowSetting('badgeAnimation', target.checked);
      return true;
    default:
      return false;
  }
}

export function renderPreferences(host: PreferencesHost): PreferencesResult {
  const settings = getAiFlowSettings();
  let html = '';

  // ── Display group ──
  html += `<details class="wm-pref-group" open>`;
  html += `<summary>${t('preferences.display')}</summary>`;
  html += `<div class="wm-pref-group-content">`;

  // Appearance
  const currentThemePref = getThemePreference();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="us-theme-label">${t('preferences.theme')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.themeDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-theme" aria-labelledby="us-theme-label">`;
  for (const opt of [
    { value: 'auto', label: t('preferences.themeAuto') },
    { value: 'dark', label: t('preferences.themeDark') },
    { value: 'light', label: t('preferences.themeLight') },
  ] as { value: ThemePreference; label: string }[]) {
    const selected = opt.value === currentThemePref ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  // Font family
  const currentFont = getFontFamily();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="us-font-family-label">${t('preferences.fontFamily')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.fontFamilyDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-font-family" aria-labelledby="us-font-family-label">`;
  for (const opt of [
    { value: 'mono', label: t('preferences.fontMono') },
    { value: 'system', label: t('preferences.fontSystem') },
  ] as { value: FontFamily; label: string }[]) {
    const selected = opt.value === currentFont ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  // Panel font scale. Fixed-geometry map chrome deliberately does not inherit
  // this value; individual panel overrides live in Settings -> Panels.
  const currentFontScale = getFontScale();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="us-font-scale-label">${t('preferences.fontScale', { defaultValue: 'Panel text size' })}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.fontScaleDesc', { defaultValue: 'Sets panel text globally. A panel-specific value replaces this setting.' })}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-font-scale" aria-labelledby="us-font-scale-label">`;
  for (const scale of FONT_SCALE_STEPS) {
    const selected = scale === currentFontScale ? ' selected' : '';
    html += `<option value="${scale}"${selected}>${fontScaleLabel(scale)}</option>`;
  }
  html += `</select>`;

  // Map tile provider
  const currentProvider = getMapProvider();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="us-map-provider-label">${t('preferences.mapProvider')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.mapProviderDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-map-provider" aria-labelledby="us-map-provider-label">`;
  for (const opt of MAP_PROVIDER_OPTIONS) {
    const selected = opt.value === currentProvider ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  // Map theme
  const currentMapTheme = getMapTheme(currentProvider);
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="us-map-theme-label">${t('preferences.mapTheme')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.mapThemeDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-map-theme" aria-labelledby="us-map-theme-label">`;
  for (const opt of MAP_THEME_OPTIONS[currentProvider]) {
    const selected = opt.value === currentMapTheme ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  html += toggleRowHtml('us-map-flash', t('components.insights.mapFlashLabel'), t('components.insights.mapFlashDesc'), settings.mapNewsFlash);

  // 3D Globe Visual Preset
  const currentPreset = getGlobeVisualPreset();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="us-globe-visual-preset-label">${t('preferences.globePreset')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.globePresetDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-globe-visual-preset" aria-labelledby="us-globe-visual-preset-label">`;
  for (const opt of GLOBE_VISUAL_PRESET_OPTIONS) {
    const selected = opt.value === currentPreset ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  html += `</div></details>`;

  // ── Intelligence group ──
  html += `<details class="wm-pref-group">`;
  html += `<summary>${t('preferences.intelligence')}</summary>`;
  html += `<div class="wm-pref-group-content">`;

  if (!host.isDesktopApp) {
    html += toggleRowHtml('us-cloud', t('components.insights.aiFlowCloudLabel'), t('components.insights.aiFlowCloudDesc'), settings.cloudLlm);
    html += toggleRowHtml('us-browser', t('components.insights.aiFlowBrowserLabel'), t('components.insights.aiFlowBrowserDesc'), settings.browserModel);
    html += `<div class="ai-flow-toggle-warn" style="display:${settings.browserModel ? 'block' : 'none'}">${t('components.insights.aiFlowBrowserWarn')}</div>`;
    html += `
      <div class="ai-flow-cta">
        <div class="ai-flow-cta-title">${t('components.insights.aiFlowOllamaCta')}</div>
        <div class="ai-flow-cta-desc">${t('components.insights.aiFlowOllamaCtaDesc')}</div>
        <a href="${DESKTOP_RELEASES_URL}" target="_blank" rel="noopener noreferrer" class="ai-flow-cta-link">${t('components.insights.aiFlowDownloadDesktop')}</a>
      </div>
    `;
  }

  // Headline Memory requires Browser Local Model (it loads an embeddings
  // model in the ML worker). Disable the toggle when the parent is off so
  // the user sees the dependency rather than wondering why their Headline
  // Memory toggle "did nothing."
  const headlineDisabled = !host.isDesktopApp && !settings.browserModel;
  html += toggleRowHtml(
    'us-headline-memory',
    t('components.insights.headlineMemoryLabel'),
    t('components.insights.headlineMemoryDesc'),
    settings.headlineMemory,
    headlineDisabled,
  );

  html += `</div></details>`;

  // ── Media group ──
  html += `<details class="wm-pref-group">`;
  html += `<summary>${t('preferences.media')}</summary>`;
  html += `<div class="wm-pref-group-content">`;

  const currentQuality = getStreamQuality();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="us-stream-quality-label">${t('components.insights.streamQualityLabel')}</div>
      <div class="ai-flow-toggle-desc">${t('components.insights.streamQualityDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-stream-quality" aria-labelledby="us-stream-quality-label">`;
  for (const opt of STREAM_QUALITY_OPTIONS) {
    const selected = opt.value === currentQuality ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  html += toggleRowHtml(
    'us-live-streams-always-on',
    t('components.insights.streamAlwaysOnLabel'),
    t('components.insights.streamAlwaysOnDesc'),
    getLiveStreamsAlwaysOn(),
  );

  const currentIdleStop = getLiveMediaIdleStop();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="us-live-media-idle-stop-label">${t('components.insights.streamIdleStopLabel')}</div>
      <div class="ai-flow-toggle-desc">${t('components.insights.streamIdleStopDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-live-media-idle-stop" aria-labelledby="us-live-media-idle-stop-label">`;
  for (const option of LIVE_MEDIA_IDLE_STOP_OPTIONS) {
    const label = option === 'never'
      ? t('components.insights.streamIdleStopNever')
      : formatIdleStopMinutes(option, getCurrentLanguageTag());
    const selected = option === currentIdleStop ? ' selected' : '';
    html += `<option value="${option}"${selected}>${escapeHtml(label)}</option>`;
  }
  html += `</select>`;

  html += `</div></details>`;

  // ── Panels group ──
  html += `<details class="wm-pref-group">`;
  html += `<summary>${t('preferences.panels')}</summary>`;
  html += `<div class="wm-pref-group-content">`;
  html += toggleRowHtml('us-badge-anim', t('components.insights.badgeAnimLabel'), t('components.insights.badgeAnimDesc'), settings.badgeAnimation);
  html += `</div></details>`;

  // ── Cloud Sync group (web-only, signed-in, feature flag on) ──
  if (!host.isDesktopApp && host.isSignedIn && isCloudSyncEnabled()) {
    const syncState = getSyncState();
    const lastSync = getLastSyncAt();
    const lastSyncStr = lastSync
      ? new Date(lastSync).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
      : 'Never';

    html += `<details class="wm-pref-group">`;
    html += `<summary>Cloud Sync</summary>`;
    html += `<div class="wm-pref-group-content">`;
    html += `<div class="wm-sync-status-row">
      <div class="wm-sync-status-info">
        <span class="wm-sync-status-dot" id="usSyncDot" style="background:${SYNC_STATE_COLORS[syncState] ?? SYNC_STATE_COLORS.error}"></span>
        <span class="wm-sync-status-label" id="usSyncLabel">${SYNC_STATE_LABELS[syncState] ?? 'Unknown'}</span>
        <span class="wm-sync-status-time" id="usSyncTime">Last synced: ${escapeHtml(lastSyncStr)}</span>
      </div>
      <button type="button" class="btn btn-secondary wm-sync-now-btn" id="usSyncNowBtn">Sync now</button>
    </div>`;
    html += `</div></details>`;
  }

  // ── Data & Community group ──
  html += `<details class="wm-pref-group">`;
  html += `<summary>${t('preferences.dataAndCommunity')}</summary>`;
  html += `<div class="wm-pref-group-content">`;
  html += `
    <div class="us-data-mgmt">
      <button type="button" class="btn btn-secondary" id="usExportBtn">${t('components.settings.exportSettings')}</button>
      <button type="button" class="btn btn-secondary" id="usImportBtn">${t('components.settings.importSettings')}</button>
      <input type="file" id="usImportInput" accept=".json" class="us-hidden-input" />
    </div>
    <div class="us-data-mgmt-toast" id="usDataMgmtToast"></div>
  `;
  html += `</div></details>`;

  // AI status footer (web-only)
  if (!host.isDesktopApp) {
    html += `<div class="ai-flow-popup-footer"><span class="ai-flow-status-dot" id="usStatusDot"></span><span class="ai-flow-status-text" id="usStatusText"></span></div>`;
  }

  return {
    html,
    attach(container: HTMLElement): () => void {
      const ac = new AbortController();
      const { signal } = ac;

      window.addEventListener(FONT_SCALE_CHANGED_EVENT, (event) => {
        const select = container.querySelector<HTMLSelectElement>('#us-font-scale');
        const scale = (event as CustomEvent<FontScaleChangedDetail>).detail?.scale;
        if (select && scale !== undefined) select.value = String(scale);
      }, { signal });

      container.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;

        if (target.id === 'usImportInput') {
          const file = target.files?.[0];
          if (!file) return;
          importSettings(file).then((result: ImportResult) => {
            showToast(container, t('components.settings.importSuccess', { count: String(result.keysImported) }), true);
          }).catch(() => {
            showToast(container, t('components.settings.importFailed'), false);
          });
          target.value = '';
          return;
        }

        const saveResult = handlePreferenceChange(target, container, host);
        if (typeof saveResult === 'boolean') {
          if (saveResult) host.onSettingSaved?.();
          return;
        }
        void saveResult.then((saved) => {
          if (saved) host.onSettingSaved?.();
        }).catch(() => undefined);
      }, { signal });

      container.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('#usExportBtn')) {
          try {
            exportSettings();
            showToast(container, t('components.settings.exportSuccess'), true);
          } catch {
            showToast(container, t('components.settings.exportFailed'), false);
          }
          return;
        }
        if (target.closest('#usImportBtn')) {
          container.querySelector<HTMLInputElement>('#usImportInput')?.click();
          return;
        }
      }, { signal });

      if (!host.isDesktopApp) updateAiStatus(container);

      // ── Cloud Sync: wire "Sync now" button + live state updates ──
      if (!host.isDesktopApp && host.isSignedIn && isCloudSyncEnabled()) {
        const syncBtn = container.querySelector<HTMLButtonElement>('#usSyncNowBtn');
        if (syncBtn) {
          syncBtn.addEventListener('click', () => {
            syncBtn.disabled = true;
            syncBtn.textContent = 'Syncing\u2026';
            syncNow().finally(() => {
              syncBtn.disabled = false;
              syncBtn.textContent = 'Sync now';
              updateSyncStatusUI(container);
            });
          }, { signal });
        }
        const syncPollId = setInterval(() => updateSyncStatusUI(container), 2000);
        signal.addEventListener('abort', () => clearInterval(syncPollId));
      }

      return () => ac.abort();
    },
  };
}

function showToast(container: HTMLElement, msg: string, success: boolean): void {
  const toast = container.querySelector('#usDataMgmtToast');
  if (!toast) return;
  toast.className = `us-data-mgmt-toast ${success ? 'ok' : 'error'}`;
  setTrustedHtml(toast, trustedHtml(success
    ? `${escapeHtml(msg)} <a href="#" class="us-toast-reload">${t('components.settings.reloadNow')}</a>`
    : escapeHtml(msg), "legacy direct innerHTML migration"));
  toast.querySelector('.us-toast-reload')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.location.reload();
  });
}
