/**
 * T3 (#5634) — behavioral coverage for `resolveGateAction`.
 *
 * `tests/billing-state-wiring.test.mts` asserts this switch by reading the
 * SOURCE TEXT of panel-gating.ts (`assert.match(src, /case
 * PanelGateReason.PAYMENT_ON_HOLD:/)`). That locks the shape of the code, not
 * what a click does — the regex stays green if the branch stops opening
 * anything, opens the wrong URL, or loses the popup-blocker pre-reserve.
 *
 * Here the returned callback is INVOKED against a real (happy-dom) window with
 * an injected `openAuthModal`, and the observable effect is asserted:
 * which URL opened, in what order, and what got handed to the billing portal.
 *
 * `prereserveBillingPortalTab` is deliberately NOT mocked — its real body is
 * `window.open('', '_blank')`, and that call is the
 * behaviour under test. Only `openBillingPortal` is stubbed, because its real
 * body fetches a portal session.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const openBillingPortal = vi.fn(async () => ({ outcome: 'opened' as const, url: 'https://portal' }));
const getSubscription = vi.fn<() => { planKey: string } | null>(() => null);

/**
 * Runtime is the only thing overridden for the desktop cases (#5911);
 * `external-navigation` and `tauri-bridge` stay real, so those cases assert
 * the observable effect rather than that a helper was called.
 */
let desktopRuntime = false;

vi.mock('@/services/desktop-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/desktop-runtime')>()),
  isDesktopRuntime: () => desktopRuntime,
}));

const { PanelGateReason, resolveGateAction } = await import('@/services/panel-gating');

let openSpy: MockInstance<typeof window.open>;
let reloadSpy: MockInstance<() => void>;
let openAuthModal: Mock<() => void>;
let tauriInvocations: Array<{ command: string; payload?: Record<string, unknown> }>;
/** Stand-in for the tab the browser hands back from a synchronous window.open. */
const reservedTab = { closed: false, location: { href: '' } } as unknown as Window;

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  openAuthModal = vi.fn<() => void>();
  openSpy = vi.spyOn(window, 'open').mockReturnValue(reservedTab);
  reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  openBillingPortal.mockClear();
  getSubscription.mockReset().mockReturnValue(null);
  desktopRuntime = false;
  tauriInvocations = [];
  // Present in every case, so a desktop assertion cannot pass merely because
  // the web cases lacked a bridge to call.
  vi.stubGlobal('__TAURI_INTERNALS__', {
    invoke: async (command: string, payload?: Record<string, unknown>) => {
      tauriInvocations.push({ command, payload });
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Spies are restored by `restoreMocks: true` in vitest.dom.config.mts — a
// second mechanism here would only invite the two to drift. The vi.fn()s above
// are not spies, so they are reset explicitly in beforeEach.

const act = (reason: (typeof PanelGateReason)[keyof typeof PanelGateReason], planKey?: string | null) =>
  resolveGateAction(reason, { openAuthModal, ...(planKey === undefined ? {} : { planKey }) });

describe('resolveGateAction — resolution is inert', () => {
  it('resolving a reason performs no side effect until the callback runs', () => {
    for (const reason of Object.values(PanelGateReason)) act(reason);

    expect(openSpy).not.toHaveBeenCalled();
    expect(openAuthModal).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(openBillingPortal).not.toHaveBeenCalled();
  });
});

describe('resolveGateAction — ANONYMOUS', () => {
  it('opens the injected auth modal and navigates nowhere', () => {
    act(PanelGateReason.ANONYMOUS)();

    expect(openAuthModal).toHaveBeenCalledTimes(1);
    expect(openSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe('resolveGateAction — every signed-in reason', () => {
  it('never navigates, reloads or opens a billing surface (partner access has no upsell)', () => {
    for (const reason of Object.values(PanelGateReason)) {
      if (reason === PanelGateReason.ANONYMOUS) continue;
      act(reason, 'pro_monthly')();
    }

    expect(openSpy).not.toHaveBeenCalled();
    expect(openAuthModal).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(openBillingPortal).not.toHaveBeenCalled();
    expect(tauriInvocations).toEqual([]);
  });
});

describe('resolveGateAction — NONE', () => {
  it('is a no-op: an ungated surface must not navigate', () => {
    act(PanelGateReason.NONE)();

    expect(openSpy).not.toHaveBeenCalled();
    expect(openAuthModal).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(openBillingPortal).not.toHaveBeenCalled();
  });
});
