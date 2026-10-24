/**
 * Boot-time access gate (docs/partner-access.md).
 *
 * Partner mode: runs before the dashboard is imported. It resolves only once a
 * signed-in partner has a session; otherwise it leaves a sign-in, request-
 * access or retry screen in place and the app never boots, so no data request
 * is made for an outsider.
 *
 * Demo mode: adds a slim banner saying the dashboard is a demo of public data.
 */
import '@/styles/access-gate.css';
import { PARTNER_CONTACT_EMAIL } from '@/config/access-mode';
import { SHOWCASE_SCENARIO_ENABLED, SHOWCASE_SCENARIO_TITLE } from '@/config/showcase';
import { toApiUrl } from '@/services/runtime';
import { h, replaceChildren } from '@/utils/dom-utils';

type GateVerdict = 'granted' | 'sign-in' | 'request-access' | 'unavailable';

const PRODUCT_NAME = 'NucMonitor';

function renderScreen(host: HTMLElement, title: string, body: string, ...actions: HTMLElement[]): void {
  const screen = h('main', { className: 'access-gate', role: 'main', 'aria-live': 'polite' },
    h('div', { className: 'access-gate-card' },
      h('div', { className: 'access-gate-brand' }, PRODUCT_NAME),
      h('h1', { className: 'access-gate-title' }, title),
      h('p', { className: 'access-gate-body' }, body),
      ...(actions.length ? [h('div', { className: 'access-gate-actions' }, ...actions)] : []),
    ),
  );
  replaceChildren(host, screen);
}

function button(label: string, onClick: () => void, primary = true): HTMLElement {
  const el = h('button', { type: 'button', className: primary ? 'access-gate-btn primary' : 'access-gate-btn' }, label);
  el.addEventListener('click', onClick);
  return el;
}

function contactLink(email: string): HTMLElement | null {
  if (!PARTNER_CONTACT_EMAIL) return null;
  const subject = encodeURIComponent(`${PRODUCT_NAME} partner access request`);
  const body = encodeURIComponent(email ? `Please grant ${PRODUCT_NAME} access to ${email}.` : '');
  return h('a', {
    className: 'access-gate-btn primary',
    href: `mailto:${PARTNER_CONTACT_EMAIL}?subject=${subject}&body=${body}`,
  }, 'Request access');
}

/** Ask the edge to mint a session for this partner; the verdict maps to a screen. */
async function requestSession(token: string): Promise<GateVerdict> {
  try {
    const resp = await fetch(toApiUrl('/api/wm-session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      credentials: 'include',
      body: '{}',
    });
    if (resp.ok) return 'granted';
    if (resp.status === 401) return 'sign-in';
    if (resp.status === 403) return 'request-access';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * Resolve once the visitor is an authorized partner. Never resolves otherwise:
 * the gate screen stays up and each action reloads the page to re-check.
 */
export async function runPartnerGate(host: HTMLElement): Promise<void> {
  renderScreen(host, 'Checking access…', 'One moment while we confirm your partner access.');

  const clerk = await import('@/services/clerk');
  if (!clerk.isClerkAuthEnabled()) {
    renderScreen(host, 'Sign-in is not configured',
      'This deployment requires partner sign-in, but no identity provider is configured. Contact your administrator.');
    return new Promise(() => {});
  }
  try {
    await clerk.initClerk();
  } catch {
    renderScreen(host, 'Sign-in could not load',
      'The sign-in service did not respond. Check your connection and try again.',
      button('Try again', () => window.location.reload()));
    return new Promise(() => {});
  }

  const user = clerk.getCurrentClerkUser();
  const token = user ? await clerk.getClerkToken() : null;
  const verdict: GateVerdict = token ? await requestSession(token) : 'sign-in';

  if (verdict === 'granted') {
    // Every later session refresh must carry the partner's bearer too.
    const { setWmSessionMintAuthProvider } = await import('@/services/wm-session');
    setWmSessionMintAuthProvider(() => clerk.getClerkToken());
    return;
  }

  if (verdict === 'sign-in') {
    clerk.subscribeClerk(() => {
      if (clerk.getCurrentClerkUser()) window.location.reload();
    });
    renderScreen(host, 'Partner sign-in',
      `${PRODUCT_NAME} is available to invited industry partners. Sign in with your work email to continue.`,
      button('Sign in', () => clerk.openSignIn()));
  } else if (verdict === 'request-access') {
    const email = user?.email ?? '';
    const request = contactLink(email);
    renderScreen(host, 'Access not yet granted',
      `${email || 'This account'} is not on the partner list for this deployment. `
        + (PARTNER_CONTACT_EMAIL ? 'Ask for access and we will add you.' : 'Ask your administrator to invite you.'),
      ...(request ? [request] : []),
      button('Sign out', () => { void clerk.signOut().then(() => window.location.reload()); }, false));
  } else {
    renderScreen(host, 'Access could not be verified',
      'We could not confirm your partner access just now. This is usually temporary.',
      button('Try again', () => window.location.reload()));
  }
  return new Promise(() => {});
}

/** Demo deployments: a slim, dismissible-per-visit banner over the dashboard. */
export function showDemoBanner(): void {
  const banner = SHOWCASE_SCENARIO_ENABLED
    ? h('div', { className: 'access-demo-banner access-demo-banner-sample', role: 'note' },
      h('strong', {}, 'Sample scenario'),
      ` — hazard feeds show a simulation timed to today (${SHOWCASE_SCENARIO_TITLE}). `
        + 'NRC panels are live where reachable; rows marked SAMPLE did not occur.',
    )
    : h('div', { className: 'access-demo-banner', role: 'note' },
      h('strong', {}, 'Demo'),
      ' — public data only, no account needed. Partner deployments add private instances and API access.',
    );
  const close = h('button', { type: 'button', className: 'access-demo-banner-close', 'aria-label': 'Dismiss demo notice' }, '×');
  // #app is absolutely positioned at the top of the viewport, so the banner
  // must push it down explicitly or it covers the header.
  const root = document.documentElement;
  const syncOffset = () => root.style.setProperty('--access-demo-banner-height', `${banner.offsetHeight}px`);
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(syncOffset) : null;
  close.addEventListener('click', () => {
    resize?.disconnect();
    banner.remove();
    root.classList.remove('has-access-demo-banner');
    root.style.removeProperty('--access-demo-banner-height');
    window.dispatchEvent(new Event('resize'));
  });
  banner.appendChild(close);
  document.body.prepend(banner);
  root.classList.add('has-access-demo-banner');
  syncOffset();
  resize?.observe(banner);
  window.dispatchEvent(new Event('resize'));
}
