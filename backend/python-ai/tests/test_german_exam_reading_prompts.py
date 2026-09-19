"""Pins the Lesen prompt text's immutable-structure and per-item skillTag
differentiation instructions (same rationale as
test_german_exam_listening_prompts.py — an offline, fast regression guard
for prompt wording that can't be asserted by running the real LLM)."""

from __future__ import annotations

from app.services.german_exam_reading import _prompt_lesen1, _prompt_lesen2, _prompt_lesen3
from app.services.german_exam_profiles import get_part, get_profile

PROFILE = get_profile("telc_c1_hochschule")
TOPIC = {"topicId": "t", "label": "Test topic"}


def test_lesen1_prompt_states_structure_and_tag_differentiation() -> None:
    part = get_part("telc_c1_hochschule", "reading", "lesen_1")
    system, _ = _prompt_lesen1(PROFILE, part, [], TOPIC)
    assert "exactly 6 gaps" in system
    assert "exactly 8" in system
    assert "do not copy one tag for every item" in system


def test_lesen2_prompt_states_structure_and_allows_repeated_sections() -> None:
    part = get_part("telc_c1_hochschule", "reading", "lesen_2")
    system, _ = _prompt_lesen2(PROFILE, part, [], TOPIC)
    assert "exactly 5" in system
    assert "exactly 6 statements" in system
    assert "MAY legitimately be the correct match for more than one" in system
    assert "do not copy one tag for every item" in system


def test_lesen3_prompt_states_tristate_semantics_and_heading_rule() -> None:
    part = get_part("telc_c1_hochschule", "reading", "lesen_3")
    system, _ = _prompt_lesen3(PROFILE, part, [], TOPIC)
    assert "richtig" in system and "falsch" in system and "nicht_im_text" in system
    assert "not proven false" in system
    assert "exactly ONE additional item" in system
    assert "do not copy one tag for every item" in system
