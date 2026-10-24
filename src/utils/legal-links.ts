/**
 * Legal-link markup for the dashboard (#6976): the settings modal's path to
 * the Terms. Deliberately dependency-light (one import, `escapeHtml`), which
 * keeps it reachable from the `tsx --test` unit profile.
 *
 * Links are ABSOLUTE against the web origin. The docs live on worldmonitor.app
 * while the desktop build runs from a Tauri WebView origin, where a
 * root-relative `/docs/terms` resolves inside the app bundle and 404s.
 * `data-legal-link` lets a host attach the `openExternalUrl` handoff that
 * desktop needs (#5911) without this module importing the runtime.
 */
import { escapeHtml } from './sanitize';
import { LEGAL_FOOTER_LINKS, absoluteLegalUrl } from '../../shared/legal';

/** Marks an anchor a host may re-route through the OS browser on desktop. */
export const LEGAL_LINK_ATTR = 'data-legal-link';

function anchor(href: string, label: string, className: string): string {
  return `<a class="${className}" ${LEGAL_LINK_ATTR} href="${escapeHtml(href)}"`
    + ` target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

/**
 * The legal row for the settings modal — the dashboard's shell surface, shown
 * on every tab so the Terms are one click away from anywhere in the app.
 */
export function legalLinksHtml(origin: string): string {
  const links = LEGAL_FOOTER_LINKS
    .map(link => anchor(absoluteLegalUrl(link.path, origin), link.label, 'legal-links-item'))
    .join('');
  return `<nav aria-label="Legal" class="legal-links-row">${links}</nav>`;
}
