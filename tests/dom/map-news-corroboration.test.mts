/**
 * #9213: map popups state a news event's corroboration — the story marker on
 * every map (flat map popup, 3D-flat tooltip, globe tooltip) and the related
 * headlines in a hotspot popup. The verdict is assessCorroboration's, the one
 * the News panel shows for the same cluster. Coverage, not accuracy.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DeckGLMap } from '@/components/DeckGLMap';
import { GlobeMap } from '@/components/GlobeMap';
import { MapPopup } from '@/components/MapPopup';
import type { NewsLocationMarker } from '@/types';
import { corroborationLabel } from '@/utils/corroboration-flag';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);
afterEach(() => {
  document.body.innerHTML = '';
});

const single = { state: 'single-publisher', publishers: 1 } as const;
const corroborated = { state: 'corroborated', publishers: 4 } as const;
const tier4 = { state: 'tier4-only', publishers: 2 } as const;

const marker = (corroboration?: NewsLocationMarker['corroboration']): NewsLocationMarker => ({
  lat: 1, lon: 2, title: 'Port strike halts container traffic', threatLevel: 'high',
  ...(corroboration ? { corroboration } : {}),
});

describe('corroborationLabel', () => {
  it('names every known state and stays silent for unknown', () => {
    expect(corroborationLabel(single)?.text).toBe('Single publisher');
    expect(corroborationLabel(tier4)?.text).toBe('Low-tier sources only');
    expect(corroborationLabel(corroborated)?.text).toBe('4 publishers');
    expect(corroborationLabel({ state: 'unknown' })).toBeNull();
    expect(corroborationLabel(single)?.hint).toMatch(/coverage, not accuracy/);
  });
});

describe('news marker popups', () => {
  const deckTooltip = (DeckGLMap.prototype as unknown as { getTooltip(info: unknown): { html: string } }).getTooltip;

  it('3D-flat map tooltip', () => {
    const host = document.createElement('div');
    host.innerHTML = deckTooltip.call({}, { layer: { id: 'news-locations-layer' }, object: marker(single) }).html;
    expect(host.querySelector('.corroboration-flag')?.textContent).toBe('Single publisher');
    host.innerHTML = deckTooltip.call({}, { layer: { id: 'news-locations-layer' }, object: marker() }).html;
    expect(host.querySelector('.corroboration-flag')).toBeNull();
  });

  it('flat map popup', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const popup = new MapPopup(container);
    popup.show({ type: 'news', data: marker(corroborated), x: 10, y: 10 });
    expect(document.querySelector('.map-popup .corroboration-flag')?.textContent).toBe('4 publishers');
    popup.hide();
  });

  it('globe tooltip', () => {
    const container = document.createElement('div');
    const anchor = document.createElement('button');
    container.appendChild(anchor);
    document.body.appendChild(container);
    const host = {
      container, popup: null, tooltipEl: null as HTMLElement | null, tooltipHideTimer: null,
      hideTooltip() { host.tooltipEl?.remove(); host.tooltipEl = null; },
    };
    const show = (GlobeMap.prototype as unknown as { showMarkerTooltip(m: unknown, a: HTMLElement): void }).showMarkerTooltip;
    show.call(host, { _kind: 'newsLocation', _lat: 1, _lng: 2, id: 'n', title: 'Chip export rumour', threatLevel: 'info', corroboration: tier4 }, anchor);
    expect(host.tooltipEl?.querySelector('.corroboration-flag')?.textContent).toBe('Low-tier sources only');
  });

  it('globe markers carry the verdict from setNewsLocations', () => {
    const host = { newsLocationMarkers: [] as unknown[], flushMarkers() {} };
    const set = (GlobeMap.prototype as unknown as { setNewsLocations(d: unknown[]): void }).setNewsLocations;
    set.call(host, [marker(single)]);
    expect(host.newsLocationMarkers).toEqual([expect.objectContaining({ corroboration: single })]);
  });
});
