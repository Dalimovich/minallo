import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');

// Phase 3 of the TTFT brief: an already-persisted chat must skip the
// /conversations/ensure round trip on every message after the first, since
// /ask-stream now creates the durable turn itself on first sight of a
// request_id it hasn't seen.

test('the main send flow skips ensureDurableConversation when the chat is already persisted', () => {
  assert.match(
    shell,
    /originChat\.persistedId\s*\n\s*\?\s*\{\s*conversationId:\s*originChat\.persistedId,\s*created:\s*false\s*\}/,
  );
});

test('ensureDurableConversation no longer carries the dead resumeExisting short-circuit', () => {
  // The call-site skip above now covers every case the old
  // `context.resumeExisting && chat.persistedId` branch handled (its only
  // caller passed resumeExisting), so the branch and the field it read are
  // both gone from the function itself.
  const fnStart = shell.indexOf('async function ensureDurableConversation');
  assert.ok(fnStart >= 0, 'ensureDurableConversation must still exist');
  const fnBody = shell.slice(fnStart, fnStart + 1200);
  assert.doesNotMatch(fnBody, /resumeExisting/);
});

test('the attachments flow still always calls ensureDurableConversation unconditionally', () => {
  assert.match(
    shell,
    /const durable = await ensureDurableConversation\(chatStore\.getActive\(\), \{ courseId: courseId \|\| undefined, titleSeed: message\.text \}\);/,
  );
});

// Review fix: /ask-stream's `question` may have a pasted-attachment block
// merged in for retrieval (see currentQuestion above in this same file) —
// the durable turn must save the plain typed text instead, via a separate
// messageText field, same as /conversations/ensure already did.

test('streamFromAskStream sends the plain typed text separately as messageText', () => {
  assert.match(shell, /displayMessageText\?:\s*string/);
  assert.match(shell, /messageText:\s*displayMessageText/);
});

test('the main send flow passes the original user message text as displayMessageText', () => {
  assert.match(
    shell,
    /assistantMessage\.requestId,\s*assistantMessage,\s*sourceUser\?\.text\s*\n?\s*\);/,
  );
});
