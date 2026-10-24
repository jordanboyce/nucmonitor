// A cloud row that OMITS a synced key normally means "the user cleared it",
// and applyCloudBlob deletes the local value. That rule is wrong for keys
// added after older clients shipped (rolling-deployment-safe keys): every row
// written before they existed lacks them, as does every upload from an older
// tab.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ABSENCE_TOLERANT_SYNC_KEYS,
  CLOUD_SYNC_KEYS,
  resolveCloudBlobKeyAction,
} from '../src/utils/sync-keys.ts';

const FONT_SCALE = 'wm-font-scale';
const LIVE_MEDIA_IDLE_STOP = 'wm-live-media-idle-stop';

describe('cloud blob absent-key tolerance', () => {

  it('still deletes an ordinary preference the row omits', () => {
    // The absence rule must stay intact for keys the user can genuinely clear,
    // otherwise a cleared preference would resurrect on every sign-in.
    assert.deepEqual(
      resolveCloudBlobKeyAction('worldmonitor-monitors', {}),
      { kind: 'remove' },
    );
    assert.deepEqual(
      resolveCloudBlobKeyAction('worldmonitor-disabled-feeds', {}),
      { kind: 'remove' },
    );
  });

  it('keeps font scale when an older client omits the new preference', () => {
    assert.deepEqual(
      resolveCloudBlobKeyAction(FONT_SCALE, { 'worldmonitor-theme': 'dark' }),
      { kind: 'keep' },
    );
  });

  it('applies an explicit 100% font scale reset', () => {
    assert.deepEqual(
      resolveCloudBlobKeyAction(FONT_SCALE, { [FONT_SCALE]: '1' }),
      { kind: 'set', value: '1' },
    );
  });

  it('tolerates absence only for rolling-deployment-safe keys', () => {
    // Pins the blast radius: each key in this set must have an explicit reset
    // representation, so preserving omission cannot resurrect cleared state.
    assert.deepEqual(
      [...ABSENCE_TOLERANT_SYNC_KEYS].sort(),
      [FONT_SCALE, LIVE_MEDIA_IDLE_STOP].sort(),
    );
    for (const key of ABSENCE_TOLERANT_SYNC_KEYS) {
      assert.ok(
        CLOUD_SYNC_KEYS.includes(key),
        `${key} must be a real cloud-sync key`,
      );
    }
  });

  it('leaves every other synced key deletable on absence', () => {
    const notDeletable = CLOUD_SYNC_KEYS.filter(
      (key) => resolveCloudBlobKeyAction(key, {}).kind !== 'remove',
    );
    assert.deepEqual(
      notDeletable.sort(),
      [FONT_SCALE, LIVE_MEDIA_IDLE_STOP].sort(),
    );
  });
});
