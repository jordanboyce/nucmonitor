export interface MapLayerRuntimeAvailability {
  outagesAvailable: boolean;
}

export type MapLayerRuntimeUnavailableReason =
  | 'layer_not_live'
  | 'layer_feature_disabled'
  | 'layer_not_configured';

export const ALL_MAP_LAYERS_RUNTIME_AVAILABLE: MapLayerRuntimeAvailability = {
  outagesAvailable: true,
};

export function resolveMapLayerRuntimeUnavailableReason(
  layerKey: string,
  presentInMapLayers: boolean,
  availability: MapLayerRuntimeAvailability,
): MapLayerRuntimeUnavailableReason | undefined {
  if (layerKey === 'outages' && !availability.outagesAvailable) {
    return 'layer_not_configured';
  }
  if (!presentInMapLayers) return 'layer_not_live';
  return undefined;
}
