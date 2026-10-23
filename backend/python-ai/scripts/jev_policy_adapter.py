"""Shared Jev -> real-policy-compiler adapter (2026-10-23).

Used by both the offline rescoring of already-saved Jev answers
(jev_policy_rescoring.py) and, going forward, any real Arm C/D runner --
one adapter, so a future live run and this offline analysis can never
silently diverge on what "feeding Jev through the trusted compiler" means.

Treats Jev's ``target``/``objective`` choices as UNTRUSTED INTERPRETATION
PROPOSALS, never as an authorization decision. Jev's own
``final_answer_permitted`` noul is NEVER read into the compiled
``Action`` -- ``compile_policy``'s own existing, already-tested fallback
rules decide ``final_answer``, exactly the way the deterministic
production path's ``diagnostic_policy.adapt_deterministic_intent`` does for
a deterministically-derived claim. See that module's docstring for the
production convention this mirrors (the "current_request" placeholder, the
``_OBJECTIVES_WITHOUT_EXERCISE_IDENTITY`` exemption).

Explicit-tracking contract (2026-10-23 review requirement): "never treat
absent restriction information as evidence that permission was granted."
This module never does -- every field in ``JevRescoreResult`` records WHY
a value was produced (``compile_policy``'s own audit tags, already present
in ``ExecutionPolicy.platform_policy_applied``), so "defaulted to permitted
because compile_policy's pre-existing tutoring_default rule says so" is
always distinguishable, after the fact, from "defaulted because nothing
addressed this field at all." Four categories are flagged explicitly
rather than silently folded into a single accuracy number:

- ``target_unverified``: Jev's claimed target never grounded against the
  document's real exercise labels or the literal message text.
- ``objective_unsupported``: the gold ``form`` has no Jev objective value
  that preserves its protective fallback (see ``UNSUPPORTED_FORMS``).
- ``permission_change_untestable``: this turn's correct answer depends on
  a PRIOR turn's restriction/permission state, which this single-turn,
  no-``TurnLedger`` adapter cannot represent at all (not "got it wrong",
  genuinely not evaluable this way -- a live Arm with a real ledger is the
  only way to test this honestly).
- ``multi_target``: gold names more than one target in the same turn --
  Jev's schema can only propose one.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from app.services.diagnostic_policy import resolve_target_identity
from app.services.policy_compiler import compile_policy
from app.services.resolved_student_intent import Action, ReleaseConstraints, ResolvedStudentIntent

ROOT = Path(__file__).resolve().parents[1]

_VALID_OBJECTIVES = frozenset({"hint", "explain", "solve", "summarize", "other"})
# The subset of diagnostic_policy._OBJECTIVES_WITHOUT_EXERCISE_IDENTITY that
# Jev's vocabulary can even express -- ported, not invented: production
# treats these as never needing a verified numbered-exercise identity.
_OBJECTIVES_WITHOUT_EXERCISE_IDENTITY = frozenset({"explain", "summarize"})

# Gold corpus forms whose protective fallback Jev's 5-value objective
# vocabulary cannot reach: both map to objective="other" in
# jev_corpus_evaluation.py's own question design, which gets
# compile_policy's ordinary tutoring default (final_answer permitted),
# never the quiz-specific protection diagnostic_policy.py's
# AcademicIntent.QUIZ_GENERATION -> "hint" mapping gives the deterministic
# path. This is a real property of Jev's schema, not this script's choice.
UNSUPPORTED_FORMS = frozenset({"quiz_start", "answer_check"})

# Categories in semantic_blind_ab_corpus.json whose entire point is that a
# turn's correct answer depends on an EARLIER turn's permission/restriction
# state -- untestable by a single-turn, turn_ledger=None adapter no matter
# how it's built. Turn index 0 of each is still a plain single-turn case
# (nothing prior to depend on) and IS evaluable.
_PERMISSION_DEPENDENT_CATEGORIES = frozenset({
    "changing_instructions_more_help", "changing_instructions_less_help",
    "cache_history_control", "cache_history_no_replay",
})


def authorized_labels(document: dict) -> frozenset[str]:
    return frozenset((document.get("exercises") or {}).keys())


@dataclass(frozen=True)
class JevRescoreResult:
    target_resolved: bool
    compiled_state: str
    compiled_final_answer: str
    policy_audit: tuple[str, ...]  # compile_policy's own fallback-tag trail for this action
    target_unverified: bool
    objective_unsupported: bool


def rescore_jev_answer(
    *, jev_target: str, jev_objective: str, gold_form: str, message: str, document: dict,
) -> JevRescoreResult:
    labels = authorized_labels(document)
    is_content_scope = jev_target == "document" or jev_target.startswith("section:") or jev_target == "none"
    target_resolved = (not is_content_scope) and resolve_target_identity(
        jev_target, original_message=message, verified_active_question=None,
        authorized_exercise_labels=labels,
    )
    objective = jev_objective if jev_objective in _VALID_OBJECTIVES else "other"
    # Mirrors diagnostic_policy.py's "current_request" placeholder
    # convention exactly -- see module docstring.
    action_target = jev_target if target_resolved else "current_request"
    state = (
        "requested" if (target_resolved or objective in _OBJECTIVES_WITHOUT_EXERCISE_IDENTITY)
        else "unresolved"
    )
    action = Action(
        objective=objective, target=action_target,
        release=ReleaseConstraints(),  # fully unspecified -- Jev's noul is NEVER read into this
        state=state,
    )
    intent = ResolvedStudentIntent(
        schema_version="1.0.0", original_message=message, student_goal=message,
        actions=(action,), conversation="new", references=None,
        response_language="en", teaching=None, trust=None,
    )
    policy = compile_policy(intent, turn_ledger=None, conversation_id=None)
    compiled = policy.actions[0]
    return JevRescoreResult(
        target_resolved=target_resolved or is_content_scope,
        compiled_state=compiled.state,
        compiled_final_answer=compiled.release.final_answer,
        # One action per intent here, so every audit tag already belongs
        # to this target -- no filtering needed.
        policy_audit=policy.platform_policy_applied,
        target_unverified=not (target_resolved or is_content_scope),
        objective_unsupported=gold_form in UNSUPPORTED_FORMS,
    )


def is_permission_change_untestable(*, category: str, turn_index: int) -> bool:
    """True only for a turn whose correct interpretation genuinely depends
    on an earlier turn's permission/restriction state -- never for turn
    index 0 of any scenario, since there is nothing prior to depend on."""
    return category in _PERMISSION_DEPENDENT_CATEGORIES and turn_index > 0


def load_corpus() -> dict:
    return json.loads((ROOT / "tests/fixtures/semantic_blind_ab_corpus.json").read_text(encoding="utf-8"))


def load_documents() -> dict:
    return json.loads((ROOT / "tests/fixtures/semantic_blind_ab_documents.json").read_text(encoding="utf-8"))
