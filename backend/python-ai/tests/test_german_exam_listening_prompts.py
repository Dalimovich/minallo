"""Regression guards for the content-quality prompt fixes found during live
verification (real OpenAI, real Supabase) against telc_c1_hochschule:

- HV1/HV3 originally tagged every generated item with the SAME single
  skillTag (the prompt's JSON example showed one literal tag and the model
  just copied it), which would have silently broken the weakness engine's
  ability to distinguish sub-skills.
- HV3 lectures were sometimes short enough that the model padded the 10
  note-completion fields with near-duplicate restatements of the same 2-3
  points instead of expanding the lecture with genuinely new content.

These can't be asserted by running the real LLM in a unit test (non-
deterministic, costs money, network-dependent) — this file instead pins the
PROMPT TEXT itself, so an edit that accidentally drops the differentiation/
anti-padding instructions fails a fast, offline test rather than being
caught only the next time someone reads live output by hand."""

from __future__ import annotations

from app.services.german_exam_listening import _prompt_hv1, _prompt_hv2, _prompt_hv3
from app.services.german_exam_profiles import get_part, get_profile

PROFILE = get_profile("telc_c1_hochschule")
TOPIC = {"topicId": "t", "label": "Test topic"}


def test_hv1_prompt_requires_per_item_tag_differentiation() -> None:
    part = get_part("telc_c1_hochschule", "listening", "hv1")
    system, _ = _prompt_hv1(PROFILE, part, [], TOPIC)
    assert "do not copy one tag for every item" in system
    assert "at least 3 different tags" in system


def test_hv2_prompt_requires_per_item_tag_differentiation_and_rejects_absurd_distractors() -> None:
    part = get_part("telc_c1_hochschule", "listening", "hv2")
    system, _ = _prompt_hv2(PROFILE, part, [], TOPIC)
    assert "do not copy one tag for every item" in system
    assert "at least 3 different tags" in system
    assert "absurd" in system  # guards against the live-observed "abolish all intersections" style distractor


def test_hv3_prompt_requires_tag_differentiation_and_forbids_padding() -> None:
    part = get_part("telc_c1_hochschule", "listening", "hv3")
    system, _ = _prompt_hv3(PROFILE, part, [], TOPIC)
    assert "do not copy one tag for every item" in system
    assert "at least 3 different tags" in system
    # Anti-padding / anti-near-duplicate instruction, from the live finding
    # that a short lecture got stretched across 10 fields via redundant
    # restatements of the same 2-3 points.
    assert "genuinely DISTINCT pieces of information" in system
    assert "near-paraphrases of each other" in system
