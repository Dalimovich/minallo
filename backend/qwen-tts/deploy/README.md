# Qwen3-TTS deployment (separate host from python-ai)

This service is intentionally **not** co-located with `backend/python-ai` —
see `docs/CLAUDE.md`'s backend deployment invariant and the note in that
file's own section about why: the existing Hetzner box is a 4GB/2vCPU host
already close to its memory ceiling during OCR, with no GPU. Qwen3-TTS-0.6B
needs headroom that box doesn't have to spare.

`python-ai` is the **only** caller of this service (via `QWEN_TTS_SERVICE_URL`
+ the `X-Internal-Token` header, same shared-secret pattern used everywhere
else in this repo). The browser never talks to this host directly.

## Hardware — what this actually needs (not yet measured on real hardware)

I have not run Qwen3-TTS-12Hz-0.6B-Base on real hardware in this environment
(no GPU, no verified multi-GB model download here) — the numbers below are
sized from the model's public specs (≈0.6B parameters, comparable to other
0.6B-class speech/audio transformers), not a benchmark I ran. Treat them as a
starting point for provisioning, and **re-measure on the actual box** with a
handful of real German sentences before pointing production traffic at it —
`GET /health` reports `"ready": true` only after the model has loaded, and
the generation latency should be re-checked per section 14 of the task before
calling this "production ready."

| Resource | Estimate | Why |
|---|---|---|
| RAM | 6–8 GB | 0.6B params in fp16 is roughly 1.2GB of weights; PyTorch + activations + the FastAPI/gunicorn process + OS overhead pushes real usage well past that. Under-provisioning risks OOM kills exactly like the note in python-ai's own README about watching memory. |
| Disk | 8–10 GB | Model weights (~2GB+ depending on the exact checkpoint format) + PyTorch/CUDA libraries + Docker image layers. |
| CPU-only inference | Likely usable but slow | A 0.6B transformer doing autoregressive voice-cloned generation on CPU is realistically **several seconds to tens of seconds per sentence** — acceptable for a "Preparing audio..." loading step (section 11), not for anything real-time. |
| GPU inference | Recommended if latency matters | Even an entry-level GPU (e.g. a T4-class card) should bring per-sentence latency down to roughly sub-second-to-low-single-digit-seconds, but this is an estimate, not a measurement — confirm on the actual chosen box. |
| Model startup | 30s–a few minutes | Cold weight load + first-inference warm-up + the one-time voice-clone prompt build. `app/main.py` loads this in a background thread specifically so the container can start accepting `/health` requests immediately and report `"status": "loading"` rather than blocking. |

**Recommendation from the task's own cost-safety requirement:** provision a
modest CPU box first (e.g. 4 vCPU / 8GB RAM) and measure real per-sentence and
~30s/~60s-equivalent-text latency there before deciding whether a GPU box is
worth the added cost. Do not point production at this service until that
measurement is done and reported.

**If measured latency turns out too high for a synchronous request** (a
Hören lesson's audio takes noticeably longer to prepare than the lesson
itself, or upstream HTTP timeouts start firing), the next step is a small
job/polling API (`POST` returns a generation id, `GET` polls status) instead
of the current synchronous batch call — deliberately **not** built yet,
since building it before knowing whether it's needed would be premature.
Revisit only after real measurements say so.

## Concurrency — who actually controls how many generations run at once

The browser never controls this. `python-ai`'s `/tts/generate-batch`
(`TTS_BATCH_MAX_CONCURRENCY`, default 2) is the first bound: for one lesson's
worth of segments, only that many generation calls are ever in flight against
this service at once, regardless of how many segments the lesson has. This
service's own `QWEN_TTS_MAX_CONCURRENCY` semaphore (`app/engine.py`, default
2) is the second, global backstop — it caps true model-level concurrency
across *every* caller/session, not just one batch request. Keep
`TTS_BATCH_MAX_CONCURRENCY` <= `QWEN_TTS_MAX_CONCURRENCY` so python-ai never
queues more concurrent work against this host than the host itself will run
at once.

## One-time server setup

Same shape as `backend/python-ai/deploy/README.md`, on a **separate**
Ubuntu 24.04 server:

```bash
sudo mkdir -p /opt/minallo
sudo chown "$USER:$USER" /opt/minallo
git clone YOUR_REPOSITORY_URL /opt/minallo
cd /opt/minallo/backend/qwen-tts
cp .env.example .env
chmod 600 .env
```

Point a DNS `A` record (e.g. `tts.minallo.de`) at this server's public IPv4.
Allow inbound TCP 22/80/443 (UDP 443 for h3) in the firewall; restrict SSH to
your own IP. If your hosting provider supports it, also restrict inbound
80/443 to the python-ai server's IP as defense-in-depth on top of the
internal-token auth — this service has no other authentication layer.

## The German reference voice (REQUIRED — not included in this repo)

Per the task brief, this service must reuse **one approved, fixed German
reference clip + its exact transcript** for every voice-clone prompt — never
a scraped or arbitrary voice. I did not download or embed actual audio bytes
as part of this change (no verified network access to fetch and license-check
a real dataset file from this environment) — this is a required manual step
before the service can start successfully (`load()` in `app/engine.py`
raises if these files are missing).

**Recommended source: [Thorsten-Voice](https://www.thorsten-voice.de/)**, a
German voice dataset explicitly released under **CC0 (public domain)** by its
speaker for exactly this kind of reuse.

Steps:

1. Download one clean, single-speaker clip (a few seconds to ~15s of natural
   speech works well for voice-clone prompts) from the Thorsten-Voice dataset
   release (see the project's GitHub/Hugging Face listing for the current
   download link — pin the exact archive/commit you used).
2. Get its **exact matching transcript** (Thorsten-Voice ships transcripts
   alongside each clip) — the transcript must be verbatim, since
   `create_voice_clone_prompt` uses it to align text-to-speech.
3. Place the files at:
   - `backend/qwen-tts/app/voice/minallo_german_reference.wav`
   - `backend/qwen-tts/app/voice/minallo_german_reference.txt` (plain UTF-8
     text, the transcript only, no extra formatting)
4. Record which specific clip you used (filename + dataset version/commit) in
   `backend/qwen-tts/app/voice/SOURCE.md` (template already in this repo) —
   this is the license/provenance record for that specific audio.
5. Commit these two small files (a few hundred KB) — they get baked into the
   Docker image (`Dockerfile` copies `app/`) so every deploy reuses the exact
   same reference, and the voice never silently drifts between rebuilds.

Do not substitute a different voice per environment/deploy — the whole point
is "the user should always hear the same Minallo German voice."

## Environment

```dotenv
TTS_DOMAIN=tts.minallo.de
ACME_EMAIL=admin@minallo.de
QWEN_TTS_INTERNAL_SECRET=<generate with: openssl rand -hex 32>
```

`QWEN_TTS_INTERNAL_SECRET` must exactly match the value configured in
`backend/python-ai`'s `.env` (`QWEN_TTS_INTERNAL_SECRET`) — see
`backend/python-ai/app/config.py`.

## Deploy and update

```bash
chmod +x backend/qwen-tts/deploy/update.sh
cd backend/qwen-tts
./deploy/update.sh
```

The script refuses tracked local changes, fast-forwards, builds a
revision-tagged image, starts the service, and polls `/health` for up to 15
minutes (`"ready": true`) before declaring success — much longer than
python-ai's own script, since a cold model load can take a while. Falls back
to the previous image on failure, same as python-ai's script.

```bash
docker compose --env-file .env ps
docker compose --env-file .env logs -f --tail=150 tts caddy
curl --fail https://tts.minallo.de/health
```

Do not run `docker compose down -v` — deletes Caddy's certificate data.

## Cutover

Until this is deployed, measured, and confirmed acceptable, **production
stays on the browser SpeechSynthesis fallback** — `QWEN_TTS_SERVICE_URL` is
left unset in python-ai's `.env`, which makes `TTSProvider` report
unavailable and the frontend falls back automatically (see
`backend/python-ai/app/services/tts_provider.py` and the frontend
`lsPlayer` fallback path). Only set `QWEN_TTS_SERVICE_URL` in production once
you've verified real latency/quality on this host.
