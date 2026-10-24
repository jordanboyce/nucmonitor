import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/tests/sanitizer-harness', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body></body></html>',
  }));
  await page.goto('/tests/sanitizer-harness');
});

for (const hook of ['afterSanitizeElements', 'afterSanitizeAttributes'] as const) {
  // GHSA-p98j-92pf-mc4p requires checking the retained descendant, not just the returned root.
  test(`${hook} neutralizes event handlers in a detached subtree`, async ({ page }) => {
    const result = await page.evaluate(async (hookName) => {
      const modulePath = '/node_modules/dompurify/dist/purify.es.mjs';
      const { default: createDOMPurify } = await import(/* @vite-ignore */ modulePath);
      const purify = createDOMPurify(window);
      const root = document.createElement('div');
      root.innerHTML = '<section id="wrap"><img src="x" onerror="ATTACKER()"></section><p>Safe text</p>';
      const wrapper = root.querySelector('section')!;
      const image = root.querySelector('img')!;
      const handlerBefore = image.getAttribute('onerror');
      document.body.append(root);

      try {
        purify.addHook(hookName, (node: Node) => {
          if (node === wrapper) wrapper.remove();
        });
        const sanitized = purify.sanitize(root, { IN_PLACE: true });
        return {
          handlerBefore,
          handlerAfter: image.getAttribute('onerror'),
          sameRoot: sanitized === root,
          detached: !wrapper.isConnected && root.querySelector('section') === null,
          sameDescendant: wrapper.querySelector('img') === image,
          safeText: root.querySelector('p')?.textContent,
        };
      } finally {
        purify.removeAllHooks();
        root.remove();
      }
    }, hook);

    expect(result).toEqual({
      handlerBefore: 'ATTACKER()',
      handlerAfter: null,
      sameRoot: true,
      detached: true,
      sameDescendant: true,
      safeText: 'Safe text',
    });
  });
}
