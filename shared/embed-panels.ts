/**
 * Embed panel allowlist.
 *
 * `/embed?panel=` may only render these ids. Keep this module free of browser
 * and server imports so both the embed entry (`src/embed/`) and the map-frame
 * edge handler (`api/embed/map-frame.ts`) share one contract.
 *
 * NucMonitor has no paid plans: every embed gets every layer at one cadence,
 * with no key and no grant.
 *
 * X / tweet bodies are intentionally absent: embeds receive derived facts
 * plus permalinks only. Do not add an X panel that dumps post text.
 */

export const EMBED_PANEL_IDS = ['map'] as const;

export type EmbedPanelId = (typeof EMBED_PANEL_IDS)[number];

/**
 * Every layer an embed may request.
 *
 * Lives here rather than in `src/embed/embed-url.ts` — that module pairs each
 * id with a `keyof MapLayers`, so it imports the app's DOM-facing types and
 * cannot be read from the edge. `embed-url.ts` derives its ids from this list,
 * so the two cannot drift.
 */
export const EMBED_LAYER_IDS = [
  'earthquakes',
  'weather',
  'cables',
  'pipelines',
] as const;

export type EmbedLayerId = (typeof EMBED_LAYER_IDS)[number];

/** Every embed refreshes on this cadence. */
export const EMBED_REFRESH_MS = 10 * 60 * 1000;

/** What an embed panel serves: the layers it may render and how often it polls. */
export interface EmbedPanelPolicy {
  layers: readonly EmbedLayerId[];
  refreshMs: number;
}

export interface EmbedPanelDefinition {
  id: EmbedPanelId;
  label: string;
  policy: EmbedPanelPolicy;
  aliases: readonly string[];
}

export const EMBEDDABLE_PANELS: readonly EmbedPanelDefinition[] = [
  {
    id: 'map',
    label: 'Live Map',
    policy: {
      layers: EMBED_LAYER_IDS,
      refreshMs: EMBED_REFRESH_MS,
    },
    aliases: ['live-map', 'live_map', 'livemap'],
  },
];

export const DEFAULT_EMBED_PANEL_ID: EmbedPanelId = 'map';

const PANEL_BY_TOKEN = new Map<string, EmbedPanelId>();
for (const panel of EMBEDDABLE_PANELS) {
  PANEL_BY_TOKEN.set(panel.id, panel.id);
  for (const alias of panel.aliases) {
    PANEL_BY_TOKEN.set(alias.toLowerCase(), panel.id);
  }
}

const PANEL_DEF_BY_ID = new Map<EmbedPanelId, EmbedPanelDefinition>(
  EMBEDDABLE_PANELS.map((panel) => [panel.id, panel]),
);

const EMBED_LAYER_ID_SET: ReadonlySet<string> = new Set(EMBED_LAYER_IDS);

export function isEmbedPanelId(value: string): value is EmbedPanelId {
  return PANEL_DEF_BY_ID.has(value as EmbedPanelId);
}

export function isEmbedLayerId(value: string): value is EmbedLayerId {
  return EMBED_LAYER_ID_SET.has(value);
}

export function parseEmbedPanelId(value: string | null | undefined): EmbedPanelId | null {
  if (value == null) return DEFAULT_EMBED_PANEL_ID;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_EMBED_PANEL_ID;
  return PANEL_BY_TOKEN.get(trimmed.toLowerCase()) ?? null;
}

export function getEmbedPanelDefinition(id: EmbedPanelId): EmbedPanelDefinition {
  const def = PANEL_DEF_BY_ID.get(id);
  if (!def) throw new Error(`Unknown embed panel: ${id}`);
  return def;
}

export function getEmbedPanelPolicy(id: EmbedPanelId): EmbedPanelPolicy {
  return getEmbedPanelDefinition(id).policy;
}

export function listEmbeddablePanels(): readonly EmbedPanelDefinition[] {
  return EMBEDDABLE_PANELS;
}
