# Reference voice provenance

Fill this in when you add `minallo_german_reference.wav` +
`minallo_german_reference.txt` (see ../../deploy/README.md). This record is
the license/provenance evidence for that specific audio clip — "Thorsten is
CC0" on its own is not enough; you need the exact file you actually used.

- Dataset name: Thorsten-Voice — TV-44kHz-Full (Hugging Face), subset
  `TV-2022.10-Neutral` (https://www.thorsten-voice.de/)
- Dataset release / version / commit hash used:
  huggingface.co/datasets/Thorsten-Voice/TV-44kHz-Full, revision
  `2b61b98fa8f99abd1ce1587b4bf413d6ebc217d5`, config `TV-2022.10-Neutral`,
  split `train`, row_idx `43`
- Dataset download URL (the exact archive/release you pulled from):
  https://huggingface.co/datasets/Thorsten-Voice/TV-44kHz-Full (row fetched
  via the public HF datasets-server API: `GET
  https://datasets-server.huggingface.co/rows?dataset=Thorsten-Voice%2FTV-44kHz-Full&config=TV-2022.10-Neutral&split=train&offset=43&length=1`,
  which resolves to a signed per-row asset URL under
  `datasets-server.huggingface.co/cached-assets/Thorsten-Voice/TV-44kHz-Full/.../TV-2022.10-Neutral/train/43/audio/audio.wav`)
- Source clip filename within that dataset: row id
  `dd01c488-10f3-a683-00cf-4d215f4d9b19---b577e99f993dde251edb8ec6e0df7646`
  (dataset has no separate on-disk filename; this id is the row's unique
  identifier in the `id` column)
- Exact transcript text used (copy verbatim — must match
  `minallo_german_reference.txt` exactly, not paraphrased):
  ```
  dabei solle sichergestellt werden, dass abstands- und hygienebestimmungen eingehalten werden.
  ```
- SHA256 of `minallo_german_reference.wav`:
  `da206b358118e299ee8a5df4f6167c0c382e58494f876a99595b847681310713`
  (computed with `sha256sum minallo_german_reference.wav`)
- Retrieval date (when this clip was actually downloaded, not today's date
  if that differs): 2026-09-16
- License: CC0 1.0 Universal (public domain dedication), as stated on the
  Thorsten-Voice/TV-44kHz-Full dataset card
  (https://huggingface.co/datasets/Thorsten-Voice/TV-44kHz-Full) — this
  dataset card is the canonical CC0 release; do not substitute the
  `Thorsten-Voice/TV-24kHz-Neutral` resample, whose HF card metadata shows
  a `cc-by-4.0` tag instead (unclear if that's a metadata error or an
  intentionally different re-license — avoided here to stay on the
  unambiguous CC0 source).
- Row metadata recorded alongside the clip (from the dataset's own
  columns, not re-derived): `subset=TV-2022.10-Neutral`, `style=neutral`,
  `samplerate=44100`, `durationSeconds≈5.2`,
  `recording_year-month=2021-08`, `microphone=good_rodePodcaster`,
  `speaker=Thorsten Müller (Thorsten-Voice)`, `language=german`
- Added to this repo by: Claude Code (Sonnet 5), at the direction of
  mohamedalimariam@minallo.de
- Added on (commit date): 2026-09-16

Do not replace these files without updating this record — every deploy
reuses this exact clip so the Minallo German voice never silently changes,
and a future audit needs to trace the clip in production back to this file,
not to a general claim about the dataset's license.
