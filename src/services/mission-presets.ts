import type { MapLayers, PanelConfig } from '@/types';
import {
  ALL_PANELS,
  DEFAULT_MAP_LAYERS,
  DEFAULT_PANELS,
  VARIANT_DEFAULTS,
  getEffectivePanelConfig,
} from '@/config/panels';
import { SITE_VARIANT } from '@/config/variant';
import { isLayerExecutable, sanitizeLayersForVariant } from '@/config/map-layer-definitions';
import type { RendererKind, MapVariant } from '@/config/map-layer-definitions';
import {
  type MissionPresetId,
  parseMissionPresetId,
} from '../../shared/mission-domain';

export type { MissionPresetId } from '../../shared/mission-domain';

export const MISSION_PRESET_STORAGE_KEY = 'worldmonitor-mission-preset-v1';
export const MISSION_PRESET_DISMISSED_KEY = 'worldmonitor-mission-preset-dismissed-v1';

export type MissionMapView = 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania';
export type MissionTimeRange = '1h' | '6h' | '24h' | '48h' | '7d' | 'all';

export interface MissionPreset {
  id: MissionPresetId;
  label: string;
  shortLabel: string;
  description: string;
  icon: string;
  view: MissionMapView;
  zoom?: number;
  timeRange: MissionTimeRange;
  panels: string[];
  layers: Array<keyof MapLayers>;
  /** When set, the preset is offered and applicable only on these variants. */
  variants?: string[];
  /** Explicit layouts for variants where the base mission has no coherent native intersection. */
  variantOverrides?: Partial<Record<string, Pick<MissionPreset, 'panels' | 'layers'>>>;
}

export interface AppliedMissionPreset {
  preset: MissionPreset;
  panelSettings: Record<string, PanelConfig>;
  panelOrder: string[];
  mapLayers: MapLayers;
}

export interface ResetMissionPresetState {
  panelSettings: Record<string, PanelConfig>;
  panelOrder: string[];
  mapLayers: MapLayers;
}

export const MISSION_PRESETS: readonly MissionPreset[] = [
  {
    id: 'nuclear-hub',
    label: 'Nuclear Facilities',
    shortLabel: 'Nuclear',
    description: 'US nuclear sites, NRC reactor status, radiation, and every hazard feed that can touch a plant.',
    icon: 'N',
    view: 'america',
    zoom: 3.2,
    timeRange: '7d',
    panels: [
      'map',
      'nuclear-reactor-status',
      'nuclear-events',
      'nuclear-hazards',
      'nuclear-facilities',
      'radiation-watch',
      'satellite-fires',
      'climate',
      'live-news',
    ],
    layers: [
      'usNuclearFacilities',
      'radiationWatch',
      'natural',
      'weather',
      'fires',
      'outages',
    ],
    variants: ['nuclear'],
  },
];

const DYNAMIC_PANEL_PREFIXES = ['cw-', 'mcp-'];
const MIN_PRESET_PANEL_MATCHES = 2;
const missionPresetListeners = new Set<(preset: MissionPreset | null) => void>();
let storageDeniedMissionState: MissionPresetId | null | undefined;

const isDynamicPanel = (key: string): boolean =>
  key === 'runtime-config' || DYNAMIC_PANEL_PREFIXES.some((prefix) => key.startsWith(prefix));

const getVariantDefaultPanels = (variant: string): string[] =>
  VARIANT_DEFAULTS[variant] ?? VARIANT_DEFAULTS.nuclear ?? [];

const hasAnyActiveLayer = (layers: MapLayers): boolean =>
  Object.values(layers).some(Boolean);

const withMapPanel = (panels: string[]): string[] => {
  const ordered = ['map', ...panels.filter((key) => key !== 'map')];
  return Array.from(new Set(ordered));
};

export function getMissionPreset(id: string | null | undefined): MissionPreset | null {
  if (!id) return null;
  return MISSION_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function resolveMissionPresetForVariant(
  preset: MissionPreset,
  variant: string,
): Pick<MissionPreset, 'panels' | 'layers'> {
  return preset.variantOverrides?.[variant] ?? preset;
}

export function isMissionPresetAvailableForVariant(
  preset: MissionPreset,
  variant: string,
): boolean {
  if (!preset.variants || preset.variants.length === 0) return true;
  return preset.variants.includes(variant);
}

export function getMissionPresetsForVariant(variant: string = SITE_VARIANT): readonly MissionPreset[] {
  return MISSION_PRESETS.filter((preset) => isMissionPresetAvailableForVariant(preset, variant));
}

export function loadStoredMissionPreset(variant: string = SITE_VARIANT): MissionPreset | null {
  if (storageDeniedMissionState !== undefined) {
    const preset = storageDeniedMissionState ? getMissionPreset(storageDeniedMissionState) : null;
    return preset && isMissionPresetAvailableForVariant(preset, variant) ? preset : null;
  }
  try {
    const preset = getMissionPreset(parseMissionPresetId(localStorage.getItem(MISSION_PRESET_STORAGE_KEY)));
    if (!preset || !isMissionPresetAvailableForVariant(preset, variant)) return null;
    return preset;
  } catch {
    return null;
  }
}

export function saveMissionPreset(id: MissionPresetId): void {
  try {
    localStorage.setItem(MISSION_PRESET_STORAGE_KEY, id);
    localStorage.setItem(MISSION_PRESET_DISMISSED_KEY, '1');
    storageDeniedMissionState = undefined;
  } catch {
    storageDeniedMissionState = id;
  }
  notifyMissionPresetListeners(getMissionPreset(id));
}

export function clearMissionPreset(): void {
  try {
    localStorage.removeItem(MISSION_PRESET_STORAGE_KEY);
    localStorage.setItem(MISSION_PRESET_DISMISSED_KEY, '1');
    storageDeniedMissionState = undefined;
  } catch {
    storageDeniedMissionState = null;
  }
  notifyMissionPresetListeners(null);
}

function notifyMissionPresetListeners(preset: MissionPreset | null): void {
  for (const listener of missionPresetListeners) {
    try {
      listener(preset);
    } catch {
      // A consumer cannot interrupt mission application or another consumer.
    }
  }
}

export function onMissionPresetChange(
  listener: (preset: MissionPreset | null) => void,
): () => void {
  missionPresetListeners.add(listener);
  return () => missionPresetListeners.delete(listener);
}

export function isMissionPresetPromptDismissed(): boolean {
  try {
    return localStorage.getItem(MISSION_PRESET_DISMISSED_KEY) === '1';
  } catch {
    return true;
  }
}

export function dismissMissionPresetPrompt(): void {
  try {
    localStorage.setItem(MISSION_PRESET_DISMISSED_KEY, '1');
  } catch {
    // Ignore storage failures.
  }
}

export function applyMissionPresetToState(
  presetId: MissionPresetId,
  currentPanelSettings: Record<string, PanelConfig>,
  defaultLayers: MapLayers = DEFAULT_MAP_LAYERS,
  variant: string = SITE_VARIANT,
): AppliedMissionPreset {
  const preset = getMissionPreset(presetId);
  if (!preset) throw new Error(`Unknown mission preset: ${presetId}`);
  if (!isMissionPresetAvailableForVariant(preset, variant)) {
    throw new Error(`Mission preset ${presetId} is not available on this variant`);
  }

  const resolvedPreset = resolveMissionPresetForVariant(preset, variant);
  const variantPanels = getVariantDefaultPanels(variant);
  const variantPanelSet = new Set(variantPanels);
  const matchingPresetPanels = resolvedPreset.panels.filter((key) => key !== 'map' && variantPanelSet.has(key));
  const useVariantDefaultPanels = matchingPresetPanels.length < MIN_PRESET_PANEL_MATCHES;
  const selectedPanels = useVariantDefaultPanels
    ? withMapPanel(variantPanels)
    : resolvedPreset.panels.filter((key) => key === 'map' || variantPanelSet.has(key));
  const selectedPanelSet = new Set(selectedPanels);
  const nextPanelSettings: Record<string, PanelConfig> = {};
  const allKeys = new Set([
    ...Object.keys(DEFAULT_PANELS),
    ...Object.keys(ALL_PANELS),
    ...Object.keys(currentPanelSettings),
    ...selectedPanels,
  ]);

  for (const key of allKeys) {
    const current = currentPanelSettings[key];
    const resolved = ALL_PANELS[key] ? getEffectivePanelConfig(key, variant) : current;
    if (!resolved) continue;

    if (isDynamicPanel(key)) {
      nextPanelSettings[key] = { ...resolved };
      continue;
    }

    const isKnownPanel = key === 'map' || !!ALL_PANELS[key] || !!current;
    if (!isKnownPanel) continue;

    const shouldEnable = selectedPanelSet.has(key);
    let enabled = shouldEnable;
    if (key === 'map') {
      enabled = true;
    } else if (useVariantDefaultPanels) {
      enabled = shouldEnable && resolved.enabled !== false;
    }

    nextPanelSettings[key] = {
      ...resolved,
      enabled,
    };
  }

  const candidateLayers: MapLayers = { ...defaultLayers };
  for (const key of Object.keys(candidateLayers) as Array<keyof MapLayers>) {
    candidateLayers[key] = false;
  }
  for (const key of resolvedPreset.layers) {
    candidateLayers[key] = true;
  }

  let mapLayers = sanitizeLayersForVariant(candidateLayers, variant as MapVariant);
  if (!hasAnyActiveLayer(mapLayers)) {
    mapLayers = sanitizeLayersForVariant({ ...defaultLayers }, variant as MapVariant);
  }

  return {
    preset,
    panelSettings: nextPanelSettings,
    panelOrder: selectedPanels.filter((key) => key !== 'map'),
    mapLayers,
  };
}

export function resetMissionPresetState(
  currentPanelSettings: Record<string, PanelConfig>,
  defaultLayers: MapLayers = DEFAULT_MAP_LAYERS,
  variant: string = SITE_VARIANT,
): ResetMissionPresetState {
  const variantPanels = VARIANT_DEFAULTS[variant] ?? VARIANT_DEFAULTS.nuclear ?? [];
  const variantPanelSet = new Set(variantPanels);
  const nextPanelSettings: Record<string, PanelConfig> = {};
  const allKeys = new Set([
    ...Object.keys(DEFAULT_PANELS),
    ...Object.keys(ALL_PANELS),
    ...Object.keys(currentPanelSettings),
  ]);

  for (const key of allKeys) {
    const current = currentPanelSettings[key];
    const resolved = ALL_PANELS[key] ? getEffectivePanelConfig(key, variant) : current;
    if (!resolved) continue;
    if (isDynamicPanel(key)) {
      nextPanelSettings[key] = { ...resolved };
      continue;
    }
    nextPanelSettings[key] = {
      ...resolved,
      enabled: key === 'map' || (variantPanelSet.has(key) && resolved.enabled !== false),
    };
  }

  return {
    panelSettings: nextPanelSettings,
    panelOrder: variantPanels.filter((key) => key !== 'map'),
    mapLayers: sanitizeLayersForVariant({ ...defaultLayers }, variant as MapVariant),
  };
}

export function filterMissionLayersForRenderer(
  layers: MapLayers,
  kind: RendererKind,
  fallbackLayers: MapLayers = DEFAULT_MAP_LAYERS,
): MapLayers {
  const filter = (candidateLayers: MapLayers): MapLayers => {
    const next = { ...candidateLayers };
    for (const key of Object.keys(next) as Array<keyof MapLayers>) {
      if (next[key] && !isLayerExecutable(key, kind)) {
        next[key] = false;
      }
    }
    return next;
  };

  const next = filter(layers);
  return hasAnyActiveLayer(next) ? next : filter(fallbackLayers);
}
