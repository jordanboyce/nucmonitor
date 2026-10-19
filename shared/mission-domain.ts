export const MISSION_PRESET_IDS = [
  'nuclear-hub',
  'osint-newsroom',
  'macro-market-watch',
] as const;

export type MissionPresetId = (typeof MISSION_PRESET_IDS)[number];

const MISSION_PRESET_ID_SET = new Set<string>(MISSION_PRESET_IDS);

export function parseMissionPresetId(value: unknown): MissionPresetId | null {
  return typeof value === 'string' && MISSION_PRESET_ID_SET.has(value)
    ? value as MissionPresetId
    : null;
}
