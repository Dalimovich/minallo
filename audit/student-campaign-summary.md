# Student resolver campaign rerun

Executed again 2026-09-11 at HEAD `786f9b1aa88855b478ef82d2bd6b33ba6da94f4a` using:

```text
PYTHONPATH=backend/python-ai
backend/python-ai/.venv/Scripts/python.exe audit/repros/student_campaign.py
```

Exit code **0**. The existing script was unchanged. It rewrote `audit/student-journeys.json` with **50 resolver scenario traces**, including **32 injected semantic-model timeouts**. Classifications match the preceding 2026-09-10 run. Exit zero means the campaign executed, not that every scenario met a correctness oracle: this script records classifications without asserting expected outputs.

| Execution lane recorded | Scenarios |
|---|---:|
| fast_contextual | 31 |
| fast_grounded | 5 |
| fast_general | 4 |
| standard_rag | 4 |
| deep_reasoning | 2 |
| visible_page | 2 |
| full_document | 1 |
| web | 1 |

The R9 gate now processes S02 grounded clarification and S49 reload-follow-up through contextual fallback. Both retain `reuse_prior_grounded` and choose `fast_contextual`; S02 task is `explain`, S49 task is `compare`. S38 currentness verification selects `web`. These are actual outputs of real dialogue/evidence/document-access/execution code with a synthetic previous answer.

Remaining suspicious classifications warrant scoped endpoint interpretation, rather than automatic defect claims:

- S05 exact professor location reports `reuse_prior_grounded` but chooses `standard_rag`, showing a layer disagreement requiring the final source/preflight trace.
- S08 “What does this mean?” after a grounded diagram answer chooses contextual reuse. It does not exercise real viewer capture, so cannot distinguish reference to the previous answer from a changed visible page.
- S09 explicit PDF-only request chooses contextual reuse in this runner. The runner omits stream preflight, where selected-document constraints are applied; it cannot prove an actual silent-general or scope-broadening failure.
- S06 unrelated capital question reports a provisional course evidence requirement but chooses fast general. The runner does not call the final source router. This is a diagnostic mismatch, not evidence that course retrieval ran.
- S17/S18/S26/S43 record task families for Flashcards, ExamForge, Study Plan, and Deep Learn. They do not execute frontend configuration or feature generation, so contextual lanes cannot establish whether those tools launch correctly.

## What was and was not executed

Executed: real deterministic dialogue resolution, conditional real semantic fallback, evidence requirement, document-access selection, and execution planning. Previous assistant messages and provenance are fixtures. The semantic provider is deliberately unavailable when called; this tests outage behavior rather than normal live semantic understanding.

Not executed: authenticated HTTP, full stream preflight, final source routing, document lookup, embeddings, retrieval, answer generation, terminal states, visible UI output, Saved reopen, or persistent worker resume. Named scenario events are explicitly recorded in `scenarioEventNotInjected`; they are context labels, not failure injections. The traces themselves retain `not executed` for tools/retrieval, source scope, terminal state, and visible answer/error.

This is useful adversarial input diversity and resolver diagnostics. It is **not 50 passing multi-turn user journeys**, not live-model evaluation, and not a substitute for the permanent critical-journey/browser suite.
