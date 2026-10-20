import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MapPopup } from '@/components/MapPopup';
import { DataLoaderManager } from '@/app/data-loader';
import type { AppContext } from '@/app/app-context';
import { fetchCableHealth, getCableHealthRecord } from '@/services/cable-health';
import { initTestI18n, tt } from './helpers/i18n.mts';

vi.mock('@/services/cable-health', () => ({ getCableHealthRecord: vi.fn(), fetchCableHealth: vi.fn() }));
beforeAll(initTestI18n);
let popup: MapPopup | undefined;
afterEach(() => { popup?.hide(); document.body.replaceChildren(); });

describe('failure-state displays', () => {
  it('clears renderer cable health when no retained snapshot is available', async () => {
    const setCableHealth = vi.fn();
    const updateFeed = vi.fn();
    const manager = new DataLoaderManager({
      map: { setCableHealth }, statusPanel: { updateFeed },
    } as unknown as AppContext);
    vi.mocked(fetchCableHealth).mockRejectedValue(new Error('Cable health unavailable'));
    await manager.loadCableHealth();
    expect(setCableHealth).toHaveBeenCalledWith({});
    expect(updateFeed).toHaveBeenCalledWith('CableHealth', { status: 'error' });
  });

  it('does not label a cable active without a health record', () => {
    const container = document.createElement('div');
    document.body.append(container);
    popup = new MapPopup(container);
    vi.mocked(getCableHealthRecord).mockReturnValue(undefined);
    popup.show({ type: 'cable', data: { id: 'test-cable', name: 'Test cable', points: [[0, 0], [1, 1]], major: true }, x: 100, y: 100 });
    expect(document.querySelector('.map-popup')?.textContent).toContain(tt('popups.unknown'));
    expect(document.querySelector('.map-popup')?.textContent).not.toContain(tt('popups.cable.active'));
  });
});
