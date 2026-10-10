# Phase 11 — Availability Gate (documentation only, no flags touched)

## Eligibility rule
A part is eligible for a human to consider flipping `available=True` only when **all** of the
following hold simultaneously:

```
official_spec_status == PASS
AND profile_status == PASS
AND implementation_status == PASS
AND content_status == PASS
AND grading_status == PASS
AND delivery_status == PASS
AND manual_review == CLEAR
```

No unverified or partially-verified layer may roll up to PASS. `UNVERIFIED`, `PARTIALLY_VERIFIED`,
`MISMATCH`, `MISSING`, `BLOCKED`, and `MANUAL_REVIEW` all disqualify a part from this gate. Passing
this gate is a **necessary, not sufficient**, condition for release — even a part that reaches
every-layer-PASS still requires the human qualification-and-sign-off process already defined in
`audit/testdaf-offline/LIVE_QUALIFICATION_PLAN.md` (3 clean live samples, 5 if variability, human
review against the checklists in `CONTENT_AUDIT.md`) before any `available` flag is actually
flipped.

## Current state (this audit changed none of it)
Per `COMPLETE_TASK_MATRIX.md` / `data/complete_task_matrix.json`: **zero parts pass this gate
today** — every one of the 44 in-scope parts has at least one non-PASS layer (`content_status` is
`UNVERIFIED` for literally all 44, since no live content has been reviewed anywhere, which alone is
sufficient to fail the gate for every part regardless of any other layer's status).

## Confirmation: no availability flag was changed by this audit
```
grep -rn "available=True" backend/python-ai/app/services/german_exams/*.py
```
must return **zero matches** — run as the very last verification step before the final commit and
push (see the closing section of the final report for the actual command output). This audit did
not add, remove, or modify any `available=` assignment anywhere in `german_exams/*.py`.
