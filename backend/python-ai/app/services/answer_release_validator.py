"""Semantic Student Intent Layer Phase D — an independent, deterministic
backstop against a generated answer leaking a result the compiled
``ExecutionPolicy`` prohibited.

Why this exists, stated plainly: ``policy_prompt_rendering.py`` (Phase C)
only ever produces PROMPT TEXT — the same enforcement level PR3's own
reconciliation packet already names as a real limitation ("enforcement
mechanism is prompt-overlay only, with no structural/verification check
of compliance"). A model can still ignore, forget, or be talked out of
an instruction, especially under an adversarial framing ("let's check
our work: the answer is 42 N"). This module is the check that runs on
the ACTUAL generated text, independent of whether the prompt asked
correctly.

What this module is NOT: a general-purpose, reliable "is this text
correct" verifier. It cannot know the real numeric answer, so it cannot
confirm a number is RIGHT — only that the text contains a RELEASE-SHAPED
pattern (a final-answer/official-solution statement) when the policy
says that should be withheld for some target. This is a deliberately
narrow, pattern-based, conservative scan — not a claim of semantic
understanding. Where it is uncertain, it treats the output as a match
(fail closed) rather than silently passing it through. Per the explicit
instruction this module was built against: "do not claim a general-
purpose output validator is perfect based on a handful of examples" —
it is not claimed to be; see the module's own test file for exactly
which adversarial shapes are covered (prose, table cell, LaTeX, a
"let's check our work" framing) and which are explicitly NOT (e.g. a
genuinely novel unit-conversion phrasing never seen in these patterns —
flagged in the final report as needing real-model adversarial
evaluation, not claimed solved here).

Missing target attribution: the scan does not (cannot, from plain text)
attribute a matched leak to a SPECIFIC target when a policy has
multiple actions. It treats ANY prohibited final_answer/official_
solution across ANY target as grounds to withhold the WHOLE response —
the conservative choice the task explicitly asked for ("treat missing
target attribution and ambiguous results conservatively"), not an
attempt to surgically redact only the offending target's portion (doing
that correctly would itself need per-target text attribution this
plain-text scan does not have).

Priority 2 addendum: ``enforce_release_policy_per_target`` (below) is
the one place that DOES get real per-target attribution — not from
plain-text guessing, but from a structural contract the model is
instructed to follow (``policy_prompt_rendering.render_target_
sectioning_contract``'s literal ``[[TARGET: ...]]``/``[[END]]``
markers) and that is strictly, server-side parsed (``parse_target_
sections``) before any section is ever trusted. It is additive and
parallel to everything above, not a replacement: it only engages for a
genuinely mixed-permission policy, and falls straight back to the
whole-response guard above for anything it cannot verify.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .policy_compiler import ExecutionPolicy, is_mixed_permission_policy
from .resolved_student_intent import Action

_LEAK_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("final_answer_phrase", re.compile(
        r"\b(?:the\s+(?:final\s+)?(?:answer|result)\s+is|final\s+answer\s*:|"
        r"das\s+(?:end)?ergebnis\s+ist|die\s+(?:l(?:ö|oe)sung|antwort)\s+(?:ist|lautet))\b",
        re.IGNORECASE,
    )),
    ("boxed_or_labeled_result", re.compile(
        r"\\boxed\{|\*\*(?:final\s+)?(?:answer|result|ergebnis)\*\*|"
        r"^\s*(?:answer|result|ergebnis)\s*:\s*\S",
        re.IGNORECASE | re.MULTILINE,
    )),
    ("result_table_row", re.compile(
        r"\|[^|\n]{0,40}\b(?:final\s+)?(?:answer|result|ergebnis|l(?:ö|oe)sung)\b[^|\n]{0,10}\|",
        re.IGNORECASE,
    )),
    ("verification_framing_with_number", re.compile(
        r"\b(?:let'?s\s+check|checking\s+our\s+work|let'?s\s+verify|zur\s+kontrolle)\b"
        r"[^.\n]{0,60}[-+]?\d+(?:[.,]\d+)?\s*[a-zA-Z°%]{0,6}\b",
        re.IGNORECASE,
    )),
    ("official_solution_phrase", re.compile(
        r"\b(?:official\s+solution|musterl(?:ö|oe)sung|solution\s+key|answer\s+key)\b",
        re.IGNORECASE,
    )),
)


@dataclass(frozen=True)
class ReleaseValidationResult:
    allowed: bool
    reason: str
    matched_patterns: tuple[str, ...]


def _any_action_prohibits(policy: ExecutionPolicy, field: str) -> bool:
    return any(getattr(action.release, field) == "prohibited" for action in policy.actions)


def _action_prohibits_release(action: Action) -> bool:
    return action.release.final_answer == "prohibited" or action.release.official_solution == "prohibited"


def _scan_text(text: str, *, restricted: bool) -> ReleaseValidationResult:
    """Shared leak-pattern scan both the whole-response scan and the
    per-target scan delegate to, so the two never drift apart on what
    counts as a leak or what "no restriction applies" means."""
    if not restricted:
        return ReleaseValidationResult(allowed=True, reason="no_restriction", matched_patterns=())
    matched = tuple(name for name, pattern in _LEAK_PATTERNS if pattern.search(text or ""))
    if matched:
        return ReleaseValidationResult(allowed=False, reason="matched_leak_pattern", matched_patterns=matched)
    return ReleaseValidationResult(allowed=True, reason="no_match", matched_patterns=())


def scan_generated_answer_for_prohibited_release(
    text: str, *, policy: ExecutionPolicy | None,
) -> ReleaseValidationResult:
    """The one real check: does ``text`` look like it reveals a final
    result or official solution the compiled policy prohibits for ANY
    target? Conservative by construction — see module docstring for
    exactly what this does and does not detect."""
    if policy is None:
        return ReleaseValidationResult(allowed=True, reason="no_policy", matched_patterns=())
    restricted = _any_action_prohibits(policy, "final_answer") or _any_action_prohibits(policy, "official_solution")
    return _scan_text(text, restricted=restricted)


@dataclass(frozen=True)
class ReleaseDecision:
    text: str
    withheld: bool
    scan: ReleaseValidationResult


def enforce_release_policy(
    candidate_text: str, *, policy: ExecutionPolicy | None, response_language: str,
) -> ReleaseDecision:
    """The actual release gate a generation pipeline must call before ANY
    candidate answer text (the initial draft, a repair/rewrite output, or
    a buffered flush) reaches the student, is cached, or is persisted.

    Deliberately conservative, for the reason this module's own docstring
    explains at length: ``scan_generated_answer_for_prohibited_release``'s
    "no_match" is evidence of the ABSENCE of a KNOWN leak shape, never
    proof that a free-form answer is SAFE — a model can leak a prohibited
    final result in a phrasing this (or any finite) pattern list has never
    seen. So when ANY target's compiled policy prohibits final_answer or
    official_solution, this withholds the candidate text UNCONDITIONALLY
    and returns the same safe, honest fallback regardless of what the scan
    finds — fail-closed, not "fail open unless a known pattern matches".
    This is also deliberately whole-response, not per-target: this module
    cannot reliably attribute a span of free text to one specific target
    when a policy covers several (see the module docstring's "Missing
    target attribution" note), so a restriction on ANY target withholds
    the WHOLE candidate rather than risk leaking a different, unrestricted
    target's content mixed in with it.

    The scan result is still computed and returned (as ``.scan``) purely
    for observability/diagnostics (did a KNOWN leak shape additionally
    show up in the withheld draft) — it is NOT what this function's
    ``withheld`` decision is conditioned on.
    """
    scan = scan_generated_answer_for_prohibited_release(candidate_text, policy=policy)
    if scan.reason in ("no_policy", "no_restriction"):
        return ReleaseDecision(text=candidate_text, withheld=False, scan=scan)
    return ReleaseDecision(
        text=safe_withheld_answer_text(response_language=response_language),
        withheld=True,
        scan=scan,
    )


# ---------------------------------------------------------------------------
# Priority 2 — target-bound multi-section release (additive, parallel to
# the whole-response guard above, never a replacement of it). Central
# case: "give the full answer for 5a, but only a hint for 5b" — the
# whole-response guard above is correct-but-incomplete here: it would
# withhold 5a's permitted content too, just because 5b is restricted.
#
# The model is instructed (policy_prompt_rendering.render_target_
# sectioning_contract) to structure its ENTIRE reply as one ``[[TARGET:
# <label>]]`` ... ``[[END]]`` block per target. A model-written prose
# heading is NEVER trusted for attribution on its own (the task's own
# requirement) — only these literal, strictly-parsed markers are, and
# ONLY when parsing is unambiguous. Anything structurally invalid to
# verify — a missing/extra/duplicate section, stray text outside the
# markers, a target that doesn't match the compiled policy exactly —
# falls back to the EXISTING unconditional whole-response guard, never
# to a half-trusted partial parse.
# ---------------------------------------------------------------------------

_TARGET_MARKER_RE = re.compile(r"^\[\[TARGET:\s*(.+?)\s*\]\]\s*$", re.MULTILINE)
_END_MARKER_RE = re.compile(r"^\[\[END\]\]\s*$", re.MULTILINE)


def parse_target_sections(text: str, expected_targets: frozenset[str]) -> dict[str, str] | None:
    """Strictly parse ``text`` into ``{target: section_text}``, or return
    ``None`` the moment anything is structurally ambiguous: text before
    the first marker, a missing terminal ``[[END]]``, text after it, a
    duplicate target marker, or a section-id set that doesn't match
    ``expected_targets`` EXACTLY (no more, no less — never a partial or
    superset match). ``None`` here is the caller's signal to fall back
    to the whole-response guard."""
    markers = list(_TARGET_MARKER_RE.finditer(text or ""))
    if not markers:
        return None
    if (text[: markers[0].start()] or "").strip():
        return None  # unlabeled content before the first section
    end_match = _END_MARKER_RE.search(text)
    if end_match is None or end_match.start() < markers[-1].end():
        return None  # no terminator, or it precedes the last section's marker
    if (text[end_match.end():] or "").strip():
        return None  # unlabeled content after the terminator

    sections: dict[str, str] = {}
    for index, marker in enumerate(markers):
        label = marker.group(1).strip()
        if not label or label in sections:
            return None  # empty or duplicate target label
        section_end = markers[index + 1].start() if index + 1 < len(markers) else end_match.start()
        sections[label] = text[marker.end():section_end].strip()
    if frozenset(sections) != expected_targets:
        return None  # missing, extra, or mislabeled target(s)
    return sections


def _section_leaks_another_targets_result(
    section_text: str, *, own_target: str, policy: ExecutionPolicy,
) -> bool:
    """Heuristic safety net against the model putting a DIFFERENT,
    restricted target's result inside this (permitted) section under the
    wrong heading: true only if this section's text BOTH matches a known
    leak pattern AND explicitly names some other target that the policy
    actually restricts. Mere co-occurrence of a number is not enough —
    that would make ordinary permitted prose ("5a's answer is 42 N")
    unusable — this only fires when the restricted target's own label is
    named in a section that isn't its own, the concrete sign of a
    crossed-over or mislabeled answer."""
    other_restricted = {
        action.target for action in policy.actions
        if action.target != own_target and _action_prohibits_release(action)
    }
    if not other_restricted:
        return False
    if not any(pattern.search(section_text or "") for _name, pattern in _LEAK_PATTERNS):
        return False
    return any(
        re.search(rf"\b{re.escape(target)}\b", section_text or "", re.IGNORECASE)
        for target in other_restricted
    )


def _section_header(action: Action) -> str:
    if action.target in {"unresolved", "current_request", ""}:
        return ""
    return f"**{action.target}:**\n"


@dataclass(frozen=True)
class PerTargetSection:
    target: str
    text: str
    withheld: bool
    scan: ReleaseValidationResult


@dataclass(frozen=True)
class PerTargetReleaseDecision:
    text: str
    # True ONLY when the whole response was replaced by the safe
    # fallback (either the structural contract wasn't needed/parseable,
    # or parsing itself flagged an ambiguity) — exactly the existing
    # ``ReleaseDecision.withheld`` meaning, so every existing consumer
    # of that field keeps working unchanged. A per-target PARTIAL
    # withhold (some sections kept, one redacted) reports ``False`` here
    # — see ``sections`` for which target(s) were individually withheld.
    withheld: bool
    structural: bool
    scan: ReleaseValidationResult
    sections: tuple[PerTargetSection, ...]


def enforce_release_policy_per_target(
    candidate_text: str, *, policy: ExecutionPolicy | None, response_language: str,
) -> PerTargetReleaseDecision:
    """The target-bound extension of ``enforce_release_policy``: when the
    compiled policy genuinely needs per-target treatment (``policy_
    compiler.is_mixed_permission_policy``) AND the model's own text
    parses unambiguously into the required ``[[TARGET: ...]]`` sections
    (``parse_target_sections``), each target gets its OWN independent
    release decision — a prohibited target's section is replaced with
    the safe withheld text while a permitted target's section is kept
    verbatim, so one restricted exercise never blanks out an unrelated,
    permitted one.

    Falls straight through to the EXISTING ``enforce_release_policy``
    (whole-response, unconditional) for every other case: a single- or
    uniformly-permitted/prohibited target (nothing to split), a
    structurally invalid/ambiguous parse, or the cross-target leak
    heuristic firing — never a half-trusted partial result."""
    if not is_mixed_permission_policy(policy):
        decision = enforce_release_policy(candidate_text, policy=policy, response_language=response_language)
        return PerTargetReleaseDecision(
            text=decision.text, withheld=decision.withheld, structural=False,
            scan=decision.scan, sections=(),
        )
    assert policy is not None  # is_mixed_permission_policy already guards this

    expected = frozenset(action.target for action in policy.actions)
    sections = parse_target_sections(candidate_text, expected)
    if sections is None:
        decision = enforce_release_policy(candidate_text, policy=policy, response_language=response_language)
        return PerTargetReleaseDecision(
            text=decision.text, withheld=decision.withheld, structural=False,
            scan=decision.scan, sections=(),
        )

    rendered: list[str] = []
    per_target: list[PerTargetSection] = []
    any_withheld = False
    for action in policy.actions:
        section_text = sections[action.target]
        if _section_leaks_another_targets_result(section_text, own_target=action.target, policy=policy):
            # Ambiguous crossover between sections — never trust a
            # partial split here, fall back whole.
            decision = enforce_release_policy(candidate_text, policy=policy, response_language=response_language)
            return PerTargetReleaseDecision(
                text=decision.text, withheld=decision.withheld, structural=False,
                scan=decision.scan, sections=(),
            )
        restricted = _action_prohibits_release(action)
        scan = _scan_text(section_text, restricted=restricted)
        # Same fail-closed philosophy as enforce_release_policy above,
        # scoped to this one target: a restricted section is withheld
        # UNCONDITIONALLY, never only when a known leak pattern happens
        # to match -- "no_match" is evidence of absence, not proof of a
        # safe answer (see the whole-response guard's own docstring).
        # The scan is still attached for observability only.
        if restricted:
            any_withheld = True
            final_text = safe_withheld_answer_text(response_language=response_language)
            per_target.append(PerTargetSection(target=action.target, text=final_text, withheld=True, scan=scan))
            rendered.append(_section_header(action) + final_text)
            continue
        per_target.append(PerTargetSection(target=action.target, text=section_text, withheld=False, scan=scan))
        rendered.append(_section_header(action) + section_text)

    aggregate_scan = ReleaseValidationResult(
        allowed=not any_withheld,
        reason="structural_partial_withheld" if any_withheld else "structural_clean_release",
        matched_patterns=tuple(sorted({
            name for section in per_target for name in section.scan.matched_patterns
        })),
    )
    return PerTargetReleaseDecision(
        text="\n\n".join(rendered), withheld=False, structural=True,
        scan=aggregate_scan, sections=tuple(per_target),
    )


def safe_withheld_answer_text(*, response_language: str) -> str:
    """What the student sees instead, when the scan withholds a response.
    Honest about WHY (their own request), never a generic error — this is
    an expected, requested state, not a failure."""
    if (response_language or "").lower().startswith("de"):
        return (
            "Ich halte das Endergebnis hier zurück, da du das für diese Aufgabe "
            "ausdrücklich so gewünscht hast. Sag mir, wenn du bereit für die "
            "Lösung bist oder stattdessen einen Hinweis möchtest."
        )
    return (
        "I'm withholding the final result here, since that's what you asked for "
        "this exercise. Let me know when you'd like the solution, or if a hint "
        "would help instead."
    )


__all__ = [
    "PerTargetReleaseDecision",
    "PerTargetSection",
    "ReleaseDecision",
    "ReleaseValidationResult",
    "enforce_release_policy",
    "enforce_release_policy_per_target",
    "parse_target_sections",
    "safe_withheld_answer_text",
    "scan_generated_answer_for_prohibited_release",
]
