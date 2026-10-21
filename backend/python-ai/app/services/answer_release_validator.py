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

from .policy_compiler import ExecutionPolicy, GENERIC_TARGET_PLACEHOLDERS

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
    # Confirmed disguised-leak shape (independent A/B eval, AB-02/AB-03
    # forensic pass, 2026-10-20): a markdown heading literally named
    # "Results"/"Answer"/"Solution" (or German equivalent) followed
    # within a couple of lines by a bullet-point variable assignment —
    # "### Results\n- R_A = 75 N\n- R_B = 25 N" — carries none of the
    # prose cues (no "the answer is", no "therefore") the patterns
    # above look for, and was confirmed to pass this scan completely
    # uncaught. Requires BOTH the result-shaped heading AND a bulleted
    # "<name> = <number>" assignment together, deliberately narrower
    # than a bare "bullet + number" match — an innocent bullet list of
    # a problem's GIVEN values (e.g. "- m = 10 kg\n- g = 9.81 m/s^2")
    # under an unrelated or no heading must not trip this.
    ("markdown_heading_bullet_result", re.compile(
        r"^#{1,6}\s*(?:results?|answers?|solutions?|ergebnis(?:se)?|"
        r"l(?:ö|oe)sung(?:en)?|antwort(?:en)?)\b[^\n]*\n(?:[^\n]*\n){0,2}?"
        r"\s*[-*]\s*[A-Za-zΑ-Ωα-ω][A-Za-z0-9_]{0,6}\s*=\s*"
        r"[-+]?\d+(?:[.,]\d+)?\s*[a-zA-Z°%]{0,6}\b",
        re.IGNORECASE | re.MULTILINE,
    )),
)


# ---------------------------------------------------------------------------
# Value-grounded detection (2026-10-20 comprehensive remediation, confirmed
# via live-model forensic evidence): ALL THREE real disclosures in the
# 2026-10-20 five-scenario live evaluation (AB-24, AB-03, and the 3-turn
# quiz scenario) stated the protected result as an ordinary concluding
# sentence or a LaTeX expression with no trigger word any _LEAK_PATTERNS
# entry looks for ("The support force at A is R_A = 75 N.", a LaTeX
# \approx block). A narrower pattern targeting those exact shapes was
# tried and rejected here, directly: a bare "symbol ≈ number" pattern
# (no trigger word) was confirmed, by direct test, to false-positive on
# ordinary physical-constant restatements ("g ≈ 9.81 m/s^2", "π ≈
# 3.14159") that are completely unrelated to any protected result —
# exactly the over-restriction failure mode this project has already
# had to fix once this session (the official_solution/final_answer
# conflation bug). More sentence-shape regexes keep finding new false
# positives or false negatives because natural language has no fixed
# shape for stating a result.
#
# This is why a SECOND, independent, value-grounded signal is added
# instead: when the retrieved course evidence for the active exercise(s)
# contains its own stated solution (common in a worked-example/exercise-
# sheet corpus — confirmed present in this project's own test fixtures,
# "Lösung: R_A = 75 N, ..."), extract the actual PROTECTED NUMBER(S) from
# that solution text specifically (never from the problem statement/
# givens portion) and check whether the SAME number appears anywhere in
# the generated text. This catches a disclosure regardless of its
# sentence shape, because it is keyed on the actual protected VALUE, not
# a phrasing pattern.
#
# Explicitly documented limitations (do not overclaim -- this is an
# additive signal, not a solved problem):
# - Only usable when the evidence passed in actually contains a labeled
#   solution/answer segment -- NOT available for every real request
#   (many retrieved chunks are problem statements only, with no stored
#   answer key at all; this is additive, never a replacement for the
#   pattern scan).
# - Real answer-key text is NOT structurally uniform even within this
#   project's own fixtures: some state the result BEFORE a parenthetical
#   derivation ("R_A = 75 N, R_B = 25 N (ΣM_A: ...)"), some as one
#   chained equation ("F = m*g*sin(30°) = 10*9.81*0.5 = 49.05 N"), some
#   using "≈"/"ca." rather than "=". Attempting to parse out exactly
#   "the final result, never a given or intermediate step" from this
#   variety was tried here and abandoned as its own endless-special-
#   casing trap (the same failure mode this task explicitly warns
#   against for leak PATTERNS, just relocated to value EXTRACTION
#   instead) -- so this extracts every sufficiently-specific number
#   (2+ digits, or any decimal) from the WHOLE labeled solution segment,
#   including the derivation. A given or intermediate value restated
#   within that same labeled segment (e.g. "30" in "sin(30°)") CAN be
#   mistaken for a protected value and cause a false withhold on an
#   unrelated, legitimate hint that happens to mention the same number.
#   This is a real, accepted, documented trade-off, not an oversight.
# - A model restating the value in a different unit or equivalent form
#   (75 N vs 0.075 kN) is NOT caught, since the comparison is on the
#   literal numeric token, not a unit-aware equivalence.
#
# Cross-chunk bleed (2026-10-21 production incident, confirmed via live
# request data): the only other stop condition was "[" or end of string
# -- with no "[" anywhere (real retrieved evidence rarely uses that
# convention), a single "Lösung:"/"Solution:" label swept in every
# chunk joined after it, including entirely UNRELATED exercises'
# numbers. A blank line (a chunk boundary -- app/routers/stream.py
# joins retrieved chunks with "\n\n" specifically so this always lines
# up) now also stops the match, so a short answer-key segment inside
# one chunk can no longer absorb whatever text happens to follow it
# from a different chunk. A genuine multi-line solution with no blank
# line inside the SAME chunk is unaffected.
# ---------------------------------------------------------------------------

_SOLUTION_LABEL_RE = re.compile(
    r"(?:l(?:ö|oe)sung|antwort|solution|answer)\s*:\s*(.+?)(?=\[|\n[ \t]*\n|\Z)",
    re.IGNORECASE | re.DOTALL,
)
_NUMERIC_TOKEN_RE = re.compile(r"[-+]?\d+(?:[.,]\d+)?")
# A lone single digit (0-9, e.g. a count or a step number) is excluded --
# far too likely to coincidentally co-occur in any response -- but a
# 2-digit value or anything with a decimal point is kept; see the
# documented limitation above for exactly what that trades away.
_MIN_BARE_INT_DIGITS = 2


def extract_protected_values_from_evidence(evidence_text: str) -> frozenset[str]:
    """Extract candidate protected numeric values from any solution/
    answer-labeled segment of retrieved evidence text -- never from the
    problem-statement/givens portion. Returns normalized numeric strings
    (comma decimals folded to periods)."""
    values: set[str] = set()
    for m in _SOLUTION_LABEL_RE.finditer(evidence_text or ""):
        segment = m.group(1)
        for nm in _NUMERIC_TOKEN_RE.finditer(segment):
            token = nm.group(0)
            normalized = token.replace(",", ".")
            has_decimal = "." in normalized
            digits = normalized.lstrip("+-").replace(".", "")
            if has_decimal or len(digits) >= _MIN_BARE_INT_DIGITS:
                values.add(normalized)
    return frozenset(values)


def _text_matches_protected_value(text: str, protected_values: frozenset[str]) -> str | None:
    if not protected_values:
        return None
    for m in _NUMERIC_TOKEN_RE.finditer(text or ""):
        normalized = m.group(0).replace(",", ".")
        if normalized in protected_values:
            return normalized
    return None


@dataclass(frozen=True)
class ReleaseValidationResult:
    allowed: bool
    reason: str
    matched_patterns: tuple[str, ...]


def _any_action_prohibits(policy: ExecutionPolicy, field: str) -> bool:
    return any(getattr(action.release, field) == "prohibited" for action in policy.actions)


# Confirmed defect (semantic-intent stabilization, 2026-10-20): every
# pattern above used to share ONE combined `restricted` flag
# (final_answer prohibited OR official_solution prohibited). compile_
# policy's own tutoring default closes official_solution for virtually
# every compiled action (it "defaults closed and must be explicitly
# requested" -- see policy_compiler.py's _TUTORING_DEFAULT comment), so
# that one flag was almost always True even for a policy that
# explicitly PERMITS final_answer -- which meant the final-answer-
# shaped patterns below (an ordinary, correct "the final answer is
# 75 N" in a legitimately permitted full-solution response) still
# matched and the whole response was wrongly withheld. Confirmed via
# direct instrumentation: a real compile_policy output for
# objective="solve" with final_answer="permitted" (the Stage-5
# acceptance-case-E shape, "solve this completely") carries
# official_solution="prohibited" by that same ordinary default, which
# alone used to be enough to trigger "final_answer_phrase" on an
# entirely permitted answer.
_OFFICIAL_SOLUTION_PATTERN_NAMES = frozenset({"official_solution_phrase"})

# Quiz-vs-release-gate fix (2026-10-20 correction pass): app/routers/
# stream.py's outer release gate buffers and scans the FULL rendered
# text whenever the compiled policy restricts final_answer/
# official_solution for any target -- uniformly, with no awareness of
# WHICH internal lane (quiz, exam, ordinary answer) produced it. A quiz
# target correctly compiling final_answer="prohibited" (this session's
# fix) now means every inline quiz response goes through this scan too.
# But a ```minallo-quiz fenced block's "explanation" fields routinely,
# LEGITIMATELY restate the correct option as justification -- that is
# the answer key the frontend already keeps hidden until the student
# answers, not a prose leak. Scanning that text would risk withholding
# an entirely correct quiz. "```minallo-quiz" is Minallo's own reserved
# fence tag (per QUIZ_CONTRACT); no other answer type has a legitimate
# reason to emit it, so stripping it before the scan is safe regardless
# of request type, with no new cross-layer wiring needed.
_INLINE_QUIZ_FENCE_RE = re.compile(r"```minallo-quiz.*?```", re.DOTALL)


def _strip_inline_quiz_blocks(text: str) -> str:
    return _INLINE_QUIZ_FENCE_RE.sub("", text or "")


def _scan_text(
    text: str, *, final_answer_restricted: bool, official_solution_restricted: bool,
    evidence_text: str | None = None, value_grounded_check_applies: bool | None = None,
) -> ReleaseValidationResult:
    """Shared leak-pattern scan both the whole-response scan and the
    per-target scan delegate to, so the two never drift apart on what
    counts as a leak or what "no restriction applies" means. Each
    pattern is checked against the restriction it actually detects --
    "official_solution_phrase" (official/answer-key wording) against
    official_solution_restricted, every other pattern (final numeric
    result shapes) against final_answer_restricted -- never one
    combined flag, so a policy permitting final_answer but still
    closing official_solution (the ordinary tutoring default) does not
    withhold a correctly-permitted final answer just because it
    contains a final-answer-shaped phrase.

    ``evidence_text``, when supplied, adds the second, independent,
    value-grounded signal (see the module's own section docstring above
    _SOLUTION_LABEL_RE). ``value_grounded_check_applies`` gates it --
    defaults to ``final_answer_restricted`` (the original behavior:
    checked only when final_answer is explicitly prohibited) but the
    caller may widen it independently of the blunt regex patterns above
    (see scan_generated_answer_for_prohibited_release's own "unnumbered
    exercise" extension) -- this value-grounded signal alone is safe to
    widen because it only ever matches evidence that already contains a
    labeled solution/answer value; ordinary prose with no such label
    never has anything for it to match."""
    if value_grounded_check_applies is None:
        value_grounded_check_applies = final_answer_restricted
    if not final_answer_restricted and not official_solution_restricted and not value_grounded_check_applies:
        return ReleaseValidationResult(allowed=True, reason="no_restriction", matched_patterns=())
    scan_text = _strip_inline_quiz_blocks(text)
    matched = tuple(
        name for name, pattern in _LEAK_PATTERNS
        if (
            official_solution_restricted if name in _OFFICIAL_SOLUTION_PATTERN_NAMES
            else final_answer_restricted
        )
        and pattern.search(scan_text)
    )
    if value_grounded_check_applies and evidence_text:
        protected_values = extract_protected_values_from_evidence(evidence_text)
        if _text_matches_protected_value(scan_text, protected_values):
            matched = matched + ("protected_value_match",)
    if matched:
        return ReleaseValidationResult(allowed=False, reason="matched_leak_pattern", matched_patterns=matched)
    return ReleaseValidationResult(allowed=True, reason="no_match", matched_patterns=())


def _has_unverified_explain_disclosure(policy: ExecutionPolicy) -> bool:
    """Unnumbered-exercise explanation gap (2026-10-21 follow-up): an
    "explain" request whose target never resolved to a real exercise
    label — ``diagnostic_policy.py``'s own generic "current_request"
    placeholder — compiles ``final_answer="permitted"`` by the ordinary
    tutoring default (see policy_compiler.py's own ``is_explain_
    objective`` docstring: that fallback deliberately does NOT close
    final_answer for a generic/no-exercise target, specifically so an
    ordinary document explanation is never wrongly restricted). But the
    SAME generic target also covers a genuine exercise that simply has
    no printed number — there is no document/chunk-type signal
    available at policy-compilation time to tell the two apart (see
    this function's caller for why the fix lives here, evidence-
    grounded, instead of there). This flags that specific, narrow
    combination so the value-grounded backstop below still runs for it
    — safe to widen precisely because that backstop only ever matches
    evidence that already contains a labeled solution/answer value;
    ordinary prose never does.

    Known, accepted, narrow residual gap: an action that explicitly
    (via a successful semantic escalation) sets final_answer="permitted"
    for an "explain" objective on this same generic target — a student
    asking to both explain AND reveal the result in one escalation-
    triggering message — is indistinguishable from the defaulted case
    here and would also re-run this backstop. This is the same class of
    residual risk this module's own docstring already names elsewhere
    (a disguised phrasing slipping past a finite pattern list); closing
    it for real needs per-field provenance plumbed through ExecutionPolicy,
    out of scope for this targeted fix."""
    return any(
        action.objective == "explain"
        and action.target in GENERIC_TARGET_PLACEHOLDERS
        and action.release.final_answer != "prohibited"
        for action in policy.actions
    )


def scan_generated_answer_for_prohibited_release(
    text: str, *, policy: ExecutionPolicy | None, evidence_text: str | None = None,
) -> ReleaseValidationResult:
    """The one real check: does ``text`` look like it reveals a final
    result or official solution the compiled policy prohibits for ANY
    target? Conservative by construction — see module docstring for
    exactly what this does and does not detect. ``evidence_text`` is the
    optional retrieved course evidence for the active exercise(s) --
    when it contains a labeled solution/answer segment, its protected
    numeric value(s) are checked against the text directly (see the
    value-grounded detection section above)."""
    if policy is None:
        return ReleaseValidationResult(allowed=True, reason="no_policy", matched_patterns=())
    final_answer_restricted = _any_action_prohibits(policy, "final_answer")
    return _scan_text(
        text,
        final_answer_restricted=final_answer_restricted,
        official_solution_restricted=_any_action_prohibits(policy, "official_solution"),
        evidence_text=evidence_text,
        value_grounded_check_applies=(
            final_answer_restricted or _has_unverified_explain_disclosure(policy)
        ),
    )


@dataclass(frozen=True)
class ReleaseDecision:
    text: str
    withheld: bool
    scan: ReleaseValidationResult


def enforce_release_policy(
    candidate_text: str, *, policy: ExecutionPolicy | None, response_language: str,
    evidence_text: str | None = None,
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
    scan = scan_generated_answer_for_prohibited_release(
        candidate_text, policy=policy, evidence_text=evidence_text,
    )
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
    evidence_text: str | None = None,
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
    decision = enforce_release_policy(
        candidate_text, policy=policy, response_language=response_language, evidence_text=evidence_text,
    )
    return PerTargetReleaseDecision(
        text=decision.text, withheld=decision.withheld, structural=False,
        scan=decision.scan, sections=(),
    )


def enforce_release_policy_single_target(
    candidate_text: str, *, policy: ExecutionPolicy | None, response_language: str,
    evidence_text: str | None = None,
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
    scan = scan_generated_answer_for_prohibited_release(
        candidate_text, policy=policy, evidence_text=evidence_text,
    )
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
    "extract_protected_values_from_evidence",
    "parse_target_sections",
    "safe_withheld_answer_text",
    "scan_generated_answer_for_prohibited_release",
]
