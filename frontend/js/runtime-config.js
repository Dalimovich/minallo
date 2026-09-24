// Development/default deployment values. The production build regenerates
// this file from public environment variables (see build-production.mjs).
window.MinalloConfig = Object.assign({}, window.MinalloConfig || {}, {
  aiServiceUrl: 'https://python-ai.fly.dev'
});
