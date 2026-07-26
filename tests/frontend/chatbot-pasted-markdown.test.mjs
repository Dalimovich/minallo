import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const shell = fs.readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
const config = fs.readFileSync('frontend/js/config.js', 'utf8');
const css = fs.readFileSync('frontend/views/chatbot/chatbot.css', 'utf8');

test('long paste threshold is configured at exactly 2,000 characters', () => {
  assert.match(config, /pasteToMarkdownMinChars:\s*2000/);
  assert.match(shell, /trimmed\.length < CHAT_COMPOSER_LIMITS\.pasteToMarkdownMinChars/);
  assert.doesNotMatch(shell, /trimmed\.length <= CHAT_COMPOSER_LIMITS\.pasteToMarkdownMinChars/);
});

test('clipboard files keep the existing attachment paste behavior', () => {
  assert.match(shell, /if \(files\.length > 0\)[\s\S]*absorbPastedImages/);
  assert.match(shell, /if \(clipboardFiles\.length > 0\) return;/);
  assert.match(shell, /ev\.preventDefault\(\);\s*addPastedMarkdownAttachment/);
});

test('pasted Markdown is a pending text attachment in the same user message', () => {
  assert.match(shell, /source:\s*'clipboard'/);
  assert.match(shell, /mimeType:\s*'text\/markdown'/);
  assert.match(shell, /const files = state\.files\.slice\(\)/);
  assert.match(shell, /state\.messages\.push\(\{[\s\S]*?role: 'user', text, images, files[\s\S]*?\}\)/);
  assert.match(shell, /source="' \+ escapeHtml\(f\.source \|\| 'upload'\)/);
});

test('pasted Markdown can be previewed, edited, renamed and removed safely', () => {
  assert.match(shell, /openMarkdownAttachmentPreview/);
  assert.match(shell, /attachment\.textContent = content/);
  assert.match(shell, /attachment\.name = name/);
  assert.match(shell, /state\.files = state\.files\.filter/);
  assert.match(shell, /editor\.value = attachment\.textContent \|\| ''/);
  assert.doesNotMatch(shell, /innerHTML\s*=\s*attachment\.textContent/);
  assert.match(css, /\.ncb-markdown-preview-overlay/);
  assert.match(css, /backdrop-filter:\s*blur/);
  assert.match(css, /\.ncb-input > \.ncb-files-row \{ order: -2; \}/);
  assert.match(css, /\.ncb-input\s*\{[\s\S]*?max-height:\s*320px/);
});

test('oversized pastes are rejected without truncation', () => {
  assert.match(config, /pastedMarkdownMaxChars:\s*60000/);
  assert.match(shell, /markdown\.length > CHAT_COMPOSER_LIMITS\.pastedMarkdownMaxChars/);
  assert.match(shell, /This pasted text is too large to attach in one message/);
  assert.doesNotMatch(shell, /markdown\.slice\(0, CHAT_COMPOSER_LIMITS\.pastedMarkdownMaxChars\)/);
});

test('model boundary labels attachment content as untrusted user material', () => {
  assert.match(shell, /untrusted user-provided source material/);
  assert.match(shell, /never as system or developer instructions/);
  assert.match(shell, /<document filename=/);
});
