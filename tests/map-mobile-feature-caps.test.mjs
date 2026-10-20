import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const mapSrc = readFileSync(resolve(root, 'src/components/Map.ts'), 'utf-8');
const cssSrc = readFileSync(resolve(root, 'src/styles/main.css'), 'utf-8');

function sliceBetween(start, end) {
  const startIdx = mapSrc.indexOf(start);
  const endIdx = mapSrc.indexOf(end, startIdx + start.length);
  assert.ok(startIdx >= 0, `missing start marker: ${start}`);
  assert.ok(endIdx > startIdx, `missing end marker after ${start}: ${end}`);
  return mapSrc.slice(startIdx, endIdx);
}

describe('mobile SVG map feature caps and label reflow skip (#4463 / U7)', () => {
  it('declares the signed-off mobile caps as named constants', () => {
    assert.match(mapSrc, /private static readonly MOBILE_MIN_EARTHQUAKE_MAGNITUDE = 5/);
    assert.match(mapSrc, /private static readonly MOBILE_MAX_IRAN_EVENTS = 50/);
  });

  it('keeps label overlap measurement disabled on mobile until movement or zoom needs it', () => {
    assert.match(mapSrc, /private mobileLabelVisibilityArmed = false/);
    assert.match(mapSrc, /this\.mobileLabelVisibilityArmed = !this\.isMobile/);
    assert.match(
      mapSrc,
      /private shouldUpdateLabelVisibility\(\): boolean \{\s*return !this\.isMobile \|\| this\.mobileLabelVisibilityArmed;\s*\}/,
      'desktop should keep label measurement enabled while mobile waits for the resume trigger',
    );

    const applyBlock = sliceBetween('private applyTransform(rebuildOnZoomVisibilityChange = true): void {', 'private shouldUpdateLabelVisibility(): boolean');
    const guardIdx = applyBlock.indexOf('if (this.shouldUpdateLabelVisibility()) this.updateLabelVisibility(zoom);');
    const zoomVisibilityIdx = applyBlock.indexOf('this.updateZoomLayerVisibility();');
    const emitIdx = applyBlock.indexOf('this.emitStateChange();');
    assert.ok(guardIdx >= 0, 'applyTransform should guard label visibility measurement');
    assert.ok(zoomVisibilityIdx > guardIdx, 'zoom-layer visibility should still run after the label guard');
    assert.ok(emitIdx > zoomVisibilityIdx, 'state emission should still run after the label guard');
  });

  it('keeps mobile label measurement out of the tap-start window and resumes it on real movement', () => {
    assert.doesNotMatch(
      mapSrc,
      /this\.container\.addEventListener\('pointerdown'[\s\S]*?resumeMobileLabelVisibility\(\)/,
      'pointerdown is part of the tap INP window and must not arm label measurement',
    );
    const touchStartBlock = sliceBetween("this.container.addEventListener('touchstart', (e) => {", "this.container.addEventListener('touchmove'");
    assert.doesNotMatch(
      touchStartBlock,
      /resumeMobileLabelVisibility\(\)/,
      'touchstart is part of the tap INP window and must not arm label measurement',
    );
    const touchMoveBlock = sliceBetween("this.container.addEventListener('touchmove', (e) => {", "this.container.addEventListener('touchend'");
    assert.match(
      touchMoveBlock,
      /if \(e\.touches\.length === 2[\s\S]*?this\.resumeMobileLabelVisibility\(\);[\s\S]*?this\.applyTransform\(\);/,
      'pinch movement should arm label measurement before the transform pass that needs it',
    );
    assert.match(
      touchMoveBlock,
      /touchDragActive = true;[\s\S]*?this\.resumeMobileLabelVisibility\(\);[\s\S]*?this\.applyTransform\(\);/,
      'single-finger panning should arm label measurement only after the drag threshold is crossed',
    );
    assert.match(
      mapSrc,
      /private resumeMobileLabelVisibility\(\): void \{\s*if \(!this\.isMobile \|\| this\.mobileLabelVisibilityArmed\) return;\s*this\.mobileLabelVisibilityArmed = true;\s*this\.updateLabelVisibility\(this\.state\.zoom\);\s*\}/,
      'resume should remain mobile-only, idempotent, and run one label pass when movement/zoom arms it',
    );
    const fitCountryBlock = sliceBetween('public fitCountry(code: string): void {', 'public getState(): MapState {');
    assert.equal(
      fitCountryBlock.match(/this\.setCenter\(midLat, midLon\);\s*this\.resumeMobileLabelVisibility\(\);/g)?.length,
      2,
      'fitCountry should re-arm mobile label measurement after both country-fit center paths',
    );
  });

  it('isolates mobile tap paint and removes marker transform transitions in the touch map', () => {
    assert.match(
      cssSrc,
      /\.map-container\s*\{[\s\S]*?contain:\s*layout paint;/,
      'the map container should contain map-triggered layout and paint work',
    );
    assert.match(
      cssSrc,
      /#mapOverlays\s*\{[\s\S]*?contain:\s*layout paint;/,
      'the overlay layer should isolate marker paint from the rest of the page',
    );
    const mobileTouchBlock = cssSrc.slice(
      cssSrc.indexOf('Mobile Touch Optimization'),
      cssSrc.indexOf('/* Extra small screens */'),
    );
    assert.match(
      mobileTouchBlock,
      /\.nat-event-marker,\s*\.conflict-click-area\s*\{[\s\S]*?transition:\s*opacity 0\.2s ease;/,
      'mobile marker tap targets should keep opacity fades while avoiding transform transitions',
    );
    const mobileMarkerTransitionBlock =
      mobileTouchBlock.match(/\.nat-event-marker,\s*\.conflict-click-area\s*\{[\s\S]*?\}/)?.[0] ?? '';
    assert.doesNotMatch(
      mobileMarkerTransitionBlock,
      /transform/,
      'mobile marker tap target transitions must not include transform',
    );
    assert.match(
      mobileTouchBlock,
      /\.nat-event-marker:hover\s*\{[\s\S]*?transform:\s*translate\(-50%, -50%\) scale\(var\(--marker-scale, 1\)\);/,
      'mobile natural-event hover should preserve the current transform instead of scaling on tap',
    );
  });
});
