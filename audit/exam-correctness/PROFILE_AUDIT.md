# Phase 2 — Profile Validation

Compares `OFFICIAL_SPEC_MATRIX.md` against the three profile files field-by-field. Because the
Goethe/TestDaF spec-matrix cells were themselves transcribed (by a prior verification pass) from
the profile files' own cited sources, most of their fields PASS by construction — this audit's own
contribution here is (a) checking internal consistency/arithmetic, (b) flagging the fields Phase 1
could not independently confirm, and (c) one fresh finding for TELC. No profile field was changed
in this phase (a correction would be its own separately-labeled commit — none was warranted this
session; see "Corrections considered but not made" below).

## telc Deutsch C1 Hochschule

| Field | Part | Status | Note |
|---|---|---|---|
| Lesen+Sprachbausteine shared 90 min | module | PASS | Matches `LESEN_SPRACHBAUSTEINE_SHARED_MINUTES = 90` and secondary-source corroboration |
| Schreiben 70 min | schreiben_1 | PASS | Matches `SCHREIBEN_MINUTES = 70` and secondary-source corroboration ("70 Minuten") |
| Schreiben ≥350 words | schreiben_1 | PASS | Matches `wordCountMin: 350` and secondary source |
| Schreiben max points (48) | schreiben_1 | UNVERIFIED | Not independently confirmed against a primary telc.net source this session |
| Hören item counts (10/10/10) and points (8/20/20) | hv1/hv2/hv3 | UNVERIFIED | Not independently confirmed against a primary telc.net source this session; profile itself is the only source found |
| Sprechen 20 min prep | sprechen module | PASS (partial) | Secondary source confirms "Vorbereitungszeit: 20 Minuten" at module level; profile has no module-level `preparation_seconds` set for TELC speaking at all (`module_specs["speaking"]` has no `ModuleSpec` entry — see IMPLEMENTATION_AUDIT.md) — **MISSING**, not present to compare |
| Sprechen total ~16 min vs. part-level 11 min (180+120+360s) | sprechen_1/2 | **MISMATCH (flagged, not corrected)** | Secondary source states "~16 Minuten" total Sprechen; the profile's own `presentationSeconds`+`summaryFollowupSeconds`+`discussionSeconds` sum to 660s = 11 min. This is a genuine open discrepancy — it may reconcile via transition/setup time not modeled as a constraint, or the secondary source may itself be approximate. **Not corrected** — no primary source confirms which figure (if either) is authoritative. Recorded as MISMATCH, routed to MANUAL_REVIEW.md |
| Pass mark 60%/60%, separately scored | module | PASS (as a fact) but **not implemented anywhere in code** | `result.py`'s module-separation design is consistent with "separately scored," but no pass-mark constant exists in `telc_c1_hochschule.py` itself (Goethe has `MODULE_PASS_POINTS = 60`; TELC has no equivalent). MISSING field, not a mismatch |
| Sprachbausteine (all fields) | sprachbausteine_1 | **EXCLUDED PER TASK INSTRUCTIONS** | Not audited — explicitly out of scope |

## Goethe-Zertifikat C1

All structural fields transcribed in `OFFICIAL_SPEC_MATRIX.md` trace directly to the profile file
(they were sourced FROM it, following the prior verification pass's own citations), so a
field-by-field diff against itself is vacuous by construction. This audit instead checked for
**internal arithmetic/consistency** issues:

| Check | Result |
|---|---|
| `RAW_TO_RESULT_POINTS` table: 0→0, 30→100, monotonic non-decreasing, length 31 | PASS — verified by re-reading the tuple; `ScoringSpec.__post_init__` also enforces this at import time (would raise `ValueError` otherwise — confirmed by the profile module importing successfully) |
| `RAW_TO_RESULT_POINTS[5] == 17` per the profile's own docstring note (Durchführungsbestimmungen, not the Handbuch's printed "19") | PASS — tuple value at index 5 is `17`, matches the documented correction |
| Reading module: 4 parts' item counts (8+7+8+7=30) match `RECEPTIVE_RAW_ITEMS = 30` | PASS |
| Listening module: 4 parts' item counts (6+9+8+7=30) match `RECEPTIVE_RAW_ITEMS = 30` | PASS |
| Writing: schreiben_1 (60) + schreiben_2 (40) = `MODULE_MAX_POINTS = 100` | PASS |
| Writing criteria max points sum to part max: schreiben_1 (14+14+16+16=60 ✓), schreiben_2 (10+10+10+10=40 ✓) | PASS |
| Sprechen per-criterion weights | **UNVERIFIED, correctly left absent** — profile docstring states weights are "added when Sprechen is implemented"; this is honest non-fabrication, not a gap in the profile itself |
| `module_specs` reading/listening/writing/speaking durations present, in the stated order | PASS |
| No `language_elements` module present | PASS — matches Phase 1 (Goethe C1 genuinely has no Sprachbausteine) |

**Result: PASS on every checkable field.** Nothing UNVERIFIED-by-Phase-1 was found to be silently
filled in by the profile with an invented number — the profile itself declines to state the one
field (Sprechen criterion weights) that Phase 1 also could not verify.

## Digital TestDaF

Same construction note as Goethe: Phase 1's TestDaF cells were sourced from the profile via a
prior verification pass. Internal-consistency checks:

| Check | Result |
|---|---|
| `lesen_2` itemCount = 5 (not the earlier paused guess of 4) | PASS — profile has `itemCount=5`, matches the documented correction and its own inline comment |
| `lesen_7` `requiredSourceKinds=("text","graphic")` present | PASS — matches the documented correction |
| `MODULE_METADATA["reading"]["itemCount"] == 35` matches sum of per-part itemCounts (5+5+7+4+7+4+3=35) | PASS |
| `sprechen_4.preparationSeconds == 90` (corrected from "missing entirely") | PASS |
| `sprechen_6` fields unchanged, already correct per Phase 2 of the prior audit | PASS |
| `SCORING_METADATA["rawToScaledConversionAvailable"] == False` and no TDN-computing function exists anywhere (`result.py` has no TDN classifier) | PASS — correctly represents an unresolved official fact as unresolved, not fabricated |
| `TASK_TYPES` registry: `paragraph_ordering` (lesen_2) and `reading_summary_error_detection` (lesen_7) are `False` (unimplemented) while the other 5 reading task types are `True` | Consistency note only — routed to IMPLEMENTATION_AUDIT.md, not a profile-fact issue |
| All 7 speaking task types (`spoken_advice` etc.) — registry status | Consistency note only — routed to IMPLEMENTATION_AUDIT.md |
| Every part `available=False` | PASS — confirmed by direct read of `testdaf_digital.py`; `_part()` helper hardcodes `available=False` for every part it builds, so no part can accidentally default to `True` the way TELC's do |

**Result: PASS on every checkable field**, including the two corrections already made and
committed in a prior session (this audit did not need to make new corrections here).

## Corrections considered but not made
None. This audit found no field where Phase 1's (necessarily reduced-depth) research produced
strong enough independent evidence to justify changing a profile file. The one open discrepancy
found (TELC Sprechen ~16 min vs. 11 min part-level sum) is recorded as a MISMATCH for manual
review, not resolved by guessing which number to trust.

## Machine-readable form
See `data/profile_audit.json`.
