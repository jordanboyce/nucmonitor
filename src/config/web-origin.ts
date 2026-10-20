/**
 * Canonical https origin of the NucMonitor web app, used wherever a link must
 * be absolute (a saved report, the desktop WebView, a mailto body).
 *
 * Set `VITE_WEB_APP_ORIGIN` (for example `https://nucmonitor.example`) at
 * build time. When unset, links stay root-relative, which is right for the
 * web deployment itself.
 *
 * Dependency-free on purpose: consumers span `config`, `services`,
 * `components` and `utils`, and node tests import it without Vite.
 */
const env: Partial<ImportMetaEnv> = import.meta.env ?? {};

export const WEB_APP_ORIGIN = String(env.VITE_WEB_APP_ORIGIN ?? '').trim().replace(/\/+$/, '');
