import test from 'node:test';
import assert from 'node:assert/strict';

const { upstreamFailureResponse, jsonResponse } = await import('../../backend/lib/responses.ts');

test('JSON responses declare application/json', () => {
  assert.equal(jsonResponse(200, { a: 1 }).headers['Content-Type'], 'application/json');
});

test('502/504 from python-ai are relayed as structured JSON that Cloudflare will not replace with HTML', () => {
  for (const upstream of [502, 504]) {
    const r = upstreamFailureResponse(upstream, { detail: 'Generation failed (ref abc123def456)', requestId: 'abc123def456', diagnostics: { requestId: 'abc123def456' } });
    assert.equal(r.statusCode, 500, `${upstream} must not be sent as 502/504`);
    const b = JSON.parse(r.body);
    assert.equal(b.upstreamStatus, upstream);
    assert.equal(b.requestId, 'abc123def456');
    assert.match(b.detail, /\(ref abc123def456\)/);
    assert.equal(r.headers['Content-Type'], 'application/json');
  }
});

test('other statuses pass through unchanged and HTML/raw upstream bodies never leak', () => {
  assert.equal(upstreamFailureResponse(422, { detail: 'not ready' }).statusCode, 422);
  const r = upstreamFailureResponse(502, { raw: '<html>Bad gateway</html>' });
  const b = JSON.parse(r.body);
  assert.doesNotMatch(r.body, /<html>/);
  assert.equal(typeof b.detail, 'string');
});

test('python-ai already sends 502/504 as HTTP 500; the real status in the body is preserved', () => {
  const r = upstreamFailureResponse(500, { detail: 'Generation took too long (ref 0123456789ab)', requestId: '0123456789ab', upstreamStatus: 504 });
  const b = JSON.parse(r.body);
  assert.equal(r.statusCode, 500);
  assert.equal(b.upstreamStatus, 504);
  assert.equal(b.requestId, '0123456789ab');
});
