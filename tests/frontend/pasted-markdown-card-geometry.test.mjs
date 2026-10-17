import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const css = readFileSync('frontend/views/chatbot/chatbot.css', 'utf8');
const longName = 'Conditional Probability Lecture Notes and Assignment Instructions.md';
const card = (index) => `<span class="ncb-file-chip ncb-file-chip--markdown" data-testid="pasted-markdown-attachment">
  <span class="ncb-file-chip-icon">MD</span>
  <span class="ncb-file-chip-text"><span class="ncb-file-chip-name" title="${longName}">${longName}</span><span class="ncb-file-chip-kind" data-testid="pasted-markdown-meta" title="21,456 characters · Markdown">21,456 characters · Markdown</span></span>
  <span class="ncb-file-chip-actions"><button class="ncb-file-chip-preview">Preview</button><button class="ncb-file-chip-x" aria-label="Remove attachment ${index}">×</button></span>
</span>`;

test('pasted Markdown cards contain long text, actions, zoom, and multiple attachments', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const width of [320, 375, 768]) {
      await page.setViewportSize({ width, height: 700 });
      for (const zoom of [1, 1.25, 1.5]) {
        await page.setContent(`<style>${css}</style><main style="width:${width}px;max-width:100%;zoom:${zoom}"><div class="ncb-files-row">${[1, 2, 3].map(card).join('')}</div></main>`);
        const geometry = await page.locator('[data-testid="pasted-markdown-attachment"]').evaluateAll((cards) => cards.map((node) => {
          const cardBox = node.getBoundingClientRect();
          const meta = node.querySelector('[data-testid="pasted-markdown-meta"]');
          const metaBox = meta.getBoundingClientRect();
          const actions = node.querySelector('.ncb-file-chip-actions').getBoundingClientRect();
          const nameStyle = getComputedStyle(node.querySelector('.ncb-file-chip-name'));
          const metaStyle = getComputedStyle(meta);
          return {
            contained: metaBox.top >= cardBox.top - 1 && metaBox.bottom <= cardBox.bottom + 1
              && actions.left >= cardBox.left - 1 && actions.right <= cardBox.right + 1,
            noOverflow: node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1,
            ellipsis: nameStyle.textOverflow === 'ellipsis' && metaStyle.textOverflow === 'ellipsis',
          };
        }));
        assert.equal(geometry.length, 3);
        geometry.forEach((result) => assert.deepEqual(result, { contained: true, noOverflow: true, ellipsis: true }));
      }
    }
  } finally {
    await browser.close();
  }
});
