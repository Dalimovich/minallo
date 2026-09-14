// Recorder page — tab audio capture → local Python Whisper server

const params = new URLSearchParams(location.search);
const lectureTabId = parseInt(params.get('tabId'), 10);

const statusEl = document.getElementById('status');
const btn = document.getElementById('btn');
const timerEl = document.getElementById('timer');

const SERVER = 'http://localhost:5050';

let mediaRecorder = null;
let audioChunks = [];
let timerInterval = null;
let seconds = 0;

function setStatus(text) {
  statusEl.textContent = text;
}

// ── Check if local server is running ─────────────────────────────────────

async function checkServer() {
  try {
    const r = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

// ── Button ────────────────────────────────────────────────────────────────

btn.addEventListener('click', async () => {
  if (btn.dataset.state === 'recording') {
    stopRecording();
  } else if (btn.dataset.state === 'transcribe') {
    await transcribeAndSend();
  } else if (btn.dataset.state === 'download') {
    downloadRecording();
  } else {
    await startRecording();
  }
});

// ── Recording ─────────────────────────────────────────────────────────────

async function startRecording() {
  if (!lectureTabId) {
    setStatus('⚠️ No lecture tab ID — close and try again');
    return;
  }

  btn.disabled = true;
  setStatus('🎙 Connecting to lecture audio…');

  chrome.tabCapture.getMediaStreamId({ targetTabId: lectureTabId }, async (streamId) => {
    if (chrome.runtime.lastError || !streamId) {
      setStatus(
        '⚠️ Could not capture tab audio: ' + (chrome.runtime.lastError?.message || 'unknown')
      );
      btn.disabled = false;
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
        video: false
      });

      audioChunks = [];
      const mimeType =
        ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((m) =>
          MediaRecorder.isTypeSupported(m)
        ) || '';
      mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };
      mediaRecorder.start(5000);

      seconds = 0;
      timerInterval = setInterval(() => {
        seconds++;
        const m = Math.floor(seconds / 60);
        const s = String(seconds % 60).padStart(2, '0');
        timerEl.textContent = `${m}:${s} recorded`;
      }, 1000);

      setStatus('🔴 Recording lecture audio…\nPress Stop when done.');
      btn.textContent = '⏹ Stop Recording';
      btn.dataset.state = 'recording';
      btn.disabled = false;

      chrome.tabs.sendMessage(lectureTabId, { action: 'audioRecordingStarted' }).catch(() => {});
    } catch (e) {
      setStatus('⚠️ ' + e.message);
      btn.disabled = false;
    }
  });
}

function stopRecording() {
  clearInterval(timerInterval);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  const mins = Math.max(1, Math.round(seconds / 60));
  setStatus(`✅ ${mins} min recorded. Transcription coming soon — download the audio for now.`);
  btn.textContent = '⬇ Download Recording';
  btn.dataset.state = 'download';
  btn.disabled = false;
}

function downloadRecording() {
  const mimeType = mediaRecorder?.mimeType || 'audio/webm';
  const blob = new Blob(audioChunks, { type: mimeType });
  const url = URL.createObjectURL(blob);
  const ext = mimeType.includes('ogg') ? 'ogg' : 'webm';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const a = document.createElement('a');
  a.href = url;
  a.download = `minallo-lecture-${ts}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus('💾 Saved. You can close this window.');
}

// ── Transcription via local Python server ─────────────────────────────────

async function transcribeAndSend() {
  btn.disabled = true;
  setStatus('🧠 Transcribing with local Whisper… (may take a minute)');

  try {
    const mimeType = mediaRecorder?.mimeType || 'audio/webm';
    const blob = new Blob(audioChunks, { type: mimeType });

    const formData = new FormData();
    formData.append('file', blob, 'lecture.webm');

    const res = await fetch(`${SERVER}/transcribe`, {
      method: 'POST',
      body: formData
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }

    const data = await res.json();
    if (!data.text || data.text.trim().length < 5) throw new Error('Empty transcript');

    setStatus('✅ Done! Sending to AI for summary…');
    chrome.tabs
      .sendMessage(lectureTabId, { action: 'whisperTranscriptReady', text: data.text })
      .catch(() => {});
    setTimeout(() => window.close(), 2000);
  } catch (e) {
    setStatus('⚠️ ' + e.message);
    btn.disabled = false;
  }
}
