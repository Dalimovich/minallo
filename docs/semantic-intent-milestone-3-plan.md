# Semantic Intent — Milestone 3 plan: the first real wiring PR

Status: proposal, not yet started. Written from branch
`feature/semantic-intent-unification-m2` (commit `d94cb766` at time of
writing) after Milestone 2 ("isolated foundations") + its hardening pass +
two further architectural decisions (trusted turn ledger; one-call budget).
Nothing described here has been built — this is the handoff for whoever
picks up Milestone 3.

## 1. What Milestone 2 actually shipped (the foundation this PR builds on)

- `app/services/resolved_student_intent.py` — `ResolvedStudentIntent`/
  `Action`/`Origin`/`ReleaseConstraints`/`TurnLedger`/`VerifiedTurn`, plus
  provenance validation (`validate_origin`, `validate_action_provenance`,
  `validate_intent_provenance`) and the legacy-bridge derivation functions.
- `app/services/policy_compiler.py` — `compile_policy()`: pure, deterministic,
  turn-ledger-aware, platform-policy-aware. Produces `ExecutionPolicy`
  (`actions`, `evidence_requirements`, `needs_clarification`,
  `response_language`, `policy_hash`, full audit trail in
  `platform_policy_applied`).
- `app/services/semantic_call_support.py` — `needs_semantic_escalation`
  (widened trigger, NOT wired into `student_intent._needs_semantic_path`
  yet) and `validate_semantic_action` (strict schema + consistency
  validation for one model-proposed action).
- `app/services/unified_semantic_call.py` — the one-call adapter proposal
  (Decision 1): `build_unified_call_frame`, `validate_unified_call_output`,
  `safe_fallback`. Produces a `ResolvedStudentIntent` directly from one
  mocked-so-far structured-output call shape.
- `app/services/concurrent_classification.py` — the `asyncio.gather`
  two-call concurrency primitive. **Superseded** for the budget decision
  (still issues two calls); kept as tested code, explicitly not to be wired
  into anything live.
- `app/services/dialogue_state.py` — one small, already-landed change:
  latency logging added to `resolve_dialogue_semantically` (Milestone 1's
  flagged gap). This is the only edit to an existing production file
  across all of Milestone 2.

None of the above is imported by `app/routers/stream.py`,
`app/services/student_intent.py`, `app/services/answer_intent.py`, or
`app/services/course_grounding.py`. That wiring is this PR.

## 2. What this PR would actually do

Replace today's two sequential calls in `app/routers/stream.py` (around
line 1666–1754 as of `31f5b9ee`) with:

1. **Deterministic pre-resolution** (unchanged): `resolve_dialogue(...)`,
   `select_processing_pipeline(...)`, `resolve_document_access(...)` — all
   stay exactly as they are today.
2. **At most one semantic call** when `needs_semantic_escalation(...)`
   (replacing `student_intent._needs_semantic_path` AND
   `dialogue_state.needs_semantic_resolution` — both gates collapse into
   one) fires: `build_unified_call_frame` → the real OpenAI call (today
   mocked in `test_unified_semantic_call.py`) → `validate_unified_call_output`.
   On any failure: `unified_semantic_call.safe_fallback`.
3. **Provenance validation**: `validate_intent_provenance(...)` against a
   REAL `TurnLedger` built from this request's own trusted conversation
   history (see §3 — this is itself new plumbing, not just a function
   call) and the authenticated `conversation_id`/`user_id`.
4. **Policy compilation**: `compile_policy(...)`.
5. **Consumers read `ExecutionPolicy`** — NOT part of this PR (see §4 for
   why that's deliberately a separate, later PR).

## 3. New plumbing this PR needs that Milestone 2 did NOT build

- **A real `TurnLedger` source.** Milestone 2's `TurnLedger.build` is the
  trusted constructor, but nothing today persists per-turn `sequence`/
  `conversation_id`/`user_id` in a form it can consume. This PR needs to
  decide: build the ledger from `payload.previousTurns` (already present
  in the request, already trusted in the sense that it comes from the
  session's own conversation — but NOT independently verified against a
  server-side conversation record), or from a real persistence lookup
  (slower, stronger). **This is the first open question for whoever owns
  this PR** — Milestone 2 deliberately left it open (see
  `policy_compiler.compile_policy`'s own docstring: "Milestone 3 should
  decide whether a ledger is made mandatory at the real call site").
- **The real single-call prompt/schema**, replacing the mocked JSON shapes
  in `test_unified_semantic_call.py`. Those mocks are hand-built
  structurally-valid payloads, not evidence the real model reliably
  produces this shape — Milestone 1's own report (§9) already flags that a
  real held-out evaluation needs separate, explicitly-approved budget
  before `SEMANTIC_INTENT_MODE=enabled` is viable at all.
- **A migration plan for `StudentIntent`.** `derive_primary_task`/
  `derive_prohibited_tasks` (already built, tested) are the bridge, but no
  code calls them yet — this PR is where `interpret_student_intent`'s
  return type question gets settled (extend `StudentIntent` in place,
  or have the router hold both shapes side by side for one release).

## 4. Why "wire it in" and "consumers read the policy" are two different PRs

`compile_policy`'s output is only as good as what's downstream of it.
Shipping the wiring WITHOUT also auditing every consumer that currently
reads `StudentIntent`'s scalar fields (or nothing at all, pre-Milestone-1)
risks a policy that's computed correctly and then ignored, or worse,
partially honored. Keeping them separate also keeps this PR's blast radius
to "compute and store a new, additional object" rather than "change what
the model is told to do" — strictly safer to review and roll back.

## 5. Branch ownership map — who owns what this PR would touch

| File | Owner branch | Status |
|---|---|---|
| `app/routers/stream.py` | this PR (new edits) | Every other branch below ALSO edits files near this one's call sites' neighbors, not this file's two call sites directly — confirmed no direct line-level conflict as of this writing, but re-check before starting. |
| `app/services/student_intent.py` | this PR (new edits) + PR3 `feature/semantic-intent-constraints` (already landed `e62e62dc` "add typed answer-release/pacing constraints") | **Real overlap.** PR3 added its OWN typed release/pacing constraint concept directly on `StudentIntent`/the dialogue layer, independently of Milestone 2's `ReleaseConstraints`/`Action`. These are two designs for the same problem built in parallel, on different branches, rooted at the same `origin/main` tip (`31f5b9ee`). Reconciling them — or picking one — is this PR's single biggest open question, bigger than the ledger plumbing. |
| `app/services/dialogue_state.py` | this PR (new edits) | Already has Milestone 2's latency-logging change merged on this branch; PR3 and others don't appear to touch this file directly as of this writing — re-check at rebase time. |
| `app/services/answer_stream.py` | NOT this PR, but downstream of it (final-answer/visual release decisions) | **Known, already-flagged conflict between two OTHER owners**, not this PR's to resolve: `verify_and_repair_visual_assignment`'s signature/implementation differs between `feature/semantic-intent-constraints` (PR3, still the pre-fix version as of `5df5e313`) and `fix/visual-final-answer-safety` (`07afee52`, the one already adopted into `integration/release-candidate-provisional`). **This PR must wait for PR3 and visual-safety's owners to converge on one implementation before `answer_stream.py` can safely become a `compile_policy` consumer** — attempting that reconciliation here would be scope creep on top of already owning the ledger + unified-call plumbing. |
| `app/services/course_grounding.py` | `fix/course-grounding-evidence-gate` (merged into `integration/release-candidate-provisional` already) | Not touched by this PR directly; `evidence_requirements` on `ExecutionPolicy` is designed to be read by grounding, not to replace its own evidence-gate logic. A later, narrower PR should wire `evidence_requirements` into this file once this PR's `ExecutionPolicy` actually exists at runtime. |
| `integration/release-candidate-provisional` | integration branch | Already carries PR3 (base) + grounding + visual-safety reconciled together, rooted at the same `origin/main` tip this branch is. This PR's eventual target is almost certainly a rebase onto whatever `rc-provisional` becomes, not `origin/main` directly — confirm with whoever owns `rc-provisional` before opening the real PR. |

## 6. The interface each owner needs to agree to

- **PR3 (`feature/semantic-intent-constraints`)**: needs to agree whether
  its own release/pacing constraint fields on `StudentIntent` are replaced
  by `ReleaseConstraints`/`Action`, or whether `derive_primary_task`-style
  bridging goes the OTHER direction (Milestone 2's `Action` list derives
  from PR3's constraints instead). Both are legitimate; only one should
  ship. **Do not pick for them** — this doc flags it, this PR's owner
  negotiates it.
- **Visual-safety (`fix/visual-final-answer-safety`)**: needs to agree
  that `ExecutionPolicy.actions[*].release.final_answer`/
  `.official_solution` is the signal `verify_and_repair_visual_assignment`
  (or whatever it becomes) checks before releasing an image-dependent
  answer — once PR3's conflict with it is resolved (see §5).
- **Grounding (`fix/course-grounding-evidence-gate`)**: needs to agree
  that `ExecutionPolicy.evidence_requirements` is additive to its existing
  gate, not a replacement — this PR should not touch
  `course_grounding.py`'s own logic at all, only eventually feed it a new
  input.
- **Integration (`integration/release-candidate-provisional`)**: needs to
  confirm this PR targets `rc-provisional`, not `origin/main`, and needs
  the ledger-source decision (§3) made before accepting it, since that
  decision affects whether `previousTurns` payload validation needs to
  change too.

## 7. Acceptance criteria for this PR

1. `app/routers/stream.py`'s two sequential calls are replaced by exactly
   one semantic call per turn when `needs_semantic_escalation` fires — a
   test asserts the mocked model client is invoked at most once per
   request across the whole `/ask-stream` handler path for every fixture
   in the existing offline evaluation suite (reference cases A–L) plus the
   dialogue-relation comparison fixtures from
   `test_unified_semantic_call.py`.
2. `SEMANTIC_INTENT_MODE=off` remains byte-identical to pre-PR behavior —
   the existing flag-off parity tests in `test_student_intent.py` pass
   unmodified, and a new end-to-end parity test at the router level
   confirms the SSE response body is unchanged with the flag off.
3. `SEMANTIC_INTENT_MODE=shadow` computes and logs
   (`compile_policy`'s output, via the same privacy-conscious
   counts/enums-only logging pattern `_log_shadow` already uses) but has
   zero effect on the response, the cache key, or any persisted record —
   a new shadow-vs-off equality test at the router level, extending the
   existing `test_student_intent_signal_is_additive_only_never_changes_
   the_decision` pattern.
4. A real `TurnLedger` is constructed per request from a source the PR's
   author has gotten explicit sign-off on (§3) — never from
   `payload`-supplied turn metadata treated as self-verifying, and never
   blindly trusting model output for any part of it.
5. Zero paid model calls in CI/tests — every test in this PR's own test
   files mocks the client; the real single-call prompt is validated
   against the EXISTING mocked structural tests in
   `test_unified_semantic_call.py`, extended, not replaced.
6. The PR does not modify `app/services/answer_stream.py`,
   `app/services/course_grounding.py`, or PR3's release/pacing fields on
   `StudentIntent` without an explicit, separate sign-off from those
   files' owners (§6) — if any of those changes turn out to be required
   to land this PR, that is a sign the PR's scope needs to shrink, not
   that the sign-off requirement should be skipped.
7. `compile_policy`'s result is computed and stored/logged (per the mode)
   but no consumer's actual behavior changes as a result of this PR alone
   — acceptance criterion 2/3 above are the direct test of this; "a
   policy gets computed" and "a policy gets obeyed" ship in different PRs.
8. Full backend test suite green, scoped `pyright` clean, same standard
   Milestone 2 held itself to throughout.

## 8. Explicitly deferred / NOT this PR's problem

- Full field-level provenance (one `Origin`/`changed_by_turn` per
  `ReleaseConstraints` FIELD, not per whole `Action`) — would need a
  schema change. Documented as a known limitation in
  `resolved_student_intent.py` and `policy_compiler.py`; revisit only if
  a real exploit/bug traces back to it.
- The real held-out model evaluation Milestone 1 (§9) and this doc both
  flag as needing its own separate, explicitly-approved budget before
  `SEMANTIC_INTENT_MODE=enabled` goes anywhere near production traffic.
- Reconciling PR3's constraint design with Milestone 2's `Action`/
  `ReleaseConstraints` design (§6) — flagged, not resolved, here.
- Reconciling the PR3/visual-safety `verify_and_repair_visual_assignment`
  conflict (§5) — those two branches' owners' problem, not this PR's.
- Whether `concurrent_classification.py` should be deleted outright once
  this PR lands, or kept indefinitely as a documented dead end — product
  call, not a code question.
