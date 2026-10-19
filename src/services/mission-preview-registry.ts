import type { MissionPresetId } from './mission-presets';

/**
 * Release 1 of the mission conversion funnel: one contextual Pro preview per
 * treated mission, placed inside the panel that already holds that mission's
 * gated depth. This registry is the rollback switch — removing an entry
 * removes that mission's preview and nothing else (plan KTD3/R15; no
 * feature-flag infrastructure exists, so a code entry plus the normal deploy
 * pipeline is the honest rollback mechanism).
 *
 * crisis-desk is deliberately absent: its preview is the ResilienceWidget
 * locked state that already ships inside `cii` (KTD7 — instrumentation only).
 * The untouched comparison missions (tech-ai-watch, good-news-explorer) and
 * Country Watcher (whose conversion moment is the follow cap) must never gain
 * entries in Release 1 — the before/after read depends on it.
 */
export interface MissionPreviewSpec {
  /** Panel that hosts the preview, rendered after its free content (R6). */
  panelKey: string;
  /** Stable id: dismissal persistence key + analytics preview identity. */
  previewId: string;
  /** One line stating what unlocks (R7). */
  unlockCopy: string;
  /** Static, shape-only sample — never live premium data (KTD2). */
  renderSample: () => HTMLElement;
}

export const MISSION_PREVIEW_REGISTRY: Partial<Record<MissionPresetId, MissionPreviewSpec>> = {};

/**
 * The single lookup the wiring seam uses: a preview exists only when the
 * ACTIVE mission's registry entry targets exactly this panel. Everything else
 * — no mission, an untreated mission, the wrong panel — resolves to null,
 * which is what keeps R8's one-invitation rule structural.
 */
export function resolveMissionPreview(
  activeMissionId: string | null,
  panelKey: string,
): (MissionPreviewSpec & { missionId: string }) | null {
  if (!activeMissionId) return null;
  const spec = MISSION_PREVIEW_REGISTRY[activeMissionId as MissionPresetId];
  if (!spec || spec.panelKey !== panelKey) return null;
  return { ...spec, missionId: activeMissionId };
}

/** The surface panel-layout needs from a live preview instance. */
export interface MissionPreviewHandle {
  getElement(): HTMLElement;
  getPreviewId(): string;
  destroy(): void;
}

/**
 * The sync core, extracted so the lifecycle (create / no-op / replace on a
 * mismatched preview / destroy when no longer targeted) is unit-testable and
 * the component construction stays injected — services must not import
 * components (boundary rule), and panel-layout supplies the factory.
 */
export function syncPanelPreview(
  previews: Map<string, MissionPreviewHandle>,
  key: string,
  host: HTMLElement,
  activeMissionId: string | null,
  create: (spec: MissionPreviewSpec & { missionId: string }) => MissionPreviewHandle,
): void {
  const spec = resolveMissionPreview(activeMissionId, key);
  const existing = previews.get(key);
  if (!spec) {
    if (existing) {
      existing.destroy();
      previews.delete(key);
    }
    return;
  }
  if (existing) {
    if (existing.getPreviewId() === spec.previewId) return;
    existing.destroy();
    previews.delete(key);
  }
  const preview = create(spec);
  host.appendChild(preview.getElement());
  previews.set(key, preview);
}
