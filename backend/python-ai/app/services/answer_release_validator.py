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

Priority 2, REVISED after further review: ``enforce_release_policy_
per_target`` (below) used to take a "clean split" path for a genuinely
mixed-permission policy — trusting the model's own ``[[TARGET: ...]]``
markers for WHERE a target's text sits, plus a regex heuristic
(``_section_leaks_another_targets_result``, now removed) as supposed
evidence that a permitted section didn't contain a different, restricted
target's result. Both trust assumptions were wrong: a section marker is
a structural fact about where text sits, never independent evidence
about what the text is ABOUT, and a negative/clean regex scan is
evidence of the ABSENCE of a KNOWN leak shape, never proof a section is
safe. ``test_maximally_evasive_smuggling_with_no_cross_reference_or_
label_is_not_caught`` proved a smuggled restricted result with no
connecting language and no label mention survives that heuristic
untouched — and nothing about plain-text section splitting can close
that gap, since there is no independent signal left to check once both
assumptions are rejected.

Consequently, the permissive partial-release path is DISABLED.
``enforce_release_policy_per_target`` now always delegates to
``enforce_release_policy`` (the unconditional whole-response fail-closed
guard) for every policy, mixed-permission or not. ``parse_target_
sections`` is kept only as an independently-tested, honestly-scoped
structural parser (it verifies marker well-formedness, nothing about
content) — it is no longer wired into any release decision. Genuinely
safe per-target release, if ever pursued, would need server-controlled
per-target generation (each target's content independently scoped/
requested, never self-reported by one model call) rather than more
regex heuristics over free text; that is not implemented here.

Hint-suppression fix (single-target scan-conditioned release): a
DIFFERENT case than the mixed-permission one above, in kind, not just in
degree. When the compiled ``ExecutionPolicy`` has exactly one distinct
target — e.g. "give me a hint for 5b, but don't reveal the final
answer" compiles to one ``Action`` (target "5b", ``final_answer=
"prohibited"``) — there is no cross-target attribution problem at all:
every byte of ``candidate_text`` is about that one target, because the
generation itself was constrained (via ``policy_prompt_rendering.py``'s
Phase C overlay) to answer only for it. The residual question is
narrower than "which target does this text belong to" — it is "did the
model, despite being told hint-only, slip and reveal the prohibited
result anyway", which is exactly the shape ``_LEAK_PATTERNS`` was built
to catch. ``enforce_release_policy_single_target`` (below) is scan-
conditioned for exactly this case: release when the scan finds no known
leak shape, withhold only when it matches one. It must NEVER be called
for a policy with two or more distinct targets — callers (currently
only ``app/routers/stream.py``) decide single- vs multi-target by
counting distinct ``action.target`` values and route to this function
or to ``enforce_release_policy_per_target`` accordingly; the unconditional
multi-target guard above is untouched.

Residual risk, stated plainly: a sufficiently novel, disguised final-
answer phrasing in a single-target hint can still slip past this finite
pattern list undetected. That gap is real and this function does not
close it — it is the same class of risk this project already accepts
elsewhere (trusting the model to generally follow a prompt instruction;
``policy_prompt_rendering.py``'s own docstring already names enforcement-
by-instruction as its only mechanism). A stronger backstop (e.g.
comparing the hint against a grounded/verified correct value) would be a
separate, bigger piece of work, not implemented here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .policy_compiler import ExecutionPolicy

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
    # Added for the single-target hint-suppression fix: "Therefore F = 42
    # N." (or its German equivalents) is an extremely common, plain final-
    # result phrasing — not an exotic adversarial case — that none of the
    # patterns above catch. It had been masked for single-target policies
    # only because enforce_release_policy withheld unconditionally there
    # too; now that single-target release is scan-conditioned, this shape
    # must be caught explicitly instead of relying on the unconditional
    # fallback that used to paper over it.
    ("concluding_symbol_equals_number", re.compile(
        r"\b(?:therefore|thus|hence|so|damit|also|somit|folglich)\b"
        r"[^.\n]{0,40}\b[A-Za-zΑ-Ωα-ω][A-Za-z0-9_]{0,3}\s*=\s*"
        r"[-+]?\d+(?:[.,]\d+)?\s*[a-zA-Z°%]{0,6}\b",
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
# Priority 2 — ``parse_target_sections`` is a pure, strict structural
# parser for the model's ``[[TARGET: <label>]]`` ... ``[[END]]`` markers
# (``policy_prompt_rendering.render_target_sectioning_contract`` still
# renders the prompt instruction for them). It verifies ONLY where text
# sits — a missing/extra/duplicate section, stray text outside the
# markers, or a target set that doesn't match the compiled policy EXACTLY
# all return ``None`` rather than a partial/best-effort parse. It is NOT
# wired into any release decision below (see the module docstring's
# "REVISED after further review" note) — a clean parse is not, and never
# was, proof that a section's CONTENT belongs to that target.
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


@dataclass(frozen=True)
class PerTargetSection:
    target: str
    text: str
    withheld: bool
    scan: ReleaseValidationResult


@dataclass(frozen=True)
class PerTargetReleaseDecision:
    text: str
    withheld: bool
    # Both ``structural`` and ``sections`` are permanently ``False``/``()``
    # now that the permissive partial-release path is disabled (see the
    # module docstring's "REVISED after further review" note) -- kept on
    # the dataclass only so existing callers (``app/routers/stream.py``'s
    # SSE event fields) and tests don't need to change shape.
    structural: bool
    scan: ReleaseValidationResult
    sections: tuple[PerTargetSection, ...]


def enforce_release_policy_per_target(
    candidate_text: str, *, policy: ExecutionPolicy | None, response_language: str,
) -> PerTargetReleaseDecision:
    """DISABLED permissive path -- see the module docstring's "REVISED
    after further review" note for why. This now always delegates to
    ``enforce_release_policy`` (the unconditional whole-response
    fail-closed guard), for every policy shape, mixed-permission or not.
    No path through this function ever trusts a ``[[TARGET: ...]]``
    marker, or a clean/negative regex scan, as proof that a section's
    content actually belongs to -- or is free of another target's
    restricted result. If independently verifiable per-target isolation
    is ever built (server-controlled per-target generation, not
    model-self-reported section markers), it belongs here; until then,
    this function is a thin, deliberately inert wrapper."""
    decision = enforce_release_policy(candidate_text, policy=policy, response_language=response_language)
    return PerTargetReleaseDecision(
        text=decision.text, withheld=decision.withheld, structural=False,
        scan=decision.scan, sections=(),
    )


def enforce_release_policy_single_target(
    candidate_text: str, *, policy: ExecutionPolicy | None, response_language: str,
) -> PerTargetReleaseDecision:
    """Scan-conditioned release gate for the genuinely single-target case
    — see the module docstring's "Hint-suppression fix" section for why
    this is safe here but NOT for a multi-target policy (never call this
    for one; use ``enforce_release_policy_per_target`` instead).

    Releases ``candidate_text`` unmodified when the leak-pattern scan
    finds nothing (``no_policy``/``no_restriction``/``no_match``);
    withholds it, exactly like ``enforce_release_policy``, only when the
    scan actually matches a known leak shape (``matched_leak_pattern``).
    This is the one real behavioral difference from ``enforce_release_
    policy`` — that function ignores the scan result for its withhold
    decision by design (see its own docstring); this one is conditioned
    on it by design, because there is only one target in play here.
    """
    scan = scan_generated_answer_for_prohibited_release(candidate_text, policy=policy)
    if scan.reason == "matched_leak_pattern":
        return PerTargetReleaseDecision(
            text=safe_withheld_answer_text(response_language=response_language),
            withheld=True, structural=False, scan=scan, sections=(),
        )
    return PerTargetReleaseDecision(
        text=candidate_text, withheld=False, structural=False, scan=scan, sections=(),
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
    "enforce_release_policy_single_target",
    "parse_target_sections",
    "safe_withheld_answer_text",
    "scan_generated_answer_for_prohibited_release",
]
