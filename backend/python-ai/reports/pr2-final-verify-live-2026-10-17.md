# PR 2 final verification — bounded live confirmation (2026-10-17)

Separately authorized, tightly bounded re-run against the corrected commit
(`0314a74e`, fixing the prohibition-union and `run_in_threadpool` findings
from the independent review). Does not reuse or overwrite the prior
`student-intent-2026-10-17.*` evaluation. Executed in an isolated worktree,
not shared with any other concurrent agent.

**Limits enforced (before any request was sent): max 5 requests, max $0.25.**
Actual: 5 requests, $0.0005364, 0 SDK retries, 0 refused/unapproved requests.

| Case | Message intent | Raw model prohibited_tasks | Effective prohibited_tasks | Effective source | Preserved? |
|---|---|---|---|---|---|
| historical-bwl-page6 | "Explain... Do not summarize it." | `["course_summary"]` | `["course_summary"]` | semantic_model | yes |
| german-negative-instruction | "Fasse es nicht zusammen." | `["course_summary"]` | `["course_summary"]` | semantic_model | yes |
| contradictory-instruction | "Summarize this chapter. Do not summarize it." | rejected (self-contradictory) | `["course_summary"]` (fallback to deterministic base) | fallback | yes |
| negative-instruction-quiz | "Explain... Do not quiz me on it." | `["quiz_generation"]` | `["quiz_generation"]` | semantic_model | yes |
| positive-summary-request | "Summarize chapter 3 briefly." (control) | n/a — did not escalate | `[]` | deterministic | yes (none expected) |

All 5/5 cases: `explicit_prohibitions_preserved=True`, `trusted_fields_preserved=True`,
`shadow_payload_unchanged=True`, `enabled_plan_only_adds_signal=True`.

The historical regression case — which failed constraint preservation in the
prior evaluation of the unfixed `2f8f2400` — now preserves the prohibition
against the real model. The self-contradictory case (new, not in the prior
run) correctly fails closed to the deterministic baseline rather than
adopting either side of the contradiction.

Totals: 5 model invocations, 2544 prompt tokens, 258 completion tokens,
mean latency 1658ms, p95 2838ms. Full per-case detail and raw model
responses are in the adjacent `.json`; per-attempt ledger in `.ledger.jsonl`.
