# Semantic Student Intent Layer — Milestone 1: Audit and Design

**Status:** Milestone 1 only (audit and design). No Milestone 2+ code written. No merge to `main`, no deploy, no production flag change, no paid model calls made by this task (one historical real-model evaluation, already committed on `main` before this task started, is cited as evidence — see §9).

## 0. Baseline and branch inventory (re-verified, not trusted from the brief)

Worktree: `C:/Users/dalim/AppData/Local/Temp/minallo-semantic-m1-audit`, branch `feature/semantic-intent-unification`, created from `origin/main`.

**`origin/main` = `31f5b9ee2502cddc46be69a35b09799b41c73807`** — identical to the brief's 2026-10-17 snapshot SHA. No drift.

### Correction to the brief's §0: PR1 and PR2 are not pending branches — they are already merged into `main`

```
git merge-base --is-ancestor 5a6a9317 31f5b9ee  → YES (PR1 is an ancestor of main)
git merge-base --is-ancestor 0314a74e 31f5b9ee  → YES (PR2 is an ancestor of main)
git merge-base --is-ancestor 5df5e313 31f5b9ee  → NO  (PR3 only — still separate)
```

`git ls-remote origin` confirms: `feature/semantic-intent-model` (PR2's branch) points at `31f5b9ee` — **the exact same commit as `origin/main`**. `feature/semantic-student-intent-layer` (PR1, `5a6a9317`) is three commits behind that, also fully on `main`. Only `feature/semantic-intent-constraints` (PR3, remote tip `9b00d3d1`) is genuinely unmerged.

Consequence: everything the brief's §0 table describes as "exists in `student_intent.py`" is not a future state to design toward — it is **live on `origin/main` today**, including the bounded semantic escalation call (PR2), not just the deterministic adapter (PR1). `docs/semantic-intent-layer-map.md` is also now on `main` (the brief's claim that it isn't was true only before PR1/PR2 merged).

### Updated worktree/branch map (re-run `git worktree list`, not trusted from the brief)

| Worktree | Branch | HEAD | Relationship to `main` | Role (verified) |
|---|---|---|---|---|
| `.claude/worktrees/agent-a4ef63698c2964b32` | `feature/semantic-student-intent-layer` | `5a6a9317` | Ancestor of main (merged) | PR1 — contract + deterministic adapter + flag plumbing. Clean, nothing beyond main. |
| `.claude/worktrees/pr2-semantic-intent-model` | `feature/semantic-intent-model` | `0314a74e` | Ancestor of main (merged, one commit behind tip) | PR2 — semantic escalation call. Clean. |
| `.claude/worktrees/pr3-intent-constraints` | `feature/semantic-intent-constraints` | `5df5e313` (local) | **Not** an ancestor of main; remote tip is `9b00d3d1`, two commits behind local | PR3 — `AnswerConstraints` (release-side constraints). Local-only commits `e6271991` and `5df5e313` **do exist** (verified directly), unpublished. |
| `C:/…/Temp/minallo-semantic-live-eval` | `remediation/semantic-intent-pr2` | `411627b6` | Ancestor of main (3 commits behind tip) | Produced the real-model eval report (§9). **Working tree is dirty**: uncommitted edits to `stream.py`, `answer_stream.py`, `general_answer.py`, `student_intent.py`, plus two new untracked files `student_answer_policy.py` / `student_intent_prompt.py` — a **third, independent, uncommitted** release-constraint detector (see §7.1 flag). |
| `C:/…/Temp/minallo-semantic-pr2-baseline` | detached | `411627b6` | Same commit as remediation's clean base | Pure comparison snapshot; nothing to audit beyond the commit above. |
| `C:/…/Temp/minallo-rc-provisional` | `integration/release-candidate-provisional` | `933ec6f7` | Descendant of main; not merged back | **Real integration attempt** combining PR3 (including its unpublished commits), `fix/course-grounding-evidence-gate`, `fix/exercise-and-quantity-extraction`, and `fix/visual-final-answer-safety`. See §8 for the conflict it surfaced. |
| `C:/…/Temp/minallo-course-grounding-fix` | `fix/course-grounding-evidence-gate` | `9efa7331` | Diverged from main | Grounding evidence-gate agent. Touches `ask.py`, `stream.py`, `course_grounding.py`, `dialogue_state.py`, `reliability.py`, `source_router.py` — 1,714 lines, 3 new test files. |
| `C:/…/Temp/minallo-visual-final-answer-safety` | `fix/visual-final-answer-safety` | `07afee52` | Diverged from main | Codex visual-safety agent. New file `visual_answer_validation.py`; rewrites parts of `answer_stream.py` and `visual_repair.py` ("centralize final-candidate acceptance gate"). |
| `minallo-ai-answer-quality` | `fix/no-course-chat-language` | `42b4d4c2` | Diverged from main | Directly touches `services/chat.py` and language logic (`german_learner_profile.py`, prompt order, model routing). Confirmed in scope for §4.8/§2.6 coordination. |
| `minallo-qa/worktree-origin-main` | `main` | `0cad2e22` | main (ahead of my branch point by later work) | Clean reference copy. |

`fix/exercise-and-quantity-extraction` (the main repo's own checked-out branch, `5b77d006`) is 4 commits ahead of what `rc-provisional` integrated (`59aa3d80`) — the integration candidate is already stale against the user's own current branch.

---

## 1. Current intent call graph (traced in this worktree, line numbers from `origin/main`)

`POST /ask-stream` → `ask_stream_endpoint` (`routers/stream.py:~1545`):

1. `resolve_document_access(...)` → `ResolvedDocumentAccess` (RELEVANCE / VISIBLE_PAGE / FULL_DOCUMENT) — trusted scope signal, from viewer context only.
2. `resolve_dialogue(...)` (`dialogue_state.py:609`, deterministic regex) → `DialogueResolution` (dialogue_act, resolved_request, active/previous exercise labels, `response_language`, `requested_depth`, `TurnRelation`, `SpeechAct`, `TaskFamily`, `EvidenceRequirement`, confidence).
3. **Classification call #1**: if `needs_semantic_resolution(...)` (`dialogue_state.py:904`) → `resolve_dialogue_semantically(...)` (`dialogue_state.py:960`, `stream.py:1680`) — structured-output call, `reasoning_effort="low"`, `INTERACTIVE_CLASSIFIER_TIMEOUT`, `max_retries=1`, fails closed to `_safe_conversational_fallback` below confidence 0.65.
4. `is_pure_social_turn(...)` short-circuits chitchat.
5. **Classification call #2 (conditional)**: if `semantic_intent_mode != "off"` (`stream.py:1732-1754`) → `interpret_student_intent(...)` (`student_intent.py:313`) — deterministic adapter (`classify_academic_intent`, `_detect_prohibited_tasks`, deictic/visual regex) plus, if `_needs_semantic_path(...)` (`student_intent.py:157`) fires, a **second** structured-output call `_semantic_model_call` (`student_intent.py:173`) mirroring call #3's shape exactly (same timeout, same retry policy, same fail-closed contract). Result is `intent_for_router(mode, intent)` — `None` unless `mode == "enabled"`.
6. `resolve_execution_plan(...)` (`execution_router.py:275`) — **the single authoritative router**. Consumes `student_intent` only as `execution_signal(student_intent)` → one inert string appended to `ExecutionPlan.signals`; never reads task/depth/prohibitions/constraints from it.
7. Dispatch into `stream_answer(...)` (`answer_stream.py`), which does its **own, third**, independent task classification: `classify_academic_intent(question, routing_chunks, metadata)` (`answer_intent.py`) → `AcademicIntent`, feeding `pick_system_prompt` / `intent_style_instruction` (`answer_intent.py:676`) — the place prohibition text ("do NOT include a Summary heading") is actually injected into the prompt, by **re-running the same negation regexes a third time** (`_SUMMARY_PROHIBITION_RE`/`NEGATED_QUIZ_RE`) independently of `StudentIntent.prohibited_tasks`.
8. `_requires_verified_buffering(...)` (`stream.py:760`) and `coverage_buffering` (`multi_item_result.evidence`) jointly decide `buffer_answer_output` (`stream.py:6041`), gating whether the SSE stream is held back for validation (`stream.py:6234`, `6678`). This never reads `StudentIntent` either.

**Net finding, confirmed by direct line reading, not inference**: `StudentIntent` is computed (in "enabled" mode) and then **discarded** except for one inert marker string. Every actual decision — task shape, prohibitions actually rendered into the prompt, buffering, language, evidence requirements — is still made by independent regex sites that never see it. This matches and sharpens the brief's §0 claim.

### What data is lost between interpretation and final validation

- `StudentIntent.prohibited_tasks` (deterministic + model-unioned) is computed but never reaches `intent_style_instruction`, which re-derives its own negation signal from `NEGATED_SUMMARY_RE`/`NEGATED_QUIZ_RE` directly on the raw question. Two sources of truth for the same fact, by construction.
- `StudentIntent.depth`/`teaching_style`/`visual_requirement` are computed and then dropped on the floor entirely — no consumer reads them at all (confirmed: `intent_for_router`'s only effect downstream is `execution_signal`).
- PR3 (unmerged) adds `AnswerConstraints` (`withhold_answer`/`hint_only`/`one_question_at_a_time`, all-False default) to `StudentIntent` and *does* wire it into `answer.py`/`answer_stream.py` completeness-repair and `validate_and_finalize_exam_output`/`verify_and_repair_visual_assignment`, plus cache-key fingerprinting — but see §8, the real-world mocked test for this wiring is currently 15/17 failing.

---

## 2. OFF / SHADOW / ENABLED today

- **OFF** (`Settings.semantic_intent_mode` default, `config.py:124`): `interpret_student_intent` is **never invoked** — guarded at the call site (`stream.py:1734`), not computed-and-discarded. Byte-identical to pre-PR1 behavior. Verified by PR1's own test (`test_student_intent.py`, "flag-off parity").
- **SHADOW**: computed (including the second model call if triggered), logged via `_log_shadow` (counts/enums/latency only, never message/document text), but `intent_for_router` returns `None` — `resolve_execution_plan`'s `signals` tuple (which is serialized to the client in the SSE `executionPlan` payload) is byte-identical to OFF. Shadow still pays full latency/cost of both classification calls when triggered — this is a real, measurable cost of shadow, not a free observability mode.
- **ENABLED**: `student_intent` is forwarded; its only live effect is the `"semantic_intent_available"` marker in `signals`. No generation, verification, buffering, cache, or persistence consumer reads it (pre-PR3). With PR3 merged, generation/verification/cache would start reading `answer_constraints` specifically — but that wiring is demonstrably broken for visual-completeness repair (§8).

---

## 3. §7 inventory — independent regex/classification intent sites

| Site | File:line | Classifies | Category (§7) |
|---|---|---|---|
| `_detect_prohibited_tasks` | `student_intent.py:143` | Global negated summary/quiz | 2 — replaced by semantic interpretation (scoped, not global) |
| `_needs_semantic_path` | `student_intent.py:157` | Escalation trigger | 2 — replaced by §5.2's wider trigger list |
| `classify_academic_intent` + its ~20 intent regexes | `answer_intent.py:46-403` | `AcademicIntent` (task shape: math/summary/quiz/exam/…) | 1 — literal/keyword extraction stays useful as a cheap pre-filter and for task-shape routing (distinct from release/prohibition semantics), but its **negation handling** (`_NO_SOLVE_RE`, `NEGATED_SUMMARY_RE`, `NEGATED_QUIZ_RE`) is category 2 |
| `intent_style_instruction` | `answer_intent.py:676` | Re-derives prohibition text for the prompt | 2 — this is the actual injection point; must read the compiled policy instead of re-matching the raw question a third time |
| `resolve_dialogue` (lexical) | `dialogue_state.py:609` | `TurnRelation`/`SpeechAct`/`TaskFamily`/depth/response_language (lexical) | 1 — literal/deterministic layer the contract's `conversation`/`references` fields should keep using as the trusted base, per §2.5 |
| `resolve_dialogue_semantically` | `dialogue_state.py:960` | Same, semantically, for ambiguous turns | 3/discussed in §6 — candidate to merge with the intent model call, not delete |
| `needs_semantic_resolution` | `dialogue_state.py:904` | Gate for the above | 4 — keep as the OFF-mode gate; a merged call needs an equivalent combined gate |
| `question_routing.detect_intents` | `question_routing.py:91` | `AcademicIntent`-adjacent retrieval-stage intents (separate enum!) | 1 — a **third, parallel** task taxonomy (`conceptual/calculation/exercise_solution/…`), distinct from `answer_intent.AcademicIntent` and `dialogue_state.TaskFamily`. Not unified today; out of this initiative's direct scope but worth flagging as a 4th taxonomy a future consumer of `ResolvedStudentIntent.actions[].objective` would need to reconcile against |
| `execution_router._COURSE_RE`/`_CALC_RE`/`_FOLLOWUP_MARKER_RE`/etc. | `execution_router.py:85-167` | `TaskProfile` booleans feeding lane selection | 1 — deterministic literal signals for routing cost/lane, legitimately outside the student-intent contract (this is "how much work," not "what the student wants") |
| `reliability._CALCULATION_RE`/`_CHECKBOX_RE`/`_MAPPING_RE`/etc. | `reliability.py:141-170`, `classify_task_traits` (190) | `TaskTraits` feeding `requires_pre_display_verification`/buffering | 1 — stays; it is deterministic *safety* classification, not intent, and §4.4's buffering default explicitly builds on it rather than replacing it |
| `_requires_verified_buffering` | `stream.py:760` | High-risk buffering decision | 1 (keep) + consumes policy as an **additional** OR-condition (§4.4), never replaced |
| `reference_resolution._VISUAL_REFERENCE_RE`/`_CORRECTION_RE`/`_LANGUAGE_REQUEST_RE` | `reference_resolution.py:39,55,60` | Visual reference / correction / explicit language request | 2 (correction, language) / 1 (literal label extraction elsewhere in the same file stays) |
| `reference_resolution.resolve_language_context` + `_language_from_text` | `reference_resolution.py:156-208` | Response language | 2 — replaced by §2.6's contract field. **Confirmed root cause of the QA language bugs**: `_language_from_text` only ever returns `en`/`de`/`None` (counts English vs. German keyword hits); French/Arabic/Spanish/Italian messages fall through to `None` and inherit `conversation`/`latest`, which is itself `en`/`de`/`None`-only. A French message with one German term, or an Arabic message, cannot be detected as its own language by this function — it is misclassified exactly the way the 2026-10-12/13 QA report observed. |
| `course_grounding.infer_document_authority`/`authority_priority` | `course_grounding.py:41,60` | Document authority ranking | 1 — explicitly **not** intent; stays independent per §2.1/§4.2 ("document identity/authority/sufficiency enforced independently") |
| `chat.py` diagram/plot detection (`wants_diagram`/`wants_plot`), language rules appended server-side | `services/chat.py:218-237, 166-171` | Diagram intent; server-side language/confidentiality rule injection | 1 (diagram cue extraction) / 2 (language — see §4.8) |

Known-sites list from the brief is confirmed accurate with one addition: `question_routing.py`'s `detect_intents`/`AcademicIntent` enum is a **separate, fourth taxonomy**, not previously flagged.

---

## 4. Typed schemas (testable interfaces) — what exists vs. the target

This repo already uses **frozen `@dataclass`** throughout (`StudentIntent`, `DialogueResolution`, `ExecutionPlan`, `TaskTraits`, …), not Pydantic, for exactly this class of internal contract. The target schemas below follow that convention so Milestone 2 is additive, not a framework change.

### 4.1 What already exists (merged, `origin/main`)

```python
# student_intent.py — PR1+PR2, live on main
@dataclass(frozen=True)
class StudentIntent:
    original_message: str
    student_goal: str
    primary_task: AcademicIntent            # ONE global task enum
    prohibited_tasks: tuple[AcademicIntent, ...]  # GLOBAL, not scoped per target
    depth: str
    teaching_style: str
    scope: ResolvedDocumentAccess
    references_resolved: tuple[str, ...]
    references_unresolved: bool
    visual_requirement: bool
    follow_up_type: ConversationIntent | None
    confidence: float
    interpretation_source: Literal["deterministic", "semantic_model", "fallback"]
    needs_clarification: bool
```

### 4.2 What PR3 adds (unmerged, local-only commits included)

```python
@dataclass(frozen=True)
class AnswerConstraints:         # global, boolean-only, NOT per-action/target
    withhold_answer: bool = False
    hint_only: bool = False
    one_question_at_a_time: bool = False
# StudentIntent gains: answer_constraints: AnswerConstraints
```

This is a real, narrower precursor to `ReleaseConstraints` — but it is global (one set of three booleans per turn, not per `Action`/target), boolean-only (no `max_steps`/`max_items`/`official_solution`/`form`/`explanation_depth` dimensions), and has no `Origin`/provenance. It cannot represent reference example C ("no solution for 5, full solution for 6") or H (5a full answer, 5b hint) at all — both would collide into one global flag.

### 4.3 Target schema for Milestone 2 (gap-filling, not a parallel system)

```python
# --- extends student_intent.py; AcademicIntent reused as Action.objective's
#     closed vocabulary where it already covers the case, extended where it doesn't ---

@dataclass(frozen=True)
class Origin:                                  # [S12.5]
    kind: Literal["current_message", "conversation_turn", "viewer_metadata", "unresolved"]
    span: tuple[int, int] | None = None        # required iff kind == current_message
    turn_id: str | None = None                 # required iff kind == conversation_turn
    context_ref: str | None = None             # required iff kind == viewer_metadata

@dataclass(frozen=True)
class ReleaseConstraints:                       # [S12.2] independent dimensions
    final_answer: Literal["permitted", "prohibited", "unspecified"] = "unspecified"
    official_solution: Literal["permitted", "prohibited", "unspecified"] = "unspecified"
    explanation_depth: Literal["none", "concept", "method", "worked_derivation", "unspecified"] = "unspecified"
    form: Literal["hint", "guided_questions", "explanation", "worked_solution", "unspecified"] = "unspecified"
    max_steps: int | None = None
    max_items: int | None = None
    wait_for_student: bool | None = None       # None == unspecified
    changed_by_turn: str | None = None

@dataclass(frozen=True)
class Action:
    objective: Literal["explain", "define", "solve", "derive", "review_student_solution",
                        "official_solution", "exam_practice", "hint", "compare",
                        "summarize", "answer_subquestion", "translate", "other"]
    target: str                                 # exercise label / "unresolved" / concept / doc ref
    release: ReleaseConstraints
    prohibited: tuple[str, ...] = ()
    state: Literal["requested", "prohibited", "unspecified", "unresolved"] = "unspecified"
    provenance: tuple[Origin, ...] = ()

@dataclass(frozen=True)
class ResolvedStudentIntent:
    schema_version: str
    original_message: str
    student_goal: str
    actions: tuple[Action, ...]
    conversation: Literal["new", "follow_up", "correction", "rejection",
                           "exercise_switch", "permission_update"]
    references: Any                             # reuses existing reference_resolution types
    response_language: str
    teaching: Any                                # level/guiding_questions/tone — reuses depth/teaching_style
    trust: Any                                   # confidence/interpretation_source/needs_clarification — reuses existing fields

@dataclass(frozen=True)
class ExecutionPolicy:
    actions: tuple[Action, ...]                  # resolved release constraints per action/target
    evidence_requirements: tuple[str, ...]
    needs_clarification: bool
    clarification_question: str | None
    response_language: str
    response_language_reason: str
    platform_policy_applied: tuple[str, ...]     # rule ids+versions, §2.1
    policy_version: str
    compiler_version: str
    policy_hash: str
```

**Design decision, stated explicitly**: `ResolvedStudentIntent` is proposed as an *extension* of today's `StudentIntent` (add `actions: tuple[Action, ...]` alongside, not instead of, the existing scalar fields) for one migration cycle, so `primary_task`/`prohibited_tasks` keep working for every consumer that hasn't moved to `actions` yet (category 4, §6 inventory) — a derivation function `actions[0].objective → primary_task` keeps old and new readers consistent until the OFF-mode-compatibility milestone retires the scalar fields. This directly follows §7's instruction not to build a parallel system.

### 4.4 Example JSON for every §6.2 reference case (A–L)

All examples below show the **target** `ResolvedStudentIntent.actions` shape (Milestone 2 scope), annotated with what today's merged `StudentIntent` would actually produce for the same input, to make the gap concrete.

**A** — *"Ich will die Musterlösung nicht. Zeig mir nur, wie ich anfange."*
```json
{"actions": [{"objective": "hint", "target": "unresolved",
  "release": {"official_solution": "prohibited", "explanation_depth": "method", "max_steps": 1},
  "state": "requested",
  "provenance": [{"kind": "current_message", "span": [0, 68]}]}]}
```
Today: `primary_task` would classify to `MATH_PROBLEM`/`CONCEPTUAL_EXPLANATION` via `classify_academic_intent`; `NEGATED_SUMMARY_RE`/`NEGATED_QUIZ_RE` do **not** match "Musterlösung," so `prohibited_tasks` stays empty — the official-solution prohibition is invisible to the current contract entirely. Gap: full.

**B** — *"Ich weiß die Lösung nicht. Kannst du sie mir zeigen?"*
```json
{"actions": [{"objective": "solve", "target": "unresolved",
  "release": {"final_answer": "permitted", "official_solution": "unspecified"},
  "state": "requested", "provenance": [{"kind": "current_message", "span": [0, 46]}]}]}
```
Today: `_NO_SOLVE_RE` requires `(do not|don't|without|nicht|ohne)` immediately before a solve-verb; "weiß...nicht" does not match it (verb is "weiß," not a solve verb) — correctly falls through, no false prohibition. This case already passes today by accident of regex shape, not by design; flag as a fragile negative, not a verified positive.

**C** — *"Keine Lösung für Aufgabe 5. Aber für Aufgabe 6 will ich die vollständige Musterlösung."*
```json
{"actions": [
  {"objective": "solve", "target": "5", "release": {"final_answer": "prohibited"}, "state": "prohibited",
   "provenance": [{"kind": "current_message", "span": [0, 23]}]},
  {"objective": "official_solution", "target": "6", "release": {"official_solution": "permitted"}, "state": "requested",
   "provenance": [{"kind": "current_message", "span": [28, 68]}]}
]}
```
Today: **total gap**. `StudentIntent` has one `prohibited_tasks` tuple and one `primary_task` for the whole turn — it structurally cannot represent two exercises with opposite constraints in the same message. This is the brief's central motivating example and remains entirely unaddressed by what's merged.

**D** — *"First tell me what F means. Don't calculate it yet."*
```json
{"actions": [{"objective": "explain", "target": "F", "release": {"final_answer": "prohibited"},
  "state": "requested", "provenance": [{"kind": "current_message", "span": [0, 52]}]}]}
```
Today: `_NO_SOLVE_RE` matches "don't...calculate" → `COURSE_SUMMARY`/`QUIZ_GENERATION`-only prohibition detector doesn't cover `MATH_PROBLEM`; `_detect_prohibited_tasks` only ever appends `COURSE_SUMMARY`/`QUIZ_GENERATION` (hardcoded, `student_intent.py:149-154`) — a "don't calculate" instruction is **not representable as a prohibited task at all** today, even though `_NO_SOLVE_RE` exists and fires in `answer_intent.py`'s own classification path for a different purpose (steering `primary_task` away from `MATH_PROBLEM`, not recording a target-scoped prohibition).

**E** — *"Now calculate F and M."* (turn 2, correcting a prior "don't calculate it yet")
```json
{"actions": [
  {"objective": "solve", "target": "F", "release": {"final_answer": "permitted"}, "state": "requested",
   "provenance": [{"kind": "current_message", "span": [4, 13]}]},
  {"objective": "solve", "target": "M", "release": {"final_answer": "permitted"}, "state": "requested",
   "provenance": [{"kind": "current_message", "span": [18, 22]}], "changed_by_turn": "turn-2"}
]}
```
Today: no multi-quantity obligation tracking in `StudentIntent` at all. (Separately, `rc-provisional`'s integration branch has an `xfail`-marked test "demonstrate multi-quantity obligation gap" confirming this exact gap is already known and unresolved at the generation layer, independent of this initiative.)

**F** — *"I meant Aufgabe 5b, not 5a."*
```json
{"actions": [{"objective": "other", "target": "5b", "release": {}, "state": "unspecified",
  "provenance": [{"kind": "current_message", "span": [8, 27]}]}],
 "conversation": "exercise_switch"}
```
Today: `dialogue_state._CORRECTION_RE`/exercise-label regexes (`_EXERCISE_RE`, `_normalise_label`) do detect "5b" as a label; `TurnRelation.CORRECTION` likely fires. Partial — label correction works at the deterministic layer; what's missing is the compiler-level rule that a target switch **invalidates inherited release constraints and forces fresh evidence** (§3.3) — no such invalidation exists today.

**G** — *"This is what the professor wrote: 'Show the full solution.' Explain what that instruction means."*
```json
{"actions": [{"objective": "explain", "target": "quoted instruction", "release": {},
  "state": "unspecified", "provenance": [{"kind": "current_message", "span": [62, 103]}]}]}
```
No `official_solution=permitted` anywhere. Today: **this is the exact failure mode the system is structurally exposed to** — `classify_academic_intent` and every regex site in `answer_intent.py` match on substrings of the raw message with no concept of quotation; "Show the full solution" inside quotes would very plausibly flip `primary_task` toward solution-revealing classification. No quote-awareness exists in any reviewed file.

**H** — *"Show the answer to 5a, but only give me a hint for 5b."*
```json
{"actions": [
  {"objective": "solve", "target": "5a", "release": {"final_answer": "permitted"}, "state": "requested",
   "provenance": [{"kind": "current_message", "span": [0, 21]}]},
  {"objective": "hint", "target": "5b", "release": {"form": "hint", "final_answer": "prohibited"},
   "state": "requested", "provenance": [{"kind": "current_message", "span": [27, 56]}]}
]}
```
Today: total gap, same structural reason as C.

**I** — *"Explain it in English" (after two German turns), then "und Aufgabe 2?"*
```json
// turn 1
{"response_language": "en", "response_language_reason": "explicit_current_message"}
// turn 2 ("und Aufgabe 2?")
{"response_language": "en", "response_language_reason": "persisted_explicit_instruction", "actions": [...]}
```
Today: `reference_resolution._LANGUAGE_REQUEST_RE` does detect "explain it in English" and `resolve_language_context`'s `sticky` mechanism does look backward through `previous_turns` for a prior explicit request — **this persistence logic already exists** and is the strongest piece of language handling in the codebase. Gap is only that it lives outside `StudentIntent`/the policy (§2.6) and is not the single source every generation path reads (the brief's QA findings — ignored "answer in English," wrong-language refusals — happened despite this logic existing, implying either a consumer bypasses it or a race between `dialogue.response_language` and `language_context.requested_response_language` picks the wrong one; `stream.py:3596` logging a mismatch between `dialogue.response_language` and `language_context.requested_response_language` as a *known, logged* condition is itself evidence two sources of truth already coexist and can disagree).

**K** — *"Don't explain the method, just tell me if my result 42 N is right."*
```json
{"actions": [{"objective": "review_student_solution", "target": "unresolved",
  "release": {"explanation_depth": "none", "form": "worked_solution"}, "state": "requested",
  "provenance": [{"kind": "current_message", "span": [0, 68]}]}]}
```
Today: no `review_student_solution`-equivalent objective, no `explanation_depth` field exists at all. This is exactly the case the brief's §3.4/[S12.3] flags as proof the old "method_only fallback" is unsafe — confirmed: nothing in the merged code even has a slot for "explanation_depth=none," so a naive fallback-to-method-explanation design would indeed violate this case by construction, validating [S12.3]'s supersession.

**L** — Turn 1 on 5a "no final result"; turn 2 "and the next one?"
```json
{"actions": [{"objective": "other", "target": "5b",
  "release": {"final_answer": "prohibited"},
  "provenance": [{"kind": "conversation_turn", "turn_id": "turn-1"}]}]}
```
Today: no `turn_id`-based provenance exists anywhere in the reviewed files; inheritance is implicit (whatever `dialogue_state`'s `continues_previous_goal`/`active_question` resolve to), with no recorded origin a validator could check. Total gap for the provenance half of this case; the exercise-continuation mechanics (`active_question`) partially exist.

---

## 5. Compiler specification

### 5.1 Conflict resolution order (§3.5) — as a pure function over `Action` lists

1. Platform policy (§2.1, approved rows only) — hard filter, applied before anything else; a prohibited-by-platform-policy state can never become `permitted` downstream.
2. Within one target: the `Action` with the latest `changed_by_turn` (or current-turn provenance) wins over an earlier one for the *same* `ReleaseConstraints` field only — fields the newer instruction didn't address are carried over, not reset.
3. Within one turn + one target: for each field, `prohibited` beats `permitted` beats `unspecified` (prohibition-wins tie-break).
4. Narrower target beats broader target: an `Action` whose `target` is a specific exercise label overrides one whose target is "all exercises"/unresolved-broad, field by field, for the overlapping scope only.
5. `unspecified` → compiler fills in the tutoring default for that field. `unresolved` → compiler fills in the **most restrictive** value for that field (§3.4), and this is recorded in `ExecutionPolicy.platform_policy_applied`/an equivalent audit field so a test can assert *why* a field landed where it did.

This is implementable as a single `reduce` over `(target, field) → value` with a fixed precedence tuple per step — no model involvement, matching the brief's "never by the model" requirement.

### 5.2 Fallback behaviour (§3.4)

Proposed as a strict ordering, each step short-circuiting:
1. Keep every field whose current value came from a reliable source (deterministic high confidence, a validated `turn_id`, or trusted viewer metadata) — never touched by step 2.
2. For every field still `unresolved`, set to the most restrictive legal value *for that field's type* (e.g. `final_answer: prohibited`, `explanation_depth: none`, `form: hint`, `wait_for_student: true`) — note this must be per-field, not one global "safe mode," because (per reference case K) even "explain the method" is itself unsafe for some targets.
3. If the resulting policy still permits *some* non-empty answer (e.g., "restate the task, ask what's blocking them"), emit it plus one focused clarifying question.
4. Otherwise ask the clarification question alone.

A test for this section: construct a `ResolvedStudentIntent` with every field `unresolved`, assert the compiled `ExecutionPolicy` never sets any `ReleaseConstraints` field to `permitted`, and assert step 3's "still useful" condition is evaluated *after* restriction, not before.

---

## 6. Trust model and provenance validation

Confirmed existing invariant to preserve (`student_intent.py` docstring invariant 3, enforced by construction — no document-text parameter exists on `interpret_student_intent`): this must carry forward unchanged onto `ResolvedStudentIntent`'s interpreter entry point.

Provenance validation rule (§2.2/[S12.5]), concretely:
- `Origin.kind == "current_message"` → `span` must satisfy `0 <= span[0] < span[1] <= len(original_message)`. Any `Action`/field whose only provenance fails this check is downgraded to `state="unresolved"` for that field, never silently kept.
- `Origin.kind == "conversation_turn"` → `turn_id` must resolve against the caller's own trusted `previous_turns`/stored turn ledger (§4.7), not the current message. A `turn_id` that doesn't resolve (reload, device switch, pruned history) → `unresolved`, not a guess.
- `Origin.kind == "viewer_metadata"` → `context_ref` must resolve against the current request's trusted viewer context (same object `resolved_access`/`grounding_request.viewerContext` already come from) — reusing the existing trust boundary, not inventing a new one.

This is directly testable: a forged `turn_id` (one not present in the fixture's turn ledger) must produce `unresolved`, never `requested`/`prohibited` — this is reference case L's "valid and forged origins" requirement (§6.2 item 22).

---

## 7. Streaming design (§4.4)

**Default rule, concretely implementable today**: `buffer_answer_output = high_risk_validation or coverage_buffering or policy_has_release_restriction`, where `policy_has_release_restriction` is true iff any `Action.release` field in the compiled policy is not `("unspecified", None, False-default)`. This is a pure OR added to the existing `stream.py:6041` expression — no replacement of `_requires_verified_buffering`/`coverage_buffering`, matching the brief's "extends, doesn't replace" instruction.

**Adversarial test plan** (required before any optimisation beyond buffering ships): for each of — result in prose, result in a markdown table cell, result inside LaTeX (`\(42\,\text{N}\)`), result in a different unit (420 N vs 0.42 kN), result embedded in a "let's check our work" sentence — construct a fixture where the model is instructed to withhold `final_answer` and prompted adversarially to leak it anyway; assert the **validator**, not the prompt, catches it before release. This is a Milestone 2/3 test-writing task; Milestone 1 commits to the shape (one test file per adversarial pattern × each release-restricted dimension) but not the implementation.

**Two-phase vs validated-chunk release**: not evaluated with real measurements in this Milestone — no safety argument exists yet for either over plain buffering, and the brief explicitly requires "independent proof of safety" before either replaces buffering. Recommendation: defer both; ship buffering-extended-by-policy first, measure actual time-to-first-token cost per policy class in SHADOW (§9), and only then decide if the latency cost justifies the adversarial-testing investment either optimisation requires.

---

## 8. Model-budget evaluation (§5.3) — grounded in the two real call sites

Call site #1: `resolve_dialogue_semantically` (`dialogue_state.py:960`, invoked `stream.py:1680`). Call site #2: `_semantic_model_call` (`student_intent.py:173`, invoked via `interpret_student_intent` at `stream.py:1742`). Both are confirmed to already share the same client helper, same `reasoning_effort="low"`, same `INTERACTIVE_CLASSIFIER_TIMEOUT`, same `max_retries=1`, same fail-closed contract — this was a deliberate design choice in PR2 (`student_intent.py`'s own module docstring states it mirrors call #1 "rather than building a second model-client stack").

**Trigger overlap**: `needs_semantic_resolution` (call #1's gate) fires on referential/pending-task-shaped short turns. `_needs_semantic_path` (call #2's gate) fires on low dialogue confidence, correction/rejection, negation cues, or script-mixing. These are **not the same condition** but do co-occur often: a correction/rejection turn is exactly the kind of short, context-dependent turn call #1's gate also tends to fire on. No real measurement of co-occurrence rate exists yet (would need either production log mining, which this Milestone did not do, or a dataset run, which needs separate approval per §6.1).

**Recommendation: do not merge into one call yet; run both calls in parallel (`asyncio.gather`) when both gates fire, instead of sequentially.** Reasoning, grounded in the actual code:
- Correctness risk of merging: call #1 resolves *reference/continuation* semantics using `activeTask` inferred from previous turns; call #2 needs call #1's **output** (`dialogue.resolved_request`, `dialogue.active_question`) as an input (`student_intent.py:214-218`, the `frame` dict passed to the model includes `dialogue.resolved_request`). A single merged call would have to either (a) ask the model to do both resolutions in one structured output with no intermediate deterministic grounding, which removes the "deterministic reference resolution feeds the semantic layer" boundary the codebase currently relies on (§2.5), or (b) keep two logical phases inside one HTTP call via a larger prompt, which doesn't save a network round-trip, only merges two small prompts into one larger one — unclear benefit.
- Failure isolation: today, a call #1 failure has its own fallback (`_safe_conversational_fallback`) independent of call #2. A merged call fails both at once, which contradicts the brief's own warning. Keeping them separate preserves this.
- Latency: real measurement exists for call #2 alone (§9): mean 1,166 ms, p95 1,357 ms, max 4,317 ms for `gpt-4o-mini`. No equivalent measurement exists yet for call #1 alone or for the two sequential today — this Milestone did not add new timing instrumentation (would require a code change, out of scope). **Action item for Milestone 2**: add latency logging to call #1 matching what call #2 already has, before deciding between "parallel" and "merge."
- Given both calls already share every infrastructure decision (client, timeout, retry, effort), **running them concurrently via `asyncio.gather` captures nearly all of the latency benefit of merging** (today they run sequentially: `await run_in_threadpool(...)` for call #1 completes fully before call #2's `await run_in_threadpool(...)` even starts) **without the correctness/isolation risk** — this is the recommended Milestone 2 change, not a merge.

---

## 9. Real-model evaluation already on record (§6.1 cost estimate, grounded not guessed)

A real-model evaluation of PR2's semantic call already ran and is committed on `main` (commit `411627b6`, `backend/python-ai/reports/student-intent-2026-10-17*`), predating this Milestone 1 task — no new paid calls were made by this audit; the numbers below are read from that existing, committed report.

- Model: `gpt-4o-mini` (configured `openai_generate_model`). 21 live calls, $0.00225675 total cost (~$0.0001/call). Extrapolated to 1,000 turns at the same trigger rate: **≈$0.11/1,000 turns** for the classification call alone (excludes tutoring/generation calls, which are unaffected per §5.3's budget scope).
- Latency: mean 1,166 ms / median 947 ms / p95 1,357 ms / max 4,317 ms.
- Quality (direct model vs. effective-after-merge): primary-task fixture agreement 57.14% direct / 90.48% effective; prohibition recall 50% direct / 75% effective; **trusted scope/reference preservation 100%** (invariant 3/4 held in all 23 cases, confirming the evidence-boundary design works as intended even when the model itself errs).
- Two unresolved "known gaps" recorded by that evaluation map directly onto this Milestone's schema gaps: (1) quiz-answer-hiding cannot be represented — this is exactly `ReleaseConstraints`'s job; (2) an ordinal-deictic false positive ("the second law" triggering `references_unresolved`) — a deterministic reference-resolution fix, independent of the semantic layer.
- That report's own conclusion: **"keep production off... the interpreter is diagnostic only, including enabled mode... fix merging and constraint representation... before any rollout."** This Milestone's findings are consistent with and reinforce that conclusion.

For the held-out real-model evaluation required before any ENABLED decision (§6.1), this existing report is a useful first data point but does not satisfy §6.2's full category list (it covers primary-task/depth/prohibition/visual fields only, zero release-constraint cases since the schema didn't exist yet, no multi-language cases beyond en/de). Rough budget estimate for a fuller run covering all 24 §6.2 categories with ~5-10 cases each (~150-240 cases) at the same per-call cost: **≈$0.02-0.03 total, a few minutes wall-clock** — trivially small in dollars, but still requires the separate explicit approval and pre-approved budget the brief mandates, since it's a new run against unreviewed held-out cases, not a re-read of the existing one.

---

## 10. Cache identity and re-authorization (§4.6); persistence and recheck (§4.7)

Nothing resembling `policy_hash`-keyed caching exists on `main` today. PR3 (unmerged) adds "intent fingerprints" threaded through "real cache APIs" (commit `e6271991`, title: "forward intent fingerprints through real cache APIs") — this is the right direction (a hash of the constraint-relevant fields feeding the cache key) but is PR3-specific (`answer_constraints` only, not the full target schema) and is exactly the code path the PR3/visual-safety merge conflict (§11) currently breaks for the visual-completeness case. No persistence of a stored "original intent record" (§4.7) exists anywhere reviewed; conversation/turn storage was out of this Milestone's file list (not one of the ten files specified) and needs a dedicated read before Milestone 3's schema-of-stored-record decision.

Recommended re-authorization checklist for Milestone 3 (reusing existing trust primitives, nothing new): re-run `resolve_document_access` (already idempotent, pure function of trusted viewer context) and re-check `assert_authorised_course_chunks` (`course_grounding.py:142`, already raises on any out-of-manifest document) on every cache-hit candidate and every regenerate/retry — both already exist and already throw on exactly the conditions §4.7 requires rechecked (access revoked, document outside manifest); the gap is only that nothing calls them at cache-check time today.

---

## 11. Ownership / dependency matrix (§8) — filled with real findings, not placeholders

| Area | Current owner (verified) | Real current state | What this plan needs | Blocking? |
|---|---|---|---|---|
| `student_intent.py` / `answer_intent.py` | PR3 agent, `feature/semantic-intent-constraints` (local HEAD `5df5e313`, 2 commits ahead of pushed `9b00d3d1`) | `AnswerConstraints` (3 global booleans) merged into `StudentIntent`; wired into `answer.py`/`answer_stream.py` completeness repair + cache fingerprinting. **`tests/test_constraint_validation.py` (fully mocked, executed directly in this audit): 15 of 17 assertions fail** — same count the brief cited as "previously reported," i.e. **unchanged, not regressed, not fixed**. The 2 passes are the "unrestricted, baseline behavior unchanged" cases; every case asserting a constraint is actually honored fails. | Replace global `AnswerConstraints` with per-action `ReleaseConstraints` (§4.3); this is additive to PR3's cache-fingerprint direction, not a reversal of it | Yes — before any Milestone 2 contract change lands on top of this file |
| `course_grounding.py` | Grounding agent, `fix/course-grounding-evidence-gate` (`9efa7331`) | Real, substantial, tested (1,714 lines across 6 files + 3 new test files): evidence-sufficiency/claim-gate work on `ask.py`/`stream.py`/`course_grounding.py`/`dialogue_state.py`/`reliability.py`/`source_router.py` | `policy.evidence_requirements` as an additional input alongside this agent's existing sufficiency checks — never replacing them (§4.2 explicit requirement) | Milestone 3 |
| Exercise/quantity extraction | Extraction agent — **this is the current repo's own checked-out branch**, `fix/exercise-and-quantity-extraction` (`5b77d006`), 4 commits ahead of what `rc-provisional` integrated | Live, actively being worked on in the primary working tree during this very task (per git status at task start) | Deterministic literals feeding `Action.target` | Milestone 2 |
| Visual answer safety | Codex visual-safety agent, `fix/visual-final-answer-safety` (`07afee52`) | Real: new `visual_answer_validation.py`, rewrites of `answer_stream.py`/`visual_repair.py` centralizing the final-candidate acceptance gate. **Confirmed conflict with PR3** (§8 below) — merging the two in `rc-provisional` broke PR3's `student_intent` parameter on `verify_and_repair_visual_assignment` entirely | Read-only policy access in repair, reconciled with PR3's constraint parameter, not two incompatible signatures | Milestone 3, but the **merge conflict itself needs resolving before Milestone 2 touches this function** |
| `stream.py` release/buffering, `/ask` | No dedicated agent found; `rc-provisional` (`933ec6f7`) is the closest thing to an integration owner | `rc-provisional` combines PR1+2+3(+unpublished)+grounding-fix+exercise-extraction+visual-safety; explicitly works around the PR3/visual-safety conflict with `strict=True` `xfail` markers rather than fixing it; also has its own `xfail`'d "multi-quantity obligation gap" test | `policy.release_checks` as an addition to existing `buffer_answer_output` (§7) | Milestone 3 |
| `services/chat.py` (`/chat`) | Active agent, `fix/no-course-chat-language` (`42b4d4c2`) | **Directly in flight**: fixes "/chat path forcing a fixed reply language," prompt order, model routing, language detection — touches `chat.py`, `answer.py`, `german_learner_profile.py`, plus frontend `shell.ts`. This is real, current, overlapping work on exactly §2.6's language problem, on a path this initiative's §4.8 must decide the scope of. | Decision below | **Milestone 1 decision, see next row** |
| `/chat` scope decision (§4.8) | — | — | — | **Recommend: explicitly out of scope for Milestones 2-3.** Reasoning: `/chat` is a generic vision chatbot with its own language/prompt pipeline (`chat.py:151-274`) already being actively fixed by a different agent for the same underlying language-correctness problem this initiative cares about (§2.6), on an un-merged branch. Wiring the semantic-intent layer into `/chat` now risks a second, racing fix to the same symptom. OFF behavior (current, regex-based rules in `chat.py`) stays as-is; this decision should be revisited once `fix/no-course-chat-language` lands, specifically checking whether its language-detection fix can be *subsumed* by `policy.response_language` rather than coexisting with it. |
| Conversation store (intent record persistence) | Unassigned / DB owner | Not reviewed in this Milestone (storage/schema files were outside the ten specified files) | New versioned fields; migration needs approval | Milestone 3; **requires its own read-only audit pass before any schema is proposed** |
| Platform policy rules (§2.1) | Product owner (user) | See §12 below | Rule ids + versions | Milestone 1 decision |
| Release integration candidate | No single named owner; `rc-provisional` worktree is the de facto staging branch | Frozen at `933ec6f7` at time of this audit; **already stale** against the primary repo's own `fix/exercise-and-quantity-extraction` branch (4 commits behind) and contains unpublished/unreviewed PR3 commits merged in despite the brief's explicit warning against treating those as reviewed | — | Milestone 4 |

---

## 12. Platform-policy candidate table (§2.1)

| Candidate rule | Status | Evidence checked |
|---|---|---|
| Learner-exam answer keys stay server-side until submission | **Approved and shipped** | Commit `9453f9f7` confirmed to exist on `main` |
| Document authorization, provenance, evidence sufficiency enforced independently | Existing behaviour | `assert_authorised_course_chunks` (`course_grounding.py:142`), `build_course_evidence_report` (same file) confirmed live and independent of any intent signal |
| Image/pixel-verification safeguards | Existing behaviour | `reliability.classify_task_traits` (`reliability.py:190`) + the `fix/visual-final-answer-safety` branch's centralized acceptance gate, confirmed independent of `StudentIntent` |
| Live-exam solving ("I'm in my exam right now…") | **Needs owner decision** — no trace of this rule found anywhere in the reviewed files; confirmed not yet policy | — |
| Plagiarism-detection evasion | **Needs owner decision** — no trace found; confirmed not yet policy | — |

No new candidate rules are proposed by this audit beyond the brief's own list — per [S12.8], engineering agents must not invent new refusal categories, and none were found implicit in any of the reviewed branches either (PR3's `AnswerConstraints`, the remediation worktree's uncommitted `AnswerPolicy`, and `rc-provisional`'s integration all implement *student-requested* release constraints, never platform-imposed ones).

---

## 13. Critical flag: a third, independent, uncommitted implementation already exists

The `remediation/semantic-intent-pr2` worktree (`C:/…/Temp/minallo-semantic-live-eval`) currently has, **uncommitted**, a new file `student_answer_policy.py` defining:

```python
@dataclass(frozen=True)
class AnswerPolicy:
    answer_release: Literal["default", "withhold", "after_attempt"] = "default"
    solution_detail: Literal["default", "hint_only"] = "default"
    question_pacing: Literal["default", "one_at_a_time"] = "default"
```

detected via anchored (`^...$`-per-clause) English/German regexes. This is a **second, overlapping, differently-shaped** release-constraint model, sitting alongside PR3's committed-but-unmerged `AnswerConstraints` (three booleans) and this Milestone's own target `ReleaseConstraints` (tri-state, per-action). None of the three agree on field names, cardinality, or scoping, and the third is not committed to any branch. This is precisely the "don't add another independent classifier" failure mode the brief warns against, already underway. **Recommendation, to the owner**: before Milestone 2 starts, either commit-and-formally-supersede or explicitly discard `student_answer_policy.py`/`student_intent_prompt.py` — do not let a third design continue evolving uncommitted while Milestone 2 builds `ReleaseConstraints` against PR3's shape.

---

## 14. PR3 status (as required by the brief, summarized)

- `e6271991` and `5df5e313` **do exist**, as local-only commits on top of the pushed `9b00d3d1` tip of `feature/semantic-intent-constraints`.
- `tests/test_constraint_validation.py`, run directly (fully mocked, zero network I/O, safe to execute): **15 of 17 assertions fail**, unchanged from the previously reported count.
- The `rc-provisional` integration branch independently confirms this is a known, unresolved, *structural* gap (not a flaky test): its own copy of this test wraps all 15 failing cases in `pytest.mark.xfail(strict=True, reason="P0 gap, routed to PR3 owner... verify_and_repair_visual_assignment() does not accept a student_intent parameter at all (TypeError)...")`. This means the PR3/visual-safety merge did not just fail to fix the gap — it **regressed it further** (an `AssertionError` on PR3's own branch becomes a `TypeError` once merged with visual-safety's rewritten `answer_stream.py`/`visual_repair.py`), because the merge lost the `student_intent` parameter PR3 had added to that function's signature.

---

## Appendix A — §12 safeguards, where resolved, and the proving test

| Safeguard | Resolved in this report | Test that would prove it |
|---|---|---|
| S12.1 (streaming — no marker-based boundary) | §7: default buffering rule extended by `policy_has_release_restriction`; two-phase/validated-chunk deferred pending adversarial proof | §7's adversarial test plan (result hidden in prose/table/LaTeX/unit-shift/"let's check" sentence) × each release-restricted field; assert validator (not prompt wording) catches every case |
| S12.2 (independent release dimensions) | §4.3 `ReleaseConstraints` schema; §4.4 example J-equivalent reference case H (5a full, 5b hint) | Compile a single `Action` with `explanation_depth=method, max_steps=1, final_answer=prohibited, wait_for_student=true` set together; assert all four survive compilation independently |
| S12.3 (fallback — no unsafe `method_only` default) | §5.2 fallback order sets each *field* to its own most-restrictive value, not one global level; reference case K shown to require `explanation_depth=none`, which a global "method" fallback would violate | Fixture K: force every field `unresolved`; assert compiled policy's `explanation_depth` is `none`, not `method` |
| S12.4 (persistence — recompile + recheck, never reuse policy as auth) | §10: recommended recheck list (`resolve_document_access`, `assert_authorised_course_chunks`) reusing existing idempotent/raising primitives on every regenerate/retry | Regenerate after simulating revoked document access; assert the recompiled policy differs from the stored one and the difference is logged |
| S12.5 (provenance validation) | §6: `Origin.kind`-specific validation rules, downgrade-to-`unresolved` on failure | Forged `turn_id` (case L variant) → assert `unresolved`, never `requested`/`prohibited` |
| S12.6 (model budget — ≤1 classification call/turn, don't assume merge) | §8: recommends `asyncio.gather` concurrency over merging, grounded in the two real call sites' actual data dependency (call #2's prompt includes call #1's output) | Add latency logging to call #1 (currently absent); measure sequential-today vs. parallel-candidate wall time on the same fixture set |
| S12.7 (offline vs. real eval, separate budgets) | §9: existing real-model report cited as first evidence, explicitly marked insufficient for a full §6.2 pass; new budget estimated (~$0.02-0.03) but **not spent** — still requires separate approval | The existing `student-intent-2026-10-17.json`/`.md`/`.ledger.jsonl` artifacts themselves, re-readable without any new paid call |
| S12.8 (`policy_hash` identity, not an authorization credential; platform-policy ownership) | §10 (cache identity) + §12 (platform-policy table, only 3 of 5 candidate rows approved) | Cache-hit candidate with matching `policy_hash` but revoked document access → assert miss, not reuse, because the recheck (§10) runs regardless of hash match |
| S12.9 (OFF/SHADOW/ENABLED semantics) | §2 (confirmed current behavior matches spec exactly: OFF never computes, SHADOW computes+logs+never forwards, ENABLED forwards an inert marker only) | Existing test (`test_student_intent.py`, "flag-off parity") + existing shadow-vs-off serialized-payload equality test, both already on `main` |

---

## What would block Milestone 2 if started today

1. The PR3/visual-safety merge conflict (§8, §14) — `verify_and_repair_visual_assignment`'s signature is inconsistent between branches; must be resolved (by the PR3 and visual-safety owners jointly, per the brief's §8 coordination rule) before any `ReleaseConstraints` work touches that function.
2. §13's uncommitted third implementation — needs an explicit owner decision (commit-and-supersede, or discard) before Milestone 2 picks a canonical shape to extend.
3. §4.8's `/chat` scope decision and the two still-open §2.1 platform-policy rows need the product owner's sign-off, per the brief's own Milestone 1 decision points.

No other blocker was found that would prevent starting Milestone 2 against `origin/main` directly (not against any of the unmerged branches) once the above three are resolved.
