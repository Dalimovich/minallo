"""Unknown skill tags must be rejected, never silently dropped."""

from __future__ import annotations

import pytest

from app.services.german_exam_skill_tags import UnknownSkillTagError, validate_tags


def test_known_listening_tags_pass() -> None:
    validate_tags("listening", ["paraphrase_mapping", "speaker_matching"])


def test_unknown_tag_raises() -> None:
    with pytest.raises(UnknownSkillTagError):
        validate_tags("listening", ["paraphrase_mapping", "made_up_tag"])


def test_tag_from_wrong_module_is_rejected() -> None:
    # "fluency" is a speaking tag, not a listening tag.
    with pytest.raises(UnknownSkillTagError):
        validate_tags("listening", ["fluency"])


def test_writing_tags_are_separate_vocabulary() -> None:
    validate_tags("writing", ["task_fulfilment", "coherence"])
    with pytest.raises(UnknownSkillTagError):
        validate_tags("writing", ["speaker_matching"])
