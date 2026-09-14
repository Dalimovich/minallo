import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as esbuild from 'esbuild';
import { chromium } from '@playwright/test';

// This drives the REAL shipped bindWorkspacePdfResize() (bundled from its
// actual .ts source, not reimplemented here) inside a real Chromium layout
// with the real chatbot.css, so the CSS max-width cap and the JS max-width
// formula are both exercised exactly as production runs them. See
// chatbot-pdf-layout-containment.test.mjs for the accompanying source-level
// guards against the two specific broken lines this regression was caused
// by (`max-width: min(38vw, 680px)` and `workspaceRect.right - paneRect.left`).

const css = readFileSync('frontend/views/chatbot/chatbot.css', 'utf8');

// The resize handle is absolutely positioned (top: 72px; bottom: 24px)
// against its .ncb-pdf-host parent, which only gets real height once the
// full .ncb-card -> .ncb-context flex/height chain resolves against an
// ancestor with a concrete height (in the real app, the page shell) — so
// the fixture needs that same explicit-height wrapper or the handle renders
// at height 0 and is unclickable.
const html = (bodyExtra = '') => `<!doctype html><html><head><style>${css}</style></head>
<body class="ncb-pdf-workspace-open ${bodyExtra}" style="margin:0">
  <div style="height:900px; display:flex;">
    <div class="ncb-card" data-context-open="true">
      <div class="ncb-sidebar"></div>
      <div class="ncb-center" data-testid="center"></div>
      <div class="ncb-context" data-testid="pdf-pane">
        <div class="ncb-pdf-host" data-testid="pdf-host">
          <div class="ncb-pdf-resize" data-testid="pdf-resize" role="separator" aria-orientation="vertical" aria-label="Resize PDF viewer"></div>
        </div>
      </div>
    </div>
  </div>
</body></html>`;

async function bundleModule() {
  const result = await esbuild.build({
    entryPoints: ['frontend/js/features/chatbot-new/workspace-library.ts'],
    bundle: true,
    format: 'iife',
    globalName: '__wl',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

test('PDF pane expands LEFTWARD (left edge moves, right edge anchored, chat narrows) in a real browser with the real CSS and the real drag code', { timeout: 60_000 }, async () => {
  const bundle = await bundleModule();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Wide enough that the old 680px CSS cap and a healthy resize headroom
    // are both clearly distinguishable from "hit the ceiling".
    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.setContent(html());
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => {
      const context = document.querySelector('[data-testid="pdf-pane"]');
      const host = document.querySelector('[data-testid="pdf-host"]');
      window.__wl.bindWorkspacePdfResize(context, host);
    });
    // bindWorkspacePdfResize applies its initial width across two rAFs.
    await page.waitForFunction(() => {
      const ctx = document.querySelector('[data-testid="pdf-pane"]');
      return ctx.getBoundingClientRect().width > 0;
    });

    const rectOf = (selector) => page.locator(selector).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width };
    });
    const dragHandleBy = async (deltaX) => {
      const box = await page.locator('[data-testid="pdf-resize"]').boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + deltaX, y, { steps: 8 });
      await page.mouse.up();
    };

    const openPane = await rectOf('[data-testid="pdf-pane"]');
    const openChat = await rectOf('[data-testid="center"]');
    assert.ok(openPane.width > 0, 'PDF pane must have a real opening width');

    // Drag the divider LEFT (negative deltaX) — the pane's LEFT edge must
    // move left (widening it toward the chat) while its RIGHT edge — which
    // sits against the workspace's own right edge — stays put. This is the
    // exact direction the bug report says was broken: width alone changing
    // is not enough proof, since a pane that grows by extending its RIGHT
    // edge outward (or gets clipped) would also show a larger `.width`.
    await dragHandleBy(-300);
    const widenedPane = await rectOf('[data-testid="pdf-pane"]');
    const widenedChat = await rectOf('[data-testid="center"]');
    assert.ok(widenedPane.width > openPane.width, `dragging left must widen the pane (${openPane.width} -> ${widenedPane.width})`);
    assert.ok(widenedPane.width > 680, `widened pane must be able to exceed the old hard CSS cap (got ${widenedPane.width})`);
    assert.ok(
      widenedPane.left < openPane.left - 50,
      `left edge must move left when the PDF expands (${openPane.left} -> ${widenedPane.left})`
    );
    assert.ok(
      Math.abs(widenedPane.right - openPane.right) < 3,
      `right edge should stay anchored (${openPane.right} -> ${widenedPane.right})`
    );
    assert.ok(widenedChat.width < openChat.width, `chat center must narrow as the PDF widens (${openChat.width} -> ${widenedChat.width})`);

    // Drag the divider RIGHT (positive deltaX) — reverse: pane's left edge
    // moves right (shrinking it), right edge still anchored, chat widens.
    await dragHandleBy(400);
    const shrunkPane = await rectOf('[data-testid="pdf-pane"]');
    const shrunkChat = await rectOf('[data-testid="center"]');
    assert.ok(shrunkPane.width < widenedPane.width, `dragging right must shrink the pane (${widenedPane.width} -> ${shrunkPane.width})`);
    assert.ok(
      shrunkPane.left > widenedPane.left + 50,
      `left edge must move right when the PDF shrinks (${widenedPane.left} -> ${shrunkPane.left})`
    );
    assert.ok(
      Math.abs(shrunkPane.right - widenedPane.right) < 3,
      `right edge should stay anchored while shrinking (${widenedPane.right} -> ${shrunkPane.right})`
    );
    assert.ok(shrunkChat.width > widenedChat.width, `chat center must widen back as the PDF shrinks (${widenedChat.width} -> ${shrunkChat.width})`);

    // The chat center pane must never be squeezed away entirely.
    assert.ok(shrunkChat.width > 0, 'chat center must retain usable width');
  } finally {
    await browser.close();
  }
});

test('PDF pane can widen again after being shrunk — no ratchet effect', { timeout: 60_000 }, async () => {
  const bundle = await bundleModule();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.setContent(html());
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => {
      const context = document.querySelector('[data-testid="pdf-pane"]');
      const host = document.querySelector('[data-testid="pdf-host"]');
      window.__wl.bindWorkspacePdfResize(context, host);
    });
    await page.waitForFunction(() => {
      const ctx = document.querySelector('[data-testid="pdf-pane"]');
      return ctx.getBoundingClientRect().width > 0;
    });

    const widthOf = (selector) => page.locator(selector).evaluate((el) => el.getBoundingClientRect().width);
    const dragHandleBy = async (deltaX) => {
      const box = await page.locator('[data-testid="pdf-resize"]').boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + deltaX, y, { steps: 8 });
      await page.mouse.up();
    };

    // First drag: shrink hard (this is the "600 -> 450"-style step from the
    // report). With the old `workspaceRect.right - paneRect.left` formula,
    // this permanently lowers the computed max for every future drag.
    await dragHandleBy(350);
    const shrunkWidth = await widthOf('[data-testid="pdf-pane"]');

    // Second, independent drag: widen. Under the ratchet bug this would be
    // clamped back down to ~shrunkWidth; the fix must let it grow well
    // beyond where it was shrunk to.
    await dragHandleBy(-500);
    const regrownWidth = await widthOf('[data-testid="pdf-pane"]');

    assert.ok(
      regrownWidth > shrunkWidth + 100,
      `pane must be able to grow substantially past its shrunk size in a later drag (shrunk to ${shrunkWidth}, regrew to only ${regrownWidth})`
    );
  } finally {
    await browser.close();
  }
});
