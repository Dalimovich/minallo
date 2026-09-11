# Evidence and execution routing investigation

Audited SHA: `1ecddd6b1beaa19a1c633160ef651c2fbd78511f`.

## Finding ROUTE-1

### Severity
P0 (explicit source request answered ungrounded)

### User scenario
Select Internet as the source and ask â€œWhat is torsion?â€.

### Expected
The explicit source choice requires web evidence or accurate typed recovery.

### Actual
`AskStreamRequest(courseId='', sourceMode='internet', question='What is torsion?')` reaches FAST_GENERAL and returns the injected general-model answer. No web source resolution executes before this shortcut.

### Evidence
Executed real endpoint/SSE probe `audit/repros/test_conversation_full_document.py::test_explicit_internet_mode_bypassed_by_fast_general`; access checks and answer provider are mocked. Real routing selects FAST_GENERAL. This establishes API behavior, not a browser click trace.

### Root cause
Execution planning runs before authoritative source classification. `classify_task_profile` honors `sourceMode=course_files` but web selection depends only on lexical current/action signals. The early fast path exits before `classify_source_scope` can honor explicit internet mode. The same ordering also enables selected-document constraints to be skipped by early general routes; that additional case was inspected, not executed here.

### Files
`backend/python-ai/app/services/execution_router.py`: `classify_task_profile`, `resolve_execution_plan`. `backend/python-ai/app/routers/stream.py`: planning at ~1422 and early return at ~1562; later source classification at ~3280. `backend/python-ai/app/services/source_router.py`: `classify_source_scope`.

### Structural fix
Resolve explicit evidence/source constraints before choosing an execution lane, and require every early path to satisfy the resolved constraint. Keep task classification separate. Coordinator owns implementation.

### Regression test
Parameterize explicit source modes and task families through the real endpoint; assert provider selection, no general substitution for web/strict document requests, and unchanged requested scope. Include explicit web UI mode with no lexical web keywords.

### Related findings
CONV-1 (lane incorrectly controls provenance). Existing medium-complexity new-topic default is documented in source as a known conservative RAG gap; tests cover general recovery, so no additional P1 is asserted without a failing execution.

## Task/evidence matrix

This is a code-traced planning matrix, not 48 live product runs. General/course cells use representative self-contained wording; follow-up assumes provenance-aware continuation. Web cells show the explicit-mode defect rather than assuming lexical keywords. FG=fast_general, FC=fast_contextual, FR=fast_grounded, R=standard_rag, D=deep_reasoning, V=visible_page, F=full_document. A slash means wording/complexity changes the lane.

| Task | General | Course | Selected docs | Visible page | Full document | Web UI mode |
|---|---|---|---|---|---|---|
| Explain | FG | FR/R | FG or FR/R depending sourceMode | V | F | FG/R (defect) |
| Calculate | D | D | D | V | F | D (defect) |
| Compare | R | R | R | V | F | R (late source routing) |
| Follow-up | FC | FC for reuse, FR for fresh | FC/FR | V | F | FC/FR (preflight defect risk) |
| Verify | FC/R | FR/R | FR/R | V | F | FC/R (preflight defect risk) |
| Summarize | R | R | R | V | F | R (late source routing) |
| Generate | R | R | R | V | F | R (late source routing) |
| Extract | R | R | R | V | F | R or F when exhaustive |

| Evidence context | EvidenceRequirement | SourceScope contract | RetrievalScope | DocumentAccess | Fallback policy |
|---|---|---|---|---|---|
| General follow-up | conversation_only/general_knowledge | general_knowledge | retained UI scope, unused | relevance | general recovery |
| New general task | defaults course_retrieval (known mismatch) | auto resolved later | retained UI scope | relevance | relevance-gated general recovery |
| Explicit course | course_retrieval when source wording recognized | course_files | course | relevance | strict mode must remain grounded |
| Selected documents | no dedicated dialogue enum; course_retrieval expected | course_files | documents with exact IDs | relevance | selected_files_only; must not broaden |
| Visible page | not separately authoritative in dialogue layer | page/document evidence | retained unchanged | visible_page | typed page recovery |
| Full document | not separately authoritative in dialogue layer | scoped document evidence | retained unchanged | full_document | typed coverage/processing recovery |
| Web | web with explicit lexical evidence; UI mode not consumed | internet | retained UI scope, unused | relevance | web recovery; early FG currently violates |
| Grounded reuse | reuse_prior_grounded | previous grounded scope | retained, no retrieval | relevance | reuse prior answer; provenance currently lost |

The generic EvidenceRequirement layer does not fully encode selected documents, visible page or full document; later GroundingRequest/ResolvedDocumentAccess carry these constraints. This is an architectural observation, not automatically a defect. Existing grounding unit tests confirm viewer context does not mutate retrieval scope. No live browser scope-switch test was performed here.

## Execution record

Audit probes: 3 passed, intentionally asserting baseline defective behavior. Existing focused suites: 161 passed, 6 skipped (semantic live-model cases). Combined first run had a temporary probe fixture omission (`courseId` missing), then the corrected probe-only run passed all three. No production changes.

