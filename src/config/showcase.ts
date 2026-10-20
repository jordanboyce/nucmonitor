/**
 * Showcase scenario switch (docs/showcase-mode.md).
 *
 * `VITE_SHOWCASE_SCENARIO=1` at build time replaces the live hazard feeds with
 * a fixed, clearly labeled sample scenario so a demo never depends on what the
 * weather or the USGS happen to be doing. The NRC panels stay live and gain a
 * few labeled sample events. Every sample item carries "SAMPLE" in its text
 * and the dashboard banner says the data is simulated.
 *
 * Pure config: no imports, readable by node tests and the server.
 */

// `import.meta.env` only exists under Vite; node test runners see undefined.
const env: Partial<ImportMetaEnv> = import.meta.env ?? {};

const raw = String(env.VITE_SHOWCASE_SCENARIO ?? '').trim().toLowerCase();

/** True when the build was made with `VITE_SHOWCASE_SCENARIO=1|true|on|yes`. */
export const SHOWCASE_SCENARIO_ENABLED = raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';

/** Marker carried by every sample record's title or summary. */
export const SHOWCASE_SAMPLE_TAG = 'SAMPLE';

/** One-line description used by the banner, the demo script and the docs. */
export const SHOWCASE_SCENARIO_TITLE =
  'Hurricane Marisol on the Louisiana coast, an M5.4 earthquake off Diablo Canyon, and a wildfire in the Jemez near Los Alamos';
