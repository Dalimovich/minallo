// Cloudflare Pages Functions shim for the SSE streaming endpoint that lived
// at backend/edge-functions/ai-stream.js on Netlify (Deno runtime).
//
// The original file uses only Web-standard APIs (fetch, Response,
// TransformStream, ReadableStream, TextEncoder) — all of which Workers
// supports natively. The ONLY Deno-specific surface it uses is
// ``Deno.env.get(...)``. We stub that on globalThis before delegating
// so the original module runs unchanged.

interface PagesEventContext<Env = Record<string, string>> {
  request: Request;
  env: Env;
}

// Lazy import + lazy Deno shim. Set per-request to defend against env
// drift (Pages deployments shouldn't change env mid-request, but the
// runtime spec allows different requests to see different env objects,
// e.g. preview vs production bindings).
export const onRequest = async (
  ctx: PagesEventContext<Record<string, string>>
): Promise<Response> => {
  const env = ctx.env || {};
  (globalThis as { Deno?: { env: { get: (k: string) => string | undefined } } }).Deno = {
    env: {
      get: (k: string) => (typeof env[k] === 'string' ? env[k] : undefined)
    }
  };
  // Dynamic import so the Deno shim is in place before the module body runs.
  // (The handler doesn't reference Deno at top level, but defensive ordering
  // costs nothing here.)
  // @ts-expect-error The legacy stream handler is a Web-standard JS module.
  const mod = await import('../../../backend/edge-functions/ai-stream.js');
  return mod.default(ctx.request, {});
};
