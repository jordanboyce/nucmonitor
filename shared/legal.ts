/**
 * Canonical legal-document identity, shared by the dashboard (`src/`) and
 * Convex (`convex/users.ts`, which stamps the accepted version onto the user
 * record). Pure data: no DOM, no Node, no Convex imports.
 *
 * NucMonitor's legal text is deliberately short placeholder copy for the demo
 * deployment (public/legal/*.html). Replace it with reviewed documents before
 * a partner pilot, and bump TERMS_VERSION when the text changes so a stored
 * acceptance always names the text that was shown.
 */

/** ISO date of the current legal documents; the value stamped onto `users.termsVersion`. */
export const TERMS_VERSION = '2026-10-20';

export const TERMS_PATH = '/legal/terms';
export const PRIVACY_PATH = '/legal/privacy';
/** The AGPL-3.0 source license. */
export const LICENSE_PATH = '/legal/license';
/**
 * There is no separate end-user license agreement or data processing
 * addendum yet: the Terms carry the licence to use the service, and the
 * Privacy page describes processing. Both aliases point there so every
 * surface that links "the licence" resolves to a real page.
 */
export const EULA_PATH = TERMS_PATH;
export const DPA_PATH = `${PRIVACY_PATH}#data-processing`;
export const TRADEMARK_PATH = LICENSE_PATH;

/** The legal cluster every footer carries. */
export const LEGAL_FOOTER_LINKS: ReadonlyArray<{ label: string; path: string }> = [
  { label: 'Terms', path: TERMS_PATH },
  { label: 'Privacy', path: PRIVACY_PATH },
  { label: 'Source license', path: LICENSE_PATH },
];

/** Where the text behind any recorded version can be read back. */
export function legalHistoryUrl(docPath: string): string {
  return `https://github.com/jordanboyce/nucmonitor/commits/main/${docPath}`;
}

/**
 * Assent copy, in parts, so DOM builders and HTML templates render the same
 * sentence with real anchors. English literals on purpose.
 */
export const CHECKOUT_CONSENT_LEAD = 'By creating an account you agree to the';
export const CHECKOUT_CONSENT_LICENSE_LABEL = 'Terms';
export const CHECKOUT_CONSENT_CONJUNCTION = 'and';
export const CHECKOUT_CONSENT_PRIVACY_LABEL = 'Privacy Policy';

/** Plain-text form, for anywhere that cannot host anchors (aria labels, tests). */
export const CHECKOUT_CONSENT_TEXT =
  `${CHECKOUT_CONSENT_LEAD} ${CHECKOUT_CONSENT_LICENSE_LABEL} ${CHECKOUT_CONSENT_CONJUNCTION} ${CHECKOUT_CONSENT_PRIVACY_LABEL}.`;

/**
 * Absolute variants for surfaces that are not served from the web origin.
 * With an empty origin the path is returned as-is (same-origin link).
 */
export function absoluteLegalUrl(path: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}${path}`;
}
