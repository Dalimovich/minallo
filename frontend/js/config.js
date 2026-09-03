// Public frontend configuration. These values are safe to expose in browser code.
(function () {
  var cfg = {
    googleClientId: '345518014023-dsgciaeuvm9nak002avlrpdnikldusuq.apps.googleusercontent.com',
    supabaseUrl: 'https://wprfkjeiawxlcnitsfdr.supabase.co',
    supabaseAnonKey:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndwcmZramVpYXd4bGNuaXRzZmRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMjAyMzUsImV4cCI6MjA4OTc5NjIzNX0.LbJKG8J_jd2oKYAmQg0ycb-LBnQM1ItlseOLMT_24jc',
    paypalSdkUrl:
      'https://www.paypal.com/sdk/js?client-id=AXujeSZkOypAa2RuWUkmO0PX_BNMszy5rH_hvys2fTcwx-6gFCJOW1-ICXRGdDlB6X1BwdmFsy463rFN&vault=true&intent=subscription&currency=EUR',
    assetVersion: '20260831-intelligent-pipeline-router-v1',
    ai: {
      // The generic /chat endpoint always uses gpt-4o server-side regardless
      // of what's sent (see backend/python-ai/app/routers/chat.py) — this
      // just keeps the client's own default in sync with that reality.
      model: 'gpt-4o',
      maxTokens: 4096,
      pdfCharacterCap: 100000,
      imageMax: 5
    },
    chatComposerLimits: {
      pasteToMarkdownMinChars: 2000,
      pastedMarkdownMaxChars: 60000
    },
    // Python AI service base URL. The streaming /ask-stream
    // endpoint is called directly from the browser so the SSE connection
    // isn't capped by Cloudflare's function timeout. All other AI calls
    // still go through /api/* on Cloudflare Pages.
    aiServiceUrl: ''
  };

  // runtime-config.js is generated at build time and may override public
  // deployment-specific values without modifying this source file.
  window.MinalloConfig = Object.assign({}, cfg, window.MinalloConfig || {});

  // Backwards-compatible globals used by existing feature files.
  window._GCID = window.MinalloConfig.googleClientId;
  window._SUPA = window.MinalloConfig.supabaseUrl;
  window._SAKEY = window.MinalloConfig.supabaseAnonKey;
  window.AI_SERVICE_URL = window.MinalloConfig.aiServiceUrl;
})();
