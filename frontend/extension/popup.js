const SUPA_URL = 'https://wprfkjeiawxlcnitsfdr.supabase.co';
const SUPA_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndwcmZramVpYXd4bGNuaXRzZmRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMjAyMzUsImV4cCI6MjA4OTc5NjIzNX0.LbJKG8J_jd2oKYAmQg0ycb-LBnQM1ItlseOLMT_24jc';
const LECTURE_PATTERNS = [/youtube\.com\/watch/, /opencast/, /zoom\.us\/rec/, /zoom\.us\/j\//];

// ── Auth helpers ──────────────────────────────────────────────────────────────

function getSession() {
  return new Promise((resolve) => chrome.storage.local.get(['ss_token', 'ss_user'], resolve));
}

function saveSession(token, user) {
  return new Promise((resolve) =>
    chrome.storage.local.set({ ss_token: token, ss_user: user }, resolve)
  );
}

function clearSession() {
  return new Promise((resolve) => chrome.storage.local.remove(['ss_token', 'ss_user'], resolve));
}

async function supaSignIn(email, password) {
  const r = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPA_ANON },
    body: JSON.stringify({ email, password })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.msg || 'Sign-in failed');
  return { token: d.access_token, user: d.user };
}

async function supaSignUp(email, password) {
  const r = await fetch(`${SUPA_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPA_ANON },
    body: JSON.stringify({ email, password })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.msg || 'Sign-up failed');
  if (!d.access_token) throw new Error('Check your email to confirm your account, then sign in.');
  return { token: d.access_token, user: d.user };
}

function supaGoogleAuth() {
  return new Promise((resolve, reject) => {
    // Tell background SW to open the auth tab
    chrome.runtime.sendMessage({ action: 'startGoogleAuth' });

    // Listen for background SW to report completion
    function onMsg(msg) {
      chrome.runtime.onMessage.removeListener(onMsg);
      if (msg.action === 'authDone') {
        // Read the saved session
        chrome.storage.local.get(['ss_token', 'ss_user'], ({ ss_token, ss_user }) => {
          if (ss_token && ss_user) resolve({ token: ss_token, user: ss_user });
          else reject(new Error('Session not saved — please try again'));
        });
      } else if (msg.action === 'authError') {
        reject(new Error(msg.error || 'Sign-in failed'));
      }
    }
    chrome.runtime.onMessage.addListener(onMsg);
  });
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function showError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = 'block';
}
function hideError() {
  document.getElementById('auth-error').style.display = 'none';
}

function showApp(user) {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
  const hdrUser = document.getElementById('hdr-user');
  const avatar = document.getElementById('hdr-avatar');
  hdrUser.style.display = 'flex';
  const name = user?.user_metadata?.full_name || user?.email || '';
  avatar.textContent = name.charAt(0).toUpperCase() || '?';
  document.getElementById('btn-signout').addEventListener('click', async () => {
    await clearSession();
    location.reload();
  });
  initLectureUI();
}

// ── Lecture UI (same logic as before) ────────────────────────────────────────

function isLecturePage(url) {
  return LECTURE_PATTERNS.some((p) => p.test(url));
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
      await new Promise((r) => setTimeout(r, 600));
      return true;
    } catch {
      return false;
    }
  }
}

async function initLectureUI() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab.url || '';
  const lectureUI = document.getElementById('lecture-ui');
  const notLecture = document.getElementById('not-lecture');
  const pageStatus = document.getElementById('page-status');
  const captStatus = document.getElementById('capture-status');
  const btnCapture = document.getElementById('btn-capture');
  const btnSumm = document.getElementById('btn-summarize');
  const btnShow = document.getElementById('btn-show');
  const lastDiv = document.getElementById('last-summary');
  const lastTitle = document.getElementById('last-title');

  if (!isLecturePage(url)) {
    lectureUI.style.display = 'none';
    notLecture.style.display = 'block';
    return;
  }

  lectureUI.style.display = 'block';
  notLecture.style.display = 'none';

  const detectIcon = document.getElementById('detect-icon');
  const detectBadge = document.getElementById('detect-badge-text');
  if (url.includes('youtube.com')) {
    detectIcon.textContent = '▶';
    detectBadge.textContent = 'YouTube lecture detected';
    pageStatus.textContent = 'YouTube';
  } else if (url.includes('opencast')) {
    detectIcon.textContent = '🎓';
    detectBadge.textContent = 'Opencast lecture detected';
    pageStatus.textContent = 'Opencast';
  } else if (url.includes('zoom.us')) {
    detectIcon.textContent = '📹';
    detectBadge.textContent = 'Zoom recording detected';
    pageStatus.textContent = 'Zoom';
  }

  captStatus.textContent = 'Connecting…';
  const ok = await ensureContentScript(tab.id);
  if (!ok) {
    captStatus.textContent = '⚠️ Could not connect. Try refreshing the page.';
    return;
  }

  try {
    const status = await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
    if (status) {
      if (status.isCapturing) {
        captStatus.textContent = `🔴 Capturing — ${status.captureCount} captions`;
        btnCapture.querySelector('.ac-title').textContent = '⏹ Stop Capturing';
        btnCapture.dataset.state = 'stop';
      } else {
        captStatus.textContent =
          status.captureCount > 0
            ? `✅ ${status.captureCount} captions ready`
            : 'Ready — press Start Capturing';
      }
      if (status.title)
        pageStatus.textContent = status.title.slice(0, 40) + (status.title.length > 40 ? '…' : '');
    }
  } catch {
    captStatus.textContent = 'Ready — press Start Capturing';
  }

  chrome.storage.local.get('lastSummary', ({ lastSummary }) => {
    if (lastSummary) {
      lastDiv.style.display = 'block';
      lastTitle.textContent =
        lastSummary.title.slice(0, 50) + (lastSummary.title.length > 50 ? '…' : '');
    }
  });

  btnCapture.addEventListener('click', async () => {
    const ok2 = await ensureContentScript(tab.id);
    if (!ok2) {
      captStatus.textContent = '⚠️ Refresh the page and try again';
      return;
    }
    try {
      const status = await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
      if (status?.isCapturing) {
        await chrome.tabs.sendMessage(tab.id, { action: 'stopCapture' });
        btnCapture.querySelector('.ac-title').textContent = 'Start Capturing';
        delete btnCapture.dataset.state;
        captStatus.textContent = 'Stopped — press ✦ to summarize';
      } else {
        const started = await chrome.tabs.sendMessage(tab.id, { action: 'startCapture' });

        if (started?.needsAudio) {
          // Open recorder window — tabCapture works there with user gesture
          const recorderUrl = chrome.runtime.getURL(`recorder.html?tabId=${tab.id}`);
          chrome.windows.create({
            url: recorderUrl,
            type: 'popup',
            width: 400,
            height: 170,
            focused: true
          });
          captStatus.textContent = '🎙 Recorder window opened — click Start Recording there';
        } else {
          captStatus.textContent = '🔴 Capturing…';
        }

        btnCapture.querySelector('.ac-title').textContent = '⏹ Stop Capturing';
        btnCapture.dataset.state = 'stop';
      }
    } catch (e) {
      captStatus.textContent = '⚠️ ' + e.message;
    }
  });

  btnShow.addEventListener('click', async () => {
    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { action: 'showPanel' });
    window.close();
  });

  btnSumm.addEventListener('click', async () => {
    const ok2 = await ensureContentScript(tab.id);
    if (!ok2) {
      captStatus.textContent = '⚠️ Refresh the page and try again';
      return;
    }
    try {
      btnSumm.querySelector('.ac-title').textContent = 'Summarizing…';
      btnSumm.disabled = true;
      await chrome.tabs.sendMessage(tab.id, { action: 'showPanel' });
      await chrome.tabs.sendMessage(tab.id, { action: 'summarize' });
      btnSumm.querySelector('.ac-title').textContent = 'Summarize Lecture';
      btnSumm.disabled = false;
      window.close();
    } catch (e) {
      btnSumm.querySelector('.ac-title').textContent = 'Summarize Lecture';
      btnSumm.disabled = false;
      captStatus.textContent = '⚠️ ' + e.message;
    }
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Check existing session
  const { ss_token, ss_user } = await getSession();
  if (ss_token && ss_user) {
    showApp(ss_user);
    return;
  }

  // Auth screen wiring
  let isSignUp = false;
  const submitBtn = document.getElementById('auth-submit');
  const switchLink = document.getElementById('auth-switch-link');

  switchLink.addEventListener('click', () => {
    isSignUp = !isSignUp;
    hideError();
    submitBtn.textContent = isSignUp ? 'Create Account' : 'Sign In';
    document.querySelector('.auth-title').textContent = isSignUp
      ? 'Create account ✨'
      : 'Welcome back 👋';
    document.querySelector('.auth-sub').textContent = isSignUp
      ? 'Join Minallo to get started'
      : 'Sign in to use the Lecture Assistant';
    switchLink.parentElement.innerHTML = isSignUp
      ? 'Already have an account? <a id="auth-switch-link">Sign in</a>'
      : 'Don\'t have an account? <a id="auth-switch-link">Create one</a>';
    document.getElementById('auth-switch-link').addEventListener('click', arguments.callee);
  });

  submitBtn.addEventListener('click', async () => {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    hideError();
    if (!email || !password) {
      showError('Please enter your email and password.');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = isSignUp ? 'Creating…' : 'Signing in…';
    try {
      const { token, user } = isSignUp
        ? await supaSignUp(email, password)
        : await supaSignIn(email, password);
      await saveSession(token, user);
      showApp(user);
    } catch (e) {
      showError(e.message);
      submitBtn.disabled = false;
      submitBtn.textContent = isSignUp ? 'Create Account' : 'Sign In';
    }
  });

  // Allow Enter key to submit
  document.getElementById('auth-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitBtn.click();
  });

  // Google sign-in
  document.getElementById('btn-google').addEventListener('click', async () => {
    const btn = document.getElementById('btn-google');
    btn.disabled = true;
    btn.textContent = 'Opening Google…';
    hideError();
    try {
      const { token, user } = await supaGoogleAuth();
      await saveSession(token, user);
      showApp(user);
    } catch (e) {
      showError(e.message);
      btn.disabled = false;
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.08 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-3.59-13.46-8.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/><path fill="none" d="M0 0h48v48H0z"/></svg> Continue with Google`;
    }
  });
});
