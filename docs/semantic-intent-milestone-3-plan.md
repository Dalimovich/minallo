# Semantic Intent — Milestone 3 plan: the first real wiring PR (REVISED)

Status: proposal, not yet started. Revised from branch
`feature/semantic-intent-unification-m2` (commit `69ee733b` at time of
writing) after a user review of the first version found seven real gaps.
This revision applies all seven corrections in place — it supersedes the
first version section by section; nothing below should be read alongside
the old text. Nothing described here has been built — this is the
handoff for whoever picks up Milestone 3.

**Revision summary** (what changed and why, so a reader of the old
version knows what to discard):

1. The "OFF path" is corrected: `SEMANTIC_INTENT_MODE` does **not** gate
   today's dialogue semantic classifier at all — verified directly in
   `app/routers/stream.py` (§2). OFF must preserve that classifier's
   existing behavior exactly, not just "no new call."
2. The unified adapter's output contract is corrected: `ResolvedStudentIntent`
   alone cannot replace `DialogueResolution` — a full consumer inventory
   (§3) found far more load-bearing fields than the first version assumed.
3. The `TurnLedger` source question is answered, not left open: a real,
   already-shipped, ownership-verified persistence layer exists
   (§4) and `payload.previousTurns` must not be treated as it.
4. Provenance is corrected from "nice to have" to an explicit blocking
   gate (§5), with the real state of what's checked today named exactly.
5. PR3-as-legacy is reaffirmed (§6) — unchanged in substance, carried
   over from the PR3 reconciliation packet this doc is a sibling of.
6. The first PR's scope and claims are corrected (§7): "behavior-inert"
   and "classifier replacement" are split into two different categories
   that must not be blurred, the "whole Aufgabe" bug claim is withdrawn,
   and the base branch question is answered (origin/main).
7. Testing/release requirements are made concrete and exhaustive (§8).

## 1. What Milestone 2 actually shipped (unchanged from the first version)

- `app/services/resolved_student_intent.py` — `ResolvedStudentIntent`/
  `Action`/`Origin`/`ReleaseConstraints`/`TurnLedger`/`VerifiedTurn`, plus
  provenance validation (`validate_origin`, `validate_action_provenance`,
  `validate_intent_provenance`) and the legacy-bridge derivation functions.
- `app/services/policy_compiler.py` — `compile_policy()`: pure,
  deterministic, turn-ledger-aware, platform-policy-aware. Produces
  `ExecutionPolicy` (`actions`, `evidence_requirements`,
  `needs_clarification`, `response_language`, `policy_hash`, full audit
  trail in `platform_policy_applied`).
- `app/services/semantic_call_support.py` — `needs_semantic_escalation`
  (widened trigger, NOT wired into `student_intent._needs_semantic_path`
  yet) and `validate_semantic_action` (strict schema + consistency
  validation for one model-proposed action).
- `app/services/unified_semantic_call.py` — the one-call adapter proposal
  (Decision 1): `build_unified_call_frame`, `validate_unified_call_output`,
  `safe_fallback`. Produces a `ResolvedStudentIntent` directly from one
  mocked-so-far structured-output call shape. `safe_fallback` now
  preserves an already-trusted baseline verbatim on failure rather than
  discarding it (hardening fix, see `docs/semantic-intent-pr3-
  reconciliation.md`).
- `app/services/legacy_constraint_projection.py` — one-way
  `ExecutionPolicy` → PR3's legacy `AnswerConstraints`-shaped projection,
  for unmigrated consumers only. Never derives the canonical policy from
  the three legacy booleans.
- `app/services/concurrent_classification.py` — the `asyncio.gather`
  two-call concurrency primitive. **Superseded** for the budget decision
  (still issues two calls); kept as tested code, explicitly not to be
  wired into anything live.
- `app/services/dialogue_state.py` — one small, already-landed change:
  latency logging added to `resolve_dialogue_semantically`.

None of the above is imported by `app/routers/stream.py`,
`app/services/student_intent.py`, `app/services/answer_intent.py`, or
`app/services/course_grounding.py`. That wiring is this PR.

## 2. Correction 1 — the legacy OFF path is NOT what the first version assumed

Verified directly in `app/routers/stream.py` (current `origin/main`,
`31f5b9ee`):

```
1678: if needs_semantic_resolution(question, turn_resolution, preflight_turns):
1680:     resolve_dialogue_semantically(...)       # call #1 — UNGATED by SEMANTIC_INTENT_MODE
...
1732: semantic_intent_mode = get_settings().semantic_intent_mode
1734: if semantic_intent_mode != "off":
...                                                # call #2 — gated by SEMANTIC_INTENT_MODE
```

Call #1 (the dialogue semantic classifier, `resolve_dialogue_semantically`)
runs whenever `needs_semantic_resolution(...)` is true — **today, in
production, right now, regardless of `SEMANTIC_INTENT_MODE`.** It predates
PR1/PR2/PR3 entirely; it is baseline infrastructure, not part of "the
semantic student intent layer" feature this whole initiative is about.
Only call #2 (`interpret_student_intent`, PR1/PR2's addition) is gated by
the flag.

**Consequence for the design**: "OFF" cannot mean "zero semantic calls" —
it already isn't that today. The corrected mode contract for any PR that
touches this:

- **OFF**: the existing complete path — deterministic `resolve_dialogue`,
  then `resolve_dialogue_semantically` exactly as today (same gate, same
  behavior, same cost profile), with call #2/the unified call **never
  invoked**. Byte-identical to current production in every mode-off
  request, including the cases where call #1 itself fires.
- **SHADOW**: must not change any user-visible decision, response text,
  cache identity, or persisted answer state. The existing call #1
  behavior is unchanged (it already runs in production regardless of
  mode, so SHADOW is not newly "turning on" anything by leaving it alone).
  What SHADOW adds is computing (not consuming) either the legacy call #2
  or the new unified call, logged only.
- **ENABLED**: may replace call #1 + call #2 with the one unified call,
  subject to the dialogue-contract compatibility gate (§3) and the
  provenance gate (§5).

**The budget reconciliation SHADOW specifically needs** (this is the real
trade-off the user asked to be made explicit, not hidden): today, SHADOW
can *already* cost up to 2 calls per turn when both `needs_semantic_
resolution` and `_needs_semantic_path` fire (call #1 live, call #2 shadow)
— that is pre-existing, not something this initiative introduces. But if
SHADOW is also used to validate the NEW unified-call design before
flipping anything to ENABLED, running it as a THIRD live call on the same
real user turn (call #1 live + call #2 shadow + unified-call shadow) would
violate the "≤1 semantic call per turn, total" budget on exactly the turns
that matter most (the ones where escalation actually fires).

**Recommended compliant approach**: validate the unified-call design via
**offline replay**, not live inline shadow-calling. Log the
(message, previous_turns, deterministic-base) tuple for turns where call
#1 or call #2 fires (already anonymization-safe per `_log_shadow`'s
existing counts/enums-only convention — the replay corpus would need its
own, separately-reviewed privacy posture, not assumed free), and run the
unified-call design against that corpus in a batch, offline,
explicitly-budgeted evaluation (same category Milestone 1 §9 already
flags as needing separate approval) — never as a second or third live
call riding on a real user's request. An inline live dual-shadow approach
is **not** recommended and should require a separate, explicit decision
if anyone proposes it later, because it cannot be made compliant with the
"total, not per-call-site" budget on the turns where it would actually
produce useful signal.

## 3. Correction 2 — the full dialogue contract, not just `ResolvedStudentIntent`

Grepped `app/routers/stream.py` for every real consumer of
`DialogueResolution`'s fields (not assumed):

| Field | Real consumer(s) | What breaks if missing/wrong |
|---|---|---|
| `relation`, `speech_act` | Telemetry (`log.info(..., relation=dialogue.relation.value, speechAct=...)`, line ~3580) | Observability only — low risk, but still a contract. |
| `task_family` | `task_requires_workspace(dialogue.task_family)` (routing gate, lines ~1979, ~3916); telemetry | Wrong value routes a request to/away from the workspace path incorrectly. |
| `resolved_request` | Feeds the retrieval question directly (`turn_resolution.resolved_request`, lines 1700/1756/3257); feeds `interpret_student_intent`'s `student_goal` | Wrong retrieval query — the literal "go ahead" divergence already demonstrated in `concurrent_classification.py`'s own test. |
| `active_question` | **Persisted** into `tutor_state.active_question` (line ~3831) and read back on **later, different** turns (`tutor_state.active_question or dialogue.active_question`) | A wrong value here doesn't just affect this turn — it corrupts state future turns read back, compounding. |
| `continues_previous_goal`, `evidence_requirement` | Retrieval-reuse decision (`REUSE_PRIOR_GROUNDED`/`CONVERSATION_ONLY` branches, lines ~1963-1966, ~3227) | Wrong value causes either a stale-answer reuse or an unnecessary fresh retrieval. |
| `prompt_overlay()` | Rendered **directly into the model prompt** as "DETERMINISTIC DIALOGUE RESOLUTION (mandatory)" (line ~6177) | This is not metadata — it is literal instruction text the generation model is told to obey. |
| `dialogue_act`, `conversation_intent` | `to_api()` → serialized into the SSE `"turnResolution"` payload (line ~2304) — **client-visible API contract** | A frontend reading this field would see a different shape/value with no server-side consumer necessarily even knowing. |

This is a materially larger, more deeply load-bearing contract than the
first version of this plan assumed when it proposed simply returning
`ResolvedStudentIntent` from the unified call. `ResolvedStudentIntent`
(`conversation`, `student_goal`, `actions`) has no field at all for
`dialogue_act`, `active_question`, `previous_question`, `requires_new_
retrieval`, `invalidate_previous_answer`, `requested_depth`,
`explanation_attempt`, `referent_type`/`referent_text`, or
`evidence_requirement`.

**Hard gate, not a nice-to-have**: the dialogue classifier (call #1) must
not be replaced by the unified call until every one of the fields in the
table above has either (a) a deterministic compatibility projection from
the unified call's validated output back into a real, full
`DialogueResolution` (reusing the SAME override-merge pattern
`resolve_dialogue_semantically` already uses —
`DialogueResolution(**{**base.__dict__, **overrides})` — so unmapped
fields inherit the deterministic `base`'s value rather than being
invented), or (b) an explicit, reviewed decision that a specific field is
allowed to keep coming from the deterministic layer alone, forever, even
in ENABLED mode. **This projection does not exist yet** — it is the
single largest piece of unbuilt work this plan identifies, larger than
the ledger plumbing (§4) or the provenance gate (§5). Building it is
listed as its own line item in §8, not folded into "wire in the unified
call" as the first version implied.

## 4. Correction 3 — the real trusted history source (investigated, found)

The first version left "where does the ledger come from" as an open
question with a weak default ("`payload.previousTurns`, already trusted
in the sense that it comes from the session's own conversation"). That
default was wrong on its own terms: an authenticated request proves the
*request* came from a logged-in user, not that every historical
message/turn-id/order/field the client chose to put in its own JSON body
is genuine. These are different trust boundaries.

**Investigated and found**: `app/services/conversation_store.py` already
implements exactly what `TurnLedger` needs, shipped, in production use
today (just not for this purpose):

- `ensure_durable_conversation(user_id, client_conversation_id, ...)` —
  resolves one browser chat to one server-generated `conversation_id`
  (UUID), durably, idempotently.
- `validate_durable_conversation(user_id, conversation_id) -> bool` —
  ownership check: is this `conversation_id` really this `user_id`'s?
- `get_durable_conversation_messages(user_id, conversation_id)` — calls
  `validate_durable_conversation` FIRST (returns `[]`, not an error leak,
  if ownership fails), then returns the full transcript from
  `ai_chat_messages`, **ordered by the server's own `created_at`**, each
  row carrying a `client_message_id` (a natural, stable `turn_id`).

This is already called from `app/routers/stream.py`, but only from a
**separate** endpoint (`GET /conversations/{conversation_id}/messages`,
line ~1316 — used for client refresh/rehydration, not for the live
`/ask-stream` dialogue-resolution path). `AskStreamRequest` already
carries a `conversationId` field (line ~563); the live handler currently
never calls `validate_durable_conversation`/`get_durable_conversation_
messages` against it for dialogue-resolution purposes at all — it builds
`preflight_turns` from `payload.previousTurns` only.

**Recommendation**: `TurnLedger` for a real request should be built as:

```python
if not validate_durable_conversation(user_id=user["id"], conversation_id=payload.conversationId):
    turn_ledger = None   # explicit history-free / missing-history path, never payload.previousTurns as a substitute
else:
    rows = get_durable_conversation_messages(user_id=user["id"], conversation_id=payload.conversationId)
    turn_ledger = TurnLedger.build(
        conversation_id=payload.conversationId,
        turns={row["client_message_id"]: row for row in rows},   # dict order = get_durable_conversation_messages' own created_at order
    )
```

`payload.previousTurns` can keep feeding the **deterministic, heuristic**
layer exactly as today (that is not a new trust claim — it already only
drives lexical pattern-matching, never a permission decision) — it must
never be the source `TurnLedger.build` is constructed from, since that
function is a constructor, not proof of trust: calling it on
client-supplied data would produce a `TurnLedger` object that LOOKS
authoritative (same type, same API) while carrying none of the
verification its name implies. This is worth stating plainly in code
comments wherever `TurnLedger.build` is called in Milestone 3's real
wiring, not just in this doc.

Two caveats found while investigating, left open deliberately:

- `get_durable_conversation_messages` orders by `created_at` (a
  timestamp string), not a dedicated integer sequence column. Good enough
  for `TurnLedger.build`'s dict-order convenience path today; a
  same-millisecond tie is a real (if narrow) edge case worth a follow-up,
  not a blocker.
- `ensure_durable_conversation` is called from a SEPARATE request
  (`POST /conversations/ensure`) than `/ask-stream` itself. Milestone 3's
  wiring must confirm the frontend actually calls it every turn before
  `/ask-stream` — if it doesn't (e.g. an older client build), the ledger
  for that request would be legitimately, explicitly empty
  (`TurnLedger.empty`), which is the CORRECT degrade (per Decision 2), not
  a bug — but worth instrumenting/alerting on if it happens often in
  practice.

## 5. Correction 4 — provenance is a blocking gate, not a nice-to-have

Re-verified directly (see `docs/semantic-intent-pr3-reconciliation.md`
for the test that demonstrates this) what is and is not checked today for
a model-sourced `Action`:

- **Already closed**: a model cannot smuggle a `changed_by_turn` cross-
  turn override claim through `validate_semantic_action` at all — it is
  rejected as an unknown field for any model-sourced release payload
  (pre-existing hardening-pass decision, confirmed still in effect).
- **NOT checked, anywhere, today** (demonstrated with a real test, not
  asserted): whether a model-claimed `target` corresponds to anything in
  the current message, any trusted viewer context, or any real exercise
  in this conversation at all. A model can propose
  `target="Aufgabe-7-never-mentioned-anywhere"` and `validate_unified_
  call_output`/`compile_policy` will accept and PERMIT it, because
  neither function receives the trusted context needed to check target
  identity or document references against anything.
- An action's `provenance` tuple defaulting to `()` currently means
  "left alone, treated as if it were a trusted deterministic parse" to
  `validate_action_provenance` — correct for an actual deterministic
  parse, but a model-sourced action is not that, and nothing currently
  distinguishes "empty because deterministic" from "empty because the
  model's claim was never checked against anything."

**Blocking gate (explicit, not implied)**: full field/claim-level
provenance enforcement for model-sourced actions — at minimum, verifying
`target` against the current message or trusted viewer context, and
verifying any implied "this continues/corrects a prior turn" claim
against the real `TurnLedger` (§4) rather than taking the model's
`conversation` field at face value — **must land before**:

1. Any history-dependent permission change (lifting or tightening a
   constraint because "this is a correction/follow-up of turn X") is
   allowed to reach ENABLED-mode behavior, and
2. Any answer-release enforcement (actually withholding/revealing content
   based on `ExecutionPolicy`) goes live for any consumer.

An **observational-only** first PR (computes `ExecutionPolicy`, logs it,
never consumed — see §7) does not need this gate, because nothing acts on
the unverified claims yet. The gate applies the moment anything downstream
starts obeying the policy.

**Also fixed this round** (a real bug in this branch's own code, not a
documentation gap): `unified_semantic_call.safe_fallback` previously
force-downgraded every passed-in action to `state="unresolved"` on a
unified-call timeout/failure, discarding already-verified, reliable
fields that had nothing to do with the failure. It now preserves a
trusted baseline verbatim and only synthesizes a restrictive placeholder
when there is genuinely nothing trusted to fall back on — see
`docs/semantic-intent-pr3-reconciliation.md` for the before/after.

## 6. Correction 5 — PR3 is legacy, reaffirmed (unchanged in substance)

This was already the architectural decision going into this revision, not
something this doc is re-deciding: `ResolvedStudentIntent.actions[].release`
→ `ExecutionPolicy` is canonical. PR3's global `AnswerConstraints`
(`withhold_answer`/`hint_only`/`one_question_at_a_time`) is a legacy
compatibility surface whose existing enforcement, tests, repair wiring,
and cache-isolation work gets REUSED via field-by-field migration, not
discarded. The full consumer-by-consumer plan for this is in
`docs/semantic-intent-pr3-reconciliation.md` (a sibling document to this
one) — this plan does not duplicate it, only cross-references it.

## 7. Correction 6 — the first PR's actual, corrected scope

**Two categories that must not be blurred** (the first version blurred
them):

- **Behavior-inert** (observational only): computing `ExecutionPolicy`
  (and, if built, the full `DialogueResolution` compatibility projection
  from §3) and logging/storing it, while the REAL `resolve_dialogue`/
  `resolve_dialogue_semantically`/`interpret_student_intent` path still
  runs unchanged and still produces the actual response. This changes
  NOTHING about dialogue resolution, routing, generation, or the response
  sent to the client. This category can safely be a first PR.
- **Classifier replacement** (can change behavior, even with zero
  downstream `ExecutionPolicy` consumers): swapping call #1 and/or call #2
  for the unified call changes `dialogue_act`/`task_family`/`active_
  question`/`resolved_request`/the prompt overlay text immediately — all
  of which are consumed TODAY, independent of whether anything reads
  `ExecutionPolicy` (§3's table). **This is not behavior-inert**, no
  matter how good the compatibility projection is, because it changes
  WHICH CODE PATH decides those values. This is a separate, later PR,
  gated on §3's projection existing and being tested, and should ship
  under its own flag-gated rollout, not bundled with the observational PR.

**Withdrawn claim**: the first version of this plan implied the first PR
would at least partially address the live "whole Aufgabe" false-document-
selection bug. That is corrected here: **it does not**, because
`resolve_document_access()`'s natural-language routing decision happens
BEFORE any semantic-intent computation in the current request flow
(`app/routers/stream.py`, well before the dialogue/intent block). An
observational-only PR computes `ExecutionPolicy` too late to affect that
decision even if it wanted to. Fixing this needs a **separate, required,
ENABLED-mode-only** integration step: semantic scope resolution placed
BEFORE `resolve_document_access()`'s call site, with the existing
independent authorization checks (document ownership, access level) left
completely intact and unchanged — scope resolution informs WHICH document
is in play, never whether the requesting user may see it. This is its own
step in the roadmap (§8), not a side effect of the first PR.

**Base branch**: this PR should be based on current `origin/main`
(`31f5b9ee` at time of writing), not `integration/release-candidate-
provisional`. No verified dependency was found requiring `rc-provisional`
as a base — Milestone 2's foundation (everything in §1) is pure,
additive, and untouched by anything `rc-provisional` carries; the actual
overlap found (PR3's `student_intent.py`/`stream.py`/`visual_repair.py`
signature changes, already reconciled in `rc-provisional`'s commit
`ff34325d`) is a **PR3/visual-safety-owner concern**, not a reason for
THIS wiring PR to depend on their integration branch rather than
`origin/main` directly. If `rc-provisional` merges to `main` before this
PR is ready, this PR rebases onto the new `main` at that point, same as
any other PR would.

## 8. Correction 7 — concrete testing and release requirements

Required test coverage for the (now split, per §7) observational PR and
classifier-replacement PR, mocked throughout, route-level where noted:

- **OFF-mode legacy behavior**: a route-level test proving call #1's
  existing gate/behavior is COMPLETELY unchanged (not just "call #2 isn't
  invoked") — assert the SSE response body, `turnResolution` payload, and
  `tutor_state.active_question` persistence are byte-identical to current
  `origin/main` behavior for a fixture that triggers `needs_semantic_
  resolution`.
- **SHADOW output/state parity AND model-call accounting**: extend the
  existing shadow-vs-off equality pattern to also assert the NUMBER of
  model calls made per request (not just the decision) — a regression
  test for the §2 budget trade-off, so a future change that accidentally
  adds a live dual-shadow call is caught immediately, not discovered in
  production.
- **One-call ENABLED interpretation with compatible dialogue outputs**: a
  test that the unified call's validated output, once projected (§3),
  produces a `DialogueResolution` whose consumed fields (§3's table) match
  what the legacy sequential path would have produced, for the same
  fixtures `test_unified_semantic_call.py` already uses.
- **Valid/missing/forged/cross-conversation history**: route-level
  versions of the existing `TurnLedger`/`compile_policy` unit tests
  (already built — `test_policy_compiler.py`), proving the real
  `conversation_store`-backed ledger construction (§4) behaves the same
  way under the same adversarial inputs.
- **Explicit corrections and permission changes**: route-level version of
  case E/L (prohibition lifted/inherited across turns) using a REAL
  (mocked-DB) `get_durable_conversation_messages` call, not a hand-built
  `TurnLedger.build(...)` fixture — proving the actual plumbing, not just
  the pure function.
- **Timeout/malformed-output behavior that preserves known trusted
  constraints**: route-level version of `safe_fallback`'s corrected
  behavior (§5) — a unified-call timeout mid-request must not erase a
  constraint the deterministic layer already established earlier in the
  SAME request.
- **The live "Aufgabe 1" correction-request scenario, semantic routing
  explicitly deferred**: a test that reproduces the real reported bug
  (document-selection routing on a correction-shaped request) and asserts
  the observational PR does NOT fix it — recorded as an expected,
  documented gap (NOT an `xfail` — a passing test asserting "unchanged,
  pre-existing behavior, tracked separately," per §7's withdrawal of the
  earlier claim), with a comment pointing at the real fix (§7's deferred
  scope-resolution step).
- **A policy computed observationally but verified NOT to be accidentally
  consumed anywhere**: a test that greps/asserts no import of
  `policy_compiler`/`legacy_constraint_projection` exists in any of
  `answer.py`, `answer_stream.py`, `general_answer.py`, `visual_repair.py`,
  `course_grounding.py` for the observational PR specifically — a cheap,
  durable guard against scope creep landing silently in a later commit.

**Say this explicitly wherever it could be misread**: every mocked
semantic payload in this entire initiative's test suite (`test_policy_
compiler.py`, `test_unified_semantic_call.py`, `test_semantic_call_
support.py`, and whatever Milestone 3 adds) is a **contract test** — it
proves the code handles a given shape correctly. It is **never** evidence
that a real model reliably produces that shape, or that the real
classification is accurate. That requires the separate, explicitly-
approved held-out evaluation Milestone 1 §9 and this doc both already
flag, spent nowhere in this branch's work.

## 9. Explicitly deferred / NOT this PR's problem

- Full field-level provenance beyond what §5 already does (one `Origin`
  per `ReleaseConstraints` FIELD, not per whole `Action`) — would need a
  schema change, separate from the blocking gate in §5 (which is about
  checking EXISTING claims against trusted context, not adding new
  schema).
- The real held-out model evaluation (§2, §8) — separate, explicitly-
  approved budget, not spent here.
- Reconciling PR3's constraint design with Milestone 2's `Action`/
  `ReleaseConstraints` design — see `docs/semantic-intent-pr3-
  reconciliation.md` (this doc's sibling) for the actual migration plan;
  not re-derived here.
- The PR3/visual-safety `verify_and_repair_visual_assignment` question:
  **correction to the first version of this plan** — re-investigated this
  round with `git merge-tree` against both branch tips directly; there is
  **no git-level merge conflict in that specific function at all** (it
  auto-merges cleanly). The REAL, already-resolved conflict (in
  `integration/release-candidate-provisional`'s commit `ff34325d`) was
  PR3's `student_intent` parameter and a third, unrelated change's
  `needs_exercise_identification` parameter both landing on the same four
  function signatures in `stream.py`/`visual_repair.py` — not in
  `verify_and_repair_visual_assignment`, and already fixed. What remains
  a genuine, still-open coordination point (not a code conflict): once a
  LATER PR wires `ExecutionPolicy.release.final_answer`/
  `.official_solution` into visual answer-release logic, the visual-
  safety owner needs to sign off on how that combines with their own
  `verify_and_repair_visual_assignment` gate — two independent "should I
  release this" checks stacking without coordination is exactly how a bug
  slips through. That sign-off is still needed before THAT later PR, not
  before this one.
- Whether `concurrent_classification.py` should be deleted outright once
  this PR lands, or kept indefinitely as a documented dead end — product
  call, not a code question.
