# Reference voice provenance

Fill this in when you add `minallo_german_reference.wav` +
`minallo_german_reference.txt` (see ../../deploy/README.md). This record is
the license/provenance evidence for that specific audio clip — "Thorsten is
CC0" on its own is not enough; you need the exact file you actually used.

- Dataset name: Thorsten-Voice (https://www.thorsten-voice.de/)
- Dataset release / version / commit hash used: _fill in_
- Dataset download URL (the exact archive/release you pulled from): _fill in_
- Source clip filename within that dataset: _fill in_
- Exact transcript text used (copy verbatim — must match
  `minallo_german_reference.txt` exactly, not paraphrased):
  ```
  _fill in_
  ```
- SHA256 of `minallo_german_reference.wav`: _fill in_ (compute with
  `sha256sum minallo_german_reference.wav` or equivalent)
- Retrieval date (when this clip was actually downloaded, not today's date
  if that differs): _fill in_
- License: CC0 1.0 Universal (public domain dedication) — confirm this
  still applies to the specific release/version above; link the exact
  license notice from that release if the dataset repo states one.
- Added to this repo by: _fill in_
- Added on (commit date): _fill in_

Do not replace these files without updating this record — every deploy
reuses this exact clip so the Minallo German voice never silently changes,
and a future audit needs to trace the clip in production back to this file,
not to a general claim about the dataset's license.
