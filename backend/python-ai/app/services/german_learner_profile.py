"""Server-side German learner profile — the AI's single source of truth.

``profiles.german_test`` + ``profiles.german_level`` are canonical (onboarding
creates them, the Profile page edits them). Every German-aware AI path reads
them HERE, keyed by the JWT-verified ``user_id`` — never from a client-supplied
level, which may be stale (old tab, cached B2) or simply wrong.

Deliberately NOT cached: a Profile edit must take effect on the very next AI
request, and this is one primary-key lookup on a tiny row.

The saved ``german_exam_profile_id`` is authoritative. Legacy family/level
resolution is used only when no saved id exists. Unknown saved ids fail closed.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from ..supabase_client import get_supabase
from .german_exams import resolve_profile_id, GERMAN_EXAM_PROFILES

log = logging.getLogger(__name__)

# Exact target levels per test family — mirrors GERMAN_TEST_LEVELS in
# frontend/js/features/auth/german-profile.ts (a test keeps the two in sync).
GERMAN_TEST_LEVELS: dict[str, tuple[str, ...]] = {
    "TestDaF": ("TDN 3", "TDN 4", "TDN 5"),
    "DSH": ("DSH-1", "DSH-2", "DSH-3"),
    "Goethe": ("B1", "B2", "C1", "C2"),
    "telc": ("B2", "C1", "C1 Hochschule", "C2"),
    "OESD": ("B2", "C1", "C2"),
    "DSD": ("DSD I (B1/B2)", "DSD II (C1)"),
}

# Every level string a learner can legitimately have on their profile, plus the
# plain CEFR steps used for explicit session overrides.
ALL_PROFILE_LEVELS: frozenset[str] = frozenset(
    {lvl for levels in GERMAN_TEST_LEVELS.values() for lvl in levels}
    | {"A1", "A2", "B1", "B2", "C1", "C2"}
)


@dataclass(frozen=True)
class GermanLearnerProfile:
    user_type: str
    test_family: str
    target_level: str
    exam_profile_id: str | None

    @property
    def is_learner(self) -> bool:
        return self.user_type == "learner"

    @property
    def has_target(self) -> bool:
        return self.is_learner and bool(self.target_level)


def get_german_learner_profile(user_id: str) -> GermanLearnerProfile | None:
    """The authenticated user's profile, or ``None`` when it cannot be read.

    ``None`` means "unknown" — callers must degrade to no profile block, never
    invent a level. A non-learner account returns a profile with
    ``is_learner == False``.
    """
    if not user_id:
        return None
    try:
        res = (
            get_supabase()
            .table("profiles")
            .select("user_type, german_test, german_level, german_exam_profile_id")
            .eq("id", user_id)
            .limit(1)
            .execute()
        )
    except Exception:
        log.exception("german learner profile lookup failed (non-fatal)")
        return None
    rows = res.data or []
    if not rows:
        return None
    row = rows[0]
    test = str(row.get("german_test") or "").strip()
    level = str(row.get("german_level") or "").strip()
    saved_id = str(row.get("german_exam_profile_id") or "").strip()
    resolved_id = (saved_id if saved_id in GERMAN_EXAM_PROFILES else None) if saved_id else resolve_profile_id(test, level)
    return GermanLearnerProfile(
        user_type=str(row.get("user_type") or "").strip() or "enrolled",
        test_family=test,
        target_level=level,
        exam_profile_id=resolved_id,
    )


def format_learner_profile_block(profile: GermanLearnerProfile | None) -> str:
    """Prompt block for a learner with a saved target; "" otherwise (enrolled
    students, unknown profile, learner mid-onboarding)."""
    if profile is None or not profile.has_target:
        return ""
    lines = [
        "",
        "",
        "GERMAN LEARNER PROFILE (server-verified, from the student's saved profile)",
    ]
    if profile.test_family:
        lines.append(f"- Test family: {profile.test_family}")
    lines.append(f"- Target level: {profile.target_level}")
    if profile.exam_profile_id:
        lines.append(f"- Canonical exam profile: {profile.exam_profile_id}")
    lines += [
        "- Adapt explanations, vocabulary, grammar complexity, examples and "
        "feedback to this target level.",
        "- Do not claim a different level for this learner unless you are "
        "explicitly evaluating their performance.",
    ]
    return "\n".join(lines)


def learner_profile_fingerprint(profile: GermanLearnerProfile | None) -> str:
    """Stable string for answer-cache keys, so a cached answer written for
    B2 is never replayed after the learner switches to C1 Hochschule."""
    if profile is None or not profile.has_target:
        return ""
    return f"{profile.test_family}|{profile.target_level}|{profile.exam_profile_id or chr(45)}"
