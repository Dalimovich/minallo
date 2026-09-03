const SUPA_URL = 'https://wprfkjeiawxlcnitsfdr.supabase.co';
const SUPA_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndwcmZramVpYXd4bGNuaXRzZmRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMjAyMzUsImV4cCI6MjA4OTc5NjIzNX0.LbJKG8J_jd2oKYAmQg0ycb-LBnQM1ItlseOLMT_24jc';

let authTabId = null;
let originWinId = null;

function startGoogleAuth() {
  const redirectTo = 'https://minallo.de/';
  const authUrl = `${SUPA_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;
  chrome.windows.getCurrent({}, (win) => {
    originWinId = win.id;
  });
  chrome.tabs.create({ url: authUrl }, (tab) => {
    authTabId = tab.id;
  });
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId !== authTabId) return;
  const url = changeInfo.url || tab.url || '';
  if (!url.includes('access_token=')) return;
  authTabId = null;
  chrome.tabs.remove(tabId);
  try {
    const hash = new URLSearchParams(new URL(url).hash.slice(1));
    const token = hash.get('access_token');
    if (!token) throw new Error('No access_token in redirect');
    const ur = await fetch(`${SUPA_URL}/auth/v1/user`, {
      headers: { apikey: SUPA_ANON, Authorization: `Bearer ${token}` }
    });
    const user = await ur.json();
    await chrome.storage.local.set({ ss_token: token, ss_user: user, ss_auth_done: Date.now() });
    const reopenPopup = () => {
      if (chrome.action?.openPopup) chrome.action.openPopup().catch(() => {});
    };
    if (originWinId) chrome.windows.update(originWinId, { focused: true }, reopenPopup);
    else reopenPopup();
    chrome.runtime.sendMessage({ action: 'authDone' }).catch(() => {});
  } catch (e) {
    await chrome.storage.local.set({ ss_auth_error: e.message });
    chrome.runtime.sendMessage({ action: 'authError', error: e.message }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === authTabId) {
    authTabId = null;
    chrome.runtime.sendMessage({ action: 'authError', error: 'Sign-in cancelled' }).catch(() => {});
  }
});

// ── Main message handler ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.action === 'startGoogleAuth') {
    startGoogleAuth();
    reply({ ok: true });
    return true;
  }
});
