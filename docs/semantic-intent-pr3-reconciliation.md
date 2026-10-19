# PR3 reconciliation packet: legacy `AnswerConstraints` → canonical `ExecutionPolicy`

Status: reconciliation review, read-only against PR3 and visual-safety's
branches. Written from `feature/semantic-intent-unification-m2`. Sibling
document to `docs/semantic-intent-milestone-3-plan.md` (that doc owns the
wiring-PR sequencing; this one owns the PR3-specific migration detail).

**Architectural decision this packet implements** (already made, not
re-derived here): the Milestone 2 multi-action `ResolvedStudentIntent` →
`ExecutionPolicy` architecture is canonical. PR3's global `AnswerConstraints`
is an earlier, narrower implementation of the same problem whose useful
enforcement, tests, repair, and cache plumbing get REUSED via migration,
not discarded.

## 1. Exact branch heads inspected

| Branch | SHA | Role |
|---|---|---|
| `feature/semantic-intent-constraints` | `5df5e313fe762b63cbf181136ddddf3d16442c60` | PR3 — read-only, via a new detached worktree at this exact commit (never checked out the branch ref itself, never touched the existing `pr3-intent-constraints` worktree). |
| `fix/visual-final-answer-safety` | `07afee52d2d83c7a5adf41fff04b69bf1e5d93be` | visual-safety — read-only, via `git show`/`git merge-tree`, no worktree created. |
| `integration/release-candidate-provisional` | `933ec6f7071b687869cf00a029c47a1d4a3b295b` | Integration branch — already carries PR3 + grounding + visual-safety reconciled (commit `ff34325d`), rooted at the same `origin/main` tip (`31f5b9ee`) this branch is. |
| `feature/semantic-intent-unification-m2` (this branch) | `69ee733b…` at time of writing | Where this packet and all Milestone 2 code live. |

## 2. PR3's actual implementation (what it is, precisely)

Four commits, in order: `e62e62dc` (adds `AnswerConstraints` + detection),
`4c173914` (wires it into six generation functions + `/ask` + cache),
`9b00d3d1` (tests), `e6271991`/`5df5e313` (two follow-up fixes).

`AnswerConstraints` (new field on `StudentIntent`, `app/services/
student_intent.py`):

```python
@dataclass(frozen=True)
class AnswerConstraints:
    withhold_answer: bool = False
    hint_only: bool = False
    one_question_at_a_time: bool = False
```

Detected deterministically only (`_detect_answer_constraints`, three
regexes — `_WITHHOLD_ANSWER_RE`, reused `wants_hint_only` from
`dialogue_state.py`, `_ONE_AT_A_TIME_RE`) — PR3 deliberately did not
extend the semantic model's JSON schema. **Enforcement mechanism is
prompt-overlay only, with no structural/verification check of
compliance**: `student_intent_constraints_reminder(intent)` renders a
"STUDENT-REQUESTED ANSWER CONSTRAINTS (explicit — do not weaken, ignore,
or override these)" text block, appended as the literal last line of
both the system prompt and user message at each of its six call sites.
Nothing re-checks whether the model actually obeyed it. This is an
important, real limitation to carry into the migration plan: PR3's
"enforcement" and Milestone 2's `ExecutionPolicy` are not at the same
level of rigor — migrating to `ExecutionPolicy` does not, by itself, add
verification either. That is a separate, later concern (possibly shared
with visual-safety's verification pattern — see §6).

## 3. Field-by-field mapping: PR3's 3 booleans → `ReleaseConstraints`

| PR3 field | `ReleaseConstraints` dimension | Mapping | Notes |
|---|---|---|---|
| `withhold_answer` | `final_answer: Literal["permitted","prohibited","unspecified"]` | `True` ⟺ `final_answer == "prohibited"` | Direct, unambiguous. PR3 has no `official_solution` dimension (no distinction between "the tutor's own computed answer" and "the instructor's official solution key") — a migrated caller that wants BOTH withheld must set both; the boolean alone only implies `final_answer`. |
| `hint_only` | `form: Literal["hint","guided_questions","explanation","worked_solution","unspecified"]` | `True` ⟺ `form == "hint"` | Chosen as the single most direct correspondence (delivery FORM, not a composite). A `hint_only` response is ALSO typically `final_answer=prohibited` and capped `explanation_depth`, but this packet does NOT fold those into one boolean's meaning — see §4's one-way-only rule for why collapsing the other direction is unsafe, and the projection module's docstring for the precise, deliberately narrow choice. |
| `one_question_at_a_time` | `wait_for_student: bool \| None` | `True` ⟺ `wait_for_student is True` | Pacing/interaction-pattern, not disclosure. `max_items=1` is a defensible secondary companion mapping (if "one at a time" also means "at most one item per response") but is a PRODUCT decision PR3's owner should make explicitly, not something this packet decides unilaterally. |

**Never implemented, and explicitly not to be built**: deriving
`ResolvedStudentIntent.actions`/`ReleaseConstraints` FROM these three
booleans. That direction loses exactly the target-specific information
Milestone 2 exists to represent — case C ("no solution for 5, full
solution for 6") collapses into one ambiguous `withhold_answer` with no
way to recover which target it meant.

## 4. The one-way compatibility adapter (built this round)

`app/services/legacy_constraint_projection.py` (new, additive, tested —
`tests/test_legacy_constraint_projection.py`, 7 tests, all passing):

```python
def project_execution_policy_to_legacy_constraints(
    policy: ExecutionPolicy,
) -> LegacyAnswerConstraintsProjection | None:
```

Returns the projected `(withhold_answer, hint_only, one_question_at_a_time)`
**only** when:
- `policy.needs_clarification` is `False`, and
- the policy has **exactly one** target (`len(policy.actions) == 1`).

Returns `None` — "stay on PR3's own existing deterministic detector for
this turn, unchanged" — otherwise. The multi-target case (case C/H
shaped) is the one explicitly named in the task as needing to "stay
gated until migrated" rather than get an unsafe adapter: a legacy,
single-shot consumer generates ONE answer for the whole turn, with no
concept of "which target does this constraint apply to" — collapsing two
opposite per-target constraints into one boolean could silently apply the
WRONG one to the answer actually being generated. Refusing (returning
`None`) rather than guessing is the safe choice; it never widens
permissions (compiled `ExecutionPolicy` values are always fully resolved,
never `"unspecified"`, by the time this function sees them — confirmed
via `policy_compiler`'s own rule 5), and in the single-target case it can
only ever reflect exactly what the canonical policy already decided, never
loosen it.

## 5. Consumer-by-consumer migration table

| Consumer (file) | Current input contract | What it actually enforces | PR3 tests (ran against PR3 tip `5df5e313`) | Migration path | Owner | Overlaps with |
|---|---|---|---|---|---|---|
| `app/services/answer.py` (`generate_answer`) | `student_intent: StudentIntent \| None` kwarg | Prompt-overlay text appended to system+user content; no compliance check | `test_answer_student_intent_constraints.py` (part of 165, see §7) — pass | **Compatibility adapter first**: accept an optional `ExecutionPolicy`/projection alongside `student_intent`, feed `student_intent_constraints_reminder`-equivalent text from whichever is present (projection preferred when non-`None`, else PR3's own detector) — zero behavior change in both-`None`/legacy-only cases. Full migration (reading `ExecutionPolicy.actions` directly, per-target) is a LATER PR, since `generate_answer` is a single-shot generator today with no per-target answer concept either. | PR3 owner | Visual-safety: none directly (different file). Grounding: none directly. |
| `app/services/answer_stream.py` (`stream_answer`) | same `student_intent` kwarg | Same prompt-overlay pattern; also where `verify_and_repair_visual_assignment` lives (different function, same file) | same file, pass | Same compatibility-adapter-first path as `answer.py`. | PR3 owner | **File-level overlap with visual-safety** (different function, see §6) — no current code conflict (`git merge-tree` confirms clean auto-merge), but future `ExecutionPolicy`-driven changes to THIS function and visual-safety's eventual changes to `verify_and_repair_visual_assignment` both land in this file; sequence, don't parallelize, those two PRs. |
| `app/services/general_answer.py` (`generate_general_answer`, `stream_general_answer`) | same `student_intent` kwarg | Same prompt-overlay pattern | `test_general_answer_contract.py`, pass | Same compatibility-adapter-first path. | PR3 owner | None found. |
| `app/services/visual_repair.py` (`repair_false_visual_denial`, `repair_false_visual_denial_sync`, `generate_grounded_repair_sync`) | same `student_intent` kwarg, rebuilds a single-message prompt from scratch | Same prompt-overlay pattern, via `_prohibition_and_intent_block` | `test_visual_repair_constraints.py`, pass | Same compatibility-adapter-first path. **Already has a real, already-resolved signature conflict** with a third, unrelated change (`needs_exercise_identification`) — resolved in `rc-provisional`'s `ff34325d`, re-verify at rebase time that this branch's merge base still matches. | PR3 owner (+ whoever owns `needs_exercise_identification`, name not established by this review) | Visual-safety: file proximity only (not the same functions). |
| `app/services/cache.py` (`question_hash`'s `intent_fingerprint` kwarg) | `intent_constraints_fingerprint(mode, intent) -> str` | Cache-key isolation: `""` for off/shadow always, a non-empty policy-version-marked string for enabled | `test_cache.py` + `test_ask_router.py` additions, pass | `ExecutionPolicy.policy_hash` is designed for exactly this role already (see `policy_compiler.compute_policy_hash`'s own docstring: "logging/cache-keying/consistency ONLY"). Migration: once a consumer reads `ExecutionPolicy` instead of legacy `AnswerConstraints`, swap the fingerprint source too — same cache-isolation property, canonical hash. | PR3 owner | None found. |
| `app/routers/ask.py` (`_student_intent_for_ask`) | Builds a single-turn `DialogueResolution` stub + resolves `StudentIntent` for the non-streaming path | Gating/computation only, mirrors `stream.py`'s pattern | `test_ask_router.py`, pass | Needs the SAME `ExecutionPolicy`-vs-adapter decision as `stream.py` itself (Milestone 3 plan §2/§7) — this file is a second call site for the same question, not an independent one. | PR3 owner + this branch's eventual M3 PR owner (same person, likely) | None found. |
| `app/routers/stream.py` (gating, `resolve_execution_plan` signal) | `semantic_intent_mode != "off"` gate | Computes `StudentIntent`, forwards only as an inert `signals` marker today (`execution_signal`) | Not a PR3-specific test file; covered by `test_student_intent.py` or integration tests at the resolve_execution_plan boundary | This is the file Milestone 3's plan (§2) replaces the two-call sequence in — PR3's wiring here is additive (new param), Milestone 3's change is structural (new call shape). Sequence: PR3's compatibility adapter lands FIRST (small, safe), Milestone 3's classifier replacement lands LATER, independently. | This branch's M3 PR owner | See Milestone 3 plan §3 (dialogue contract) for why this is the riskier of the two changes. |

## 6. Ownership decisions needed (named explicitly, not resolved here)

- **PR3 owner** (`feature/semantic-intent-constraints`): decide whether
  to adopt `legacy_constraint_projection.py`'s compatibility-adapter-first
  path (§5) as the migration strategy, or propose an alternative. This
  packet recommends the adapter-first path because it is additive and
  reversible; the PR3 owner may have context (e.g. planned product
  changes to `AnswerConstraints` itself) that changes the calculus.
- **Visual-safety owner** (`fix/visual-final-answer-safety`): **input
  needed before anyone changes `verify_and_repair_visual_assignment` or
  its accepted final-answer contract.** Correction to an earlier,
  overstated claim in the first version of the Milestone 3 plan: there is
  **no current git-level conflict** in that function between PR3 and
  visual-safety (verified directly with `git merge-tree
  feature/semantic-intent-constraints fix/visual-final-answer-safety` —
  `app/services/answer_stream.py` auto-merges cleanly; PR3's commits never
  touch that function's line range at all). The REAL, already-resolved
  conflict was a different, unrelated signature collision in
  `stream.py`/`visual_repair.py` (`ff34325d`, see §1/§5). What genuinely
  still needs this owner's sign-off, later, not now: whether/how
  `ExecutionPolicy.release.final_answer`/`.official_solution` should
  combine with `verify_and_repair_visual_assignment`'s own verification
  gate once a PR proposes wiring the two together — two independent
  "release this answer?" checks stacking without an agreed contract is a
  real risk, not a hypothetical one.
- **Grounding owner** (`fix/course-grounding-evidence-gate`): confirm
  `ExecutionPolicy.evidence_requirements` is additive to the existing
  evidence gate (this packet's assumption), not a replacement — not
  touched by this round's work either way, flagged for when a PR
  actually proposes wiring it in.
- **Integration owner** (`integration/release-candidate-provisional`):
  informational only this round — no action requested; `rc-provisional`
  already carries the PR3/visual-safety-adjacent reconciliation (`ff34325d`)
  cleanly.

## 7. Test coverage — actual numbers (run, not estimated)

Ran directly against PR3's own tip (`5df5e313`), via a detached worktree
at that exact commit (never the branch ref, never touching the existing
`pr3-intent-constraints` worktree):

```
tests/test_student_intent.py
tests/test_answer_student_intent_constraints.py
tests/test_general_answer_contract.py
tests/test_visual_repair_constraints.py
tests/test_cache.py
tests/test_ask_router.py
tests/test_intent_base_parity.py
  → 165 passed, 0 failed

Full backend suite at the same commit:
  → 3428 passed, 10 skipped, 0 failed
```

No failing or newly-xfailed PR3 test was found or touched. Nothing in
this round's work modified any PR3 test file.

**Known gap, not a test failure**: PR3's own test coverage verifies the
prompt-overlay TEXT is present/absent correctly (string-level assertions
against captured outgoing messages) — it does not and cannot verify the
MODEL actually complies with the instruction, since no test here or in
PR3 makes a real call. This is the same "contract test, not real-model
evidence" caveat the Milestone 3 plan (§8) states for Milestone 2's own
mocked tests — applies equally to PR3's.

## 8. Behavior-inert wiring vs. actual ENABLED-mode functionality (this packet's slice)

- **Behavior-inert**: building `legacy_constraint_projection.py` (done,
  this round) and even wiring it into a consumer's call site AS AN
  ADDITIONAL, NEVER-YET-POPULATED optional parameter (i.e. the consumer
  accepts an `ExecutionPolicy` argument that nothing yet passes a
  non-`None` value for) — zero behavior change, purely preparatory.
- **Actual functionality change**: the moment some caller starts passing
  a real, non-`None` `ExecutionPolicy` into one of §5's consumers, and
  that consumer starts preferring the projection over PR3's own
  deterministic detector — this changes what text reaches the model, and
  is gated behind whatever flag/mode decision Milestone 3's plan (§2 of
  that doc) settles on for `ExecutionPolicy` computation generally. This
  packet does not propose shipping that half on its own.

## 9. Recommended order of small integration PRs

1. **This round's work** (already done): `legacy_constraint_projection.py`
   + tests, additive, unconsumed. No PR needed beyond what's already on
   this branch.
2. **PR3-owned, small**: thread an optional `execution_policy: ExecutionPolicy
   | None` parameter through the six generation functions in §5 (mirroring
   exactly how PR3 itself threaded `student_intent` through them),
   preferring `project_execution_policy_to_legacy_constraints(execution_
   policy)` over `student_intent.answer_constraints` when both are
   present and the projection returns non-`None`. Still nothing calls it
   with a real policy yet — behavior-inert per §8.
3. **This-branch-owned** (Milestone 3 plan §7's "observational PR"):
   compute a real `ExecutionPolicy` per request (flag-gated,
   `needs_clarification`/multi-target cases naturally degrade to "stay on
   legacy" via step 2's adapter), log it, pass it into step 2's new
   parameter. First point where real policies flow into PR3's consumers —
   still behavior-inert for any multi-target/needs-clarification case
   (adapter returns `None`, legacy path unchanged), and for single-target
   cases, changes behavior only to the extent the projection's values
   differ from PR3's own regex detection (expected to usually agree,
   should be instrumented/compared before trusting).
4. **Later, separately reviewed**: the dialogue-classifier replacement
   (Milestone 3 plan §7's second category) and the visual-safety
   coordination (§6) — explicitly NOT bundled with 1-3.

## 10. Exact files for the first safe implementation PR (step 2 above)

- `backend/python-ai/app/services/answer.py` (new optional parameter on
  `generate_answer`, ~3 lines)
- `backend/python-ai/app/services/answer_stream.py` (new optional
  parameter on `stream_answer`, ~3 lines — does NOT touch
  `verify_and_repair_visual_assignment`)
- `backend/python-ai/app/services/general_answer.py` (new optional
  parameter on both functions, ~6 lines)
- `backend/python-ai/app/services/visual_repair.py` (new optional
  parameter on three functions + `_prohibition_and_intent_block`, ~10
  lines)
- `backend/python-ai/app/services/cache.py` (accept an optional
  `policy_hash` alongside the existing `intent_fingerprint`, additive)
- New/extended tests in each of the corresponding `tests/test_*.py` files
  already listed in §7, asserting the new parameter defaulting to `None`
  produces byte-identical output to omitting it entirely (the same
  off/shadow-parity pattern PR3's own tests already use).

This PR is owned by whoever owns PR3 today; this branch does not open it
— it is handed off via this document.
