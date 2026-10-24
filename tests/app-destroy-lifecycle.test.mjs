import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const appSrc = readFileSync(resolve(root, 'src/App.ts'), 'utf8');
const mainSrc = readFileSync(resolve(root, 'src/main.ts'), 'utf8');
const dataLoaderSrc = readFileSync(resolve(root, 'src/app/data-loader.ts'), 'utf8');
const panelLayoutSrc = readFileSync(resolve(root, 'src/app/panel-layout.ts'), 'utf8');

function methodBody(source, signature) {
  const signatureIndex = source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `could not locate ${signature}`);

  const openBraceIndex = source.indexOf('{', signatureIndex);
  assert.notEqual(openBraceIndex, -1, `could not locate ${signature} opening brace`);

  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index++) {
    const char = source[index];
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (depth === 0) {
      return source.slice(openBraceIndex + 1, index);
    }
  }

  assert.fail(`could not locate ${signature} closing brace`);
}

function appDestroyBody() {
  return methodBody(appSrc, 'public destroy(): void');
}

describe('App.destroy lifecycle cleanup contract', () => {
  it('tears down early WebMCP registration when asynchronous app initialization fails', () => {
    const bootStart = mainSrc.indexOf("const app = new App('app');");
    const bootEnd = mainSrc.indexOf('installBetaConsoleToggle(window);', bootStart);
    assert.notEqual(bootStart, -1, 'could not locate the dashboard App boot');
    assert.notEqual(bootEnd, -1, 'could not locate the end of the dashboard App boot');
    const boot = mainSrc.slice(bootStart, bootEnd);
    assert.match(boot, /\.catch\(\(error: unknown\) => \{/);
    assert.match(boot, /try \{\s*\/\/[\s\S]*?app\.destroy\(\);\s*\} catch \(cleanupError\) \{/);

    const destroyBody = appDestroyBody();
    const wakePendingTools = destroyBody.indexOf('this.resolveAppDestroyed()');
    const abortLifecycle = destroyBody.indexOf('this.lifecycleController.abort()');
    const abortRegisteredTools = destroyBody.indexOf('this.webMcpController?.abort()');
    const destroyModules = destroyBody.indexOf('// Destroy all modules in reverse order');
    assert.ok(wakePendingTools >= 0, 'destroy() must wake WebMCP readiness waits');
    assert.ok(
      abortLifecycle > wakePendingTools && abortLifecycle < abortRegisteredTools,
      'destroy() must abort App-owned waiters before unregistering WebMCP tools',
    );
    assert.ok(
      abortRegisteredTools > wakePendingTools && abortRegisteredTools < destroyModules,
      'destroy() must unregister WebMCP before partial module cleanup can throw',
    );
    assert.match(
      destroyBody,
      /try \{[\s\S]*Destroy all modules in reverse order[\s\S]*\} finally \{[\s\S]*this\.state\.map\?\.destroy\(\);/,
      'destroy() must still clean up the map if a module destructor throws',
    );
  });

  it('observes descendant scroll containers in capture phase and removes the matching listener', () => {
    const scrollRegistrations = [
      ...appSrc.matchAll(/window\.addEventListener\('scroll',\s*this\.handleViewportPrime,\s*\{([\s\S]*?)\}\);/g),
    ];
    assert.equal(scrollRegistrations.length, 1, 'App must register exactly one viewport-prime scroll listener');
    assert.match(scrollRegistrations[0][1], /passive:\s*true/, 'the scroll listener must remain passive');
    assert.match(
      scrollRegistrations[0][1],
      /capture:\s*true/,
      'capture is required because element scroll events do not bubble to window',
    );

    const body = appDestroyBody();
    assert.match(
      body,
      /window\.removeEventListener\('scroll',\s*this\.handleViewportPrime,\s*\{\s*capture:\s*true\s*\}\);/,
      'destroy() must use the same capture value so same-document re-inits do not accumulate listeners',
    );
    assert.match(
      appSrc,
      /window\.addEventListener\('resize',\s*this\.handleViewportPrime\);/,
      'viewport resize must keep triggering hydration',
    );
    assert.match(
      body,
      /window\.removeEventListener\('resize',\s*this\.handleViewportPrime\);/,
      'destroy() must keep removing the resize listener',
    );

    const slowTierAwait = appSrc.indexOf('await slowTierReady;');
    const settledGate = appSrc.indexOf('if (!settled)', slowTierAwait);
    const fanoutFn = appSrc.indexOf('private async runVisibleDataFanout(): Promise<void> {');
    const readyFlag = appSrc.indexOf('this.viewportHydrationReady = true;', fanoutFn);
    const scrollRegistration = appSrc.indexOf("window.addEventListener('scroll', this.handleViewportPrime", fanoutFn);
    const fanoutComplete = appSrc.indexOf("markLcpDebug('wm:data:initial-fanout-complete');", scrollRegistration);
    const readyTimestamp = appSrc.indexOf('this.viewportHydrationReadyAt = typeof performance', fanoutComplete);
    const armedFlag = appSrc.indexOf('this.viewportTriggersArmed = true;', readyTimestamp);
    assert.notEqual(slowTierAwait, -1, 'could not locate the slow-tier readiness checkpoint');
    assert.ok(
      settledGate > slowTierAwait,
      'a timed-out slow-tier wait must keep the mount-callback gate closed',
    );
    assert.ok(
      appSrc.includes('this.completePendingSlowTierFanout()'),
      'a late slow-tier settle must still open viewport hydration',
    );
    assert.ok(
      fanoutFn > -1 && fanoutFn < slowTierAwait,
      'visible-data fan-out must stay behind the shared helper, not inline after a forced ready flag',
    );
    assert.ok(
      readyFlag > fanoutFn && readyFlag < scrollRegistration,
      'viewport hydration readiness must open before registering scroll listeners',
    );
    assert.ok(
      fanoutComplete > scrollRegistration,
      'scroll listeners register before the initial fan-out completes',
    );
    assert.ok(
      readyTimestamp > fanoutComplete && armedFlag > readyTimestamp,
      'viewport triggers must stamp readiness and arm only after the initial fan-out',
    );
  });

  it('filters nested scrollers, coalesces viewport triggers, and cancels queued hydration during destroy', () => {
    const start = appSrc.indexOf('private readonly handleViewportPrime = (event?: Event): void => {');
    const end = appSrc.indexOf('private readonly handleConnectivityChange', start);
    assert.notEqual(start, -1, 'could not locate handleViewportPrime');
    assert.notEqual(end, -1, 'could not locate the end of handleViewportPrime');
    const handler = appSrc.slice(start, end);

    assert.match(
      handler,
      /if \(this\.visiblePanelPrimeRaf !== null\) return;/,
      'repeated scrolls in one frame must share one hydration callback',
    );
    assert.match(handler, /if \(!this\.viewportHydrationReady \|\| this\.state\.isDestroyed\) return;/);
    assert.match(handler, /if \(!this\.viewportTriggersArmed\) return;/);
    assert.match(handler, /event\?\.type === 'scroll'/);
    assert.match(handler, /event\.target instanceof Element/);
    assert.match(handler, /!event\.target\.matches\('\.main-content, \.panels-grid'\)/);
    const armedGuard = handler.indexOf('if (!this.viewportTriggersArmed) return;');
    const staleEventGuard = handler.indexOf('event.timeStamp < this.viewportHydrationReadyAt');
    const rafSchedule = handler.indexOf('this.visiblePanelPrimeRaf = window.requestAnimationFrame(');
    assert.ok(
      armedGuard >= 0 && armedGuard < staleEventGuard && staleEventGuard < rafSchedule,
      'scroll events must stay disarmed through fan-out and ignore pre-arm timestamps afterward',
    );
    assert.match(handler, /this\.visiblePanelPrimeRaf = window\.requestAnimationFrame\(/);
    assert.match(handler, /this\.visiblePanelPrimeRaf = null;/);
    assert.match(handler, /void this\.primeVisiblePanelData\(\);/);
    assert.match(handler, /void this\.dataLoader\.loadAllData\(\);/);

    const body = appDestroyBody();
    assert.match(
      body,
      /if \(this\.visiblePanelPrimeRaf !== null\) \{\s*window\.cancelAnimationFrame\(this\.visiblePanelPrimeRaf\);\s*this\.visiblePanelPrimeRaf = null;\s*\}/,
      'destroy() must cancel a queued frame before it can hydrate a disposed App',
    );
    assert.match(
      body,
      /this\.viewportHydrationReady = false;\s*this\.viewportHydrationReadyAt = 0;\s*this\.viewportTriggersArmed = false;/,
      'destroy() must reset viewport hydration readiness and arming',
    );

    const afterPanelMounted = methodBody(panelLayoutSrc, 'private afterPanelMounted(key: string, panel: Panel): void');
    const scheduleLoad = afterPanelMounted.indexOf("this.scheduleHydrationForPanelElement(panel.getElement(), 'near');");
    const primePanel = afterPanelMounted.indexOf('this.callbacks.primeVisiblePanelData();');
    assert.ok(
      scheduleLoad >= 0 && primePanel > scheduleLoad,
      'a newly mounted deferred panel must re-run its App-owned viewport prime without another scroll',
    );
  });

  it('preserves existing map/WebMCP teardown', () => {
    const body = appDestroyBody();
    for (const expected of [
      'this.state.map?.destroy()',
      'this.webMcpController?.abort()',
      'mlWorker.terminate()',
      'this.unsubAuth?.()',
    ]) {
      assert.ok(body.includes(expected), `App.destroy() must keep ${expected}`);
    }
  });

});
