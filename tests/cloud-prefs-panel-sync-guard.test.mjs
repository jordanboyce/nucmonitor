import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');

function readSrc(path) {
  return readFileSync(resolve(root, path), 'utf-8');
}

describe('cloud prefs panel sync guardrails', () => {
  it('syncs the real panel order storage keys', () => {
    const syncKeysSrc = readSrc('src/utils/sync-keys.ts');
    const panelLayoutSrc = readSrc('src/app/panel-layout.ts');

    assert.match(
      panelLayoutSrc,
      /saveToStorage\(this\.ctx\.PANEL_ORDER_KEY,\s*allOrder\)/,
      'panel layout must persist unified order at PANEL_ORDER_KEY',
    );
    assert.match(
      panelLayoutSrc,
      /saveToStorage\(this\.ctx\.PANEL_ORDER_KEY \+ '-bottom-set',\s*Array\.from\(this\.bottomSetMemory\)\)/,
      'panel layout must persist bottom placement at PANEL_ORDER_KEY + -bottom-set',
    );
    assert.match(
      syncKeysSrc,
      /'panel-order'/,
      'cloud sync key list must include the actual panel-order key',
    );
    assert.match(
      syncKeysSrc,
      /'panel-order-bottom-set'/,
      'cloud sync key list must include the actual panel bottom-set key',
    );
    assert.doesNotMatch(
      syncKeysSrc,
      /'worldmonitor-panel-order'/,
      'cloud sync must not watch stale worldmonitor-panel-order, which the app never writes',
    );
  });

  it('notifies the running tab when cloud prefs are applied', () => {
    const cloudSyncSrc = readSrc('src/utils/cloud-prefs-sync.ts');
    const appSrc = readSrc('src/App.ts');

    assert.match(
      cloudSyncSrc,
      /export const CLOUD_PREFS_APPLIED_EVENT = 'wm:cloud-prefs-applied'/,
      'cloud prefs sync should expose a same-tab applied event',
    );
    assert.match(
      cloudSyncSrc,
      /dispatchCloudPrefsApplied\(changedKeys, syncVersion\)/,
      'cloud-applied localStorage writes must dispatch changed keys and the cloud version',
    );
    assert.match(
      cloudSyncSrc,
      /applyCloudBlob\(toApply, cloud\.syncVersion\)/,
      'cloud reconciliation must attach the incoming sync version to the applied event',
    );
    assert.match(
      appSrc,
      /window\.addEventListener\(CLOUD_PREFS_APPLIED_EVENT,\s*this\.handleCloudPrefsApplied\)/,
      'App must subscribe to same-tab cloud preference application',
    );
    assert.match(
      appSrc,
      /this\.panelLayout\.applySavedPanelOrder\(\)/,
      'App must reapply synced panel order without waiting for a reload',
    );
    const cloudApplyStart = appSrc.indexOf('private applyCloudSyncedPrefsToRuntime');
    const cloudApplyHandler = appSrc.slice(
      cloudApplyStart,
      appSrc.indexOf('private isPanelNearViewport', cloudApplyStart),
    );
    assert.ok(cloudApplyStart >= 0, 'cloud prefs apply handler must exist');
    assert.match(
      cloudApplyHandler,
      /this\.state\.panelSettings = loadFromStorage<Record<string, PanelConfig>>\([\s\S]*?this\.panelLayout\.applyPanelSettings\(\);\s*this\.state\.unifiedSettings\?\.refreshPanelToggles\(\);/,
      'a cloud panel snapshot must be applied to the mounted dashboard and its controls',
    );
    assert.match(
      cloudApplyHandler,
      /this\.state\.disabledSources = new Set\(loadFromStorage<string\[\]>\(STORAGE_KEYS\.disabledFeeds, \[\]\)\);/,
      'a disabled-feeds cloud generation must reload the live source state',
    );
    // The legacy sweep must stay one-shot per browser: it cannot tell pre-marker
    // gate damage from a deliberate hide, so re-arming it on cloud snapshots
    // (which land on effectively every multi-device sign-in) silently re-enables
    // widgets the user turned off.
    assert.doesNotMatch(
      appSrc,
      /legacyWidgetRecoveryAfterCloudPrefs/,
      'the cloud-prefs re-arm of the one-shot legacy widget sweep must not come back',
    );
    assert.match(
      appSrc,
      /monitorPanel\?\.setMonitors\(this\.state\.monitors\)/,
      'App must update an already-mounted My Monitors panel when cloud prefs change monitors',
    );
    assert.match(
      cloudApplyHandler,
      /void applyVisibleMapDimension\(this\.state, mode === 'globe' \? '3d' : '2d'\)/,
      'cloud map-mode changes must reconcile renderer, application layer state, and persistence through the visible control path',
    );
    assert.doesNotMatch(
      cloudApplyHandler,
      /this\.state\.map\?\.switchTo(?:Globe|Flat)\(\)/,
      'cloud map-mode changes must not bypass application layer-state reconciliation',
    );
    assert.match(
      appSrc,
      /const panelOrderKey = this\.state\.PANEL_ORDER_KEY;/,
      'App must derive the panel order key from PANEL_ORDER_KEY',
    );
    assert.match(
      appSrc,
      /keySet\.has\(panelOrderKey\) \|\| keySet\.has\(`\$\{panelOrderKey\}-bottom-set`\)/,
      'App must derive the bottom-set key from PANEL_ORDER_KEY',
    );
    assert.doesNotMatch(
      appSrc,
      /keySet\.has\('panel-order'\)/,
      'App must not hard-code the panel-order key in the cloud apply path',
    );
  });

  it('persists dirty cloud preference keys across reloads until upload settles', () => {
    const cloudSyncSrc = readSrc('src/utils/cloud-prefs-sync.ts');

    assert.match(
      cloudSyncSrc,
      /const KEY_DIRTY_KEYS = 'wm-cloud-prefs-dirty-keys'/,
      'cloud prefs sync must store pending dirty-key metadata outside the uploaded blob',
    );
    assert.match(
      cloudSyncSrc,
      /hydrateDirtyKeysFromStorage\(userId\);/,
      'cloud prefs sync must restore dirty keys for the signed-in user before resolving sign-in conflicts',
    );
    assert.match(
      cloudSyncSrc,
      /userId: _dirtyKeysUserId,[\s\S]*keys: \[\.\.\._dirtyKeys\]/,
      'persisted dirty-key metadata must be scoped to the user that made the edit',
    );
    assert.doesNotMatch(
      cloudSyncSrc,
      /export function install[\s\S]*hydrateDirtyKeysFromStorage\(/,
      'cloud prefs sync must not restore ownerless dirty keys at install time',
    );
    assert.match(
      cloudSyncSrc,
      /markDirtyKey\(key as CloudSyncKey\);/,
      'local pref writes must persist their dirty-key marker before debounce upload',
    );
    assert.match(
      cloudSyncSrc,
      /function markDirtyKey\(key: CloudSyncKey\): void \{\s*_dirtyKeys\.add\(key\);\s*persistDirtyKeyAddition\(key\);\s*\}/,
      'marking a key dirty must union into the persisted set so concurrent same-user tabs cannot clobber each other (#4746)',
    );
    assert.match(
      cloudSyncSrc,
      /if \(settled\.length > 0\) persistSettledDirtyKeyRemovals\(settled\);/,
      'successful uploads must clear only the dirty keys that actually settled, by targeted removal — never a wholesale overwrite (#4746)',
    );
    assert.match(
      cloudSyncSrc,
      // Accessor-agnostic on purpose: #7833 moved this module onto
      // safeStorageRemove, and pinning a spelling just re-breaks on the next
      // migration. What this pins is the ORDER — the empty-set delete has to
      // happen before the ownerless bail.
      /if \(_dirtyKeys\.size === 0\) \{[\s\S]*(?:safeStorageRemove|rawRemove|Storage\.prototype\.removeItem\.call)\([^)]*KEY_DIRTY_KEYS[^)]*\);[\s\S]*return;[\s\S]*\}[\s\S]*if \(!_dirtyKeysUserId\) return;/,
      'ownerless dirty writes before sign-in must not delete the previous persisted dirty-key marker',
    );
    assert.match(
      cloudSyncSrc,
      /const preservePersistedDirtyKeys = _syncOperations\.busy && _dirtyKeys\.size > 0;[\s\S]*_dirtyKeys\.clear\(\);\s*if \(!preservePersistedDirtyKeys\) persistDirtyKeys\(\);\s*_dirtyKeysUserId = null;/,
      'sign-out must retain user-scoped dirty metadata only when an interrupted writer still needs recovery',
    );
  });

  it('does not clear/persist settled dirty keys after a mid-upload account switch', () => {
    const cloudSyncSrc = readSrc('src/utils/cloud-prefs-sync.ts');

    assert.match(
      cloudSyncSrc,
      /if \(_authGeneration !== myGeneration\) return 'stopped';[\s\S]*clearSettledDirtyKeys\(postedBlob\)/,
      'uploadNow success branch must bail before clearing settled dirty keys when the auth generation advanced (sign-out / account switch mid-upload)',
    );
    assert.match(
      cloudSyncSrc,
      /if \(_authGeneration !== callerGeneration\) return false;[\s\S]*clearSettledDirtyKeys\(merged\)/,
      'resolveConflictWithMerge must bail before clearing settled dirty keys when the caller auth generation advanced',
    );
  });
});
