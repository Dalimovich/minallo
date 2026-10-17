"""Shared German Exam Engine — controlled skill-tag vocabulary, per module.

The AI must never invent skill tags. Every generated question's `skillTags`
are checked against the vocabulary for that module; an unknown tag is
rejected (not silently dropped) so it routes into the generator's repair
loop as an invalid item.
"""

from __future__ import annotations

SKILL_TAGS: dict[str, frozenset[str]] = {
    "listening": frozenset(
        {
            "global_main_idea",
            "detail_fact",
            "selective_information",
            "paraphrase_mapping",
            "speaker_intention",
            "speaker_opinion",
            "attitude_tone",
            "implicit_inference",
            "negation_contrast",
            "numbers_dates",
            "academic_structure",
            "note_taking",
            "speaker_matching",
            "true_false",
            "not_stated_distinction",
            "short_answer",
            "sound_script_mapping",
            "summary_error_detection",
            "lexical_in_context",
            "causal_relationship",
            "argument_structure",
        }
    ),
    "reading": frozenset(
        {
            "global_comprehension",
            "detail_comprehension",
            "selective_information",
            "paraphrase_mapping",
            "inference",
            "text_structure",
            "author_intention",
            "argument_structure",
            "reference_resolution",
        }
    ),
    "writing": frozenset(
        {
            "task_fulfilment",
            "argument_structure",
            "coherence",
            "cohesion",
            "grammar_accuracy",
            "vocabulary_range",
            "register",
            "sentence_variety",
            "orthography",
        }
    ),
    "speaking": frozenset(
        {
            "task_fulfilment",
            "fluency",
            "interaction",
            "argumentation",
            "coherence",
            "grammar_accuracy",
            "vocabulary_range",
            "pronunciation",
            "register",
            "response_to_partner",
        }
    ),
    "language_elements": frozenset(
        {
            "grammar",
            "collocation",
            "connectors",
            "prepositions",
            "word_formation",
            "register",
            "syntax",
            "lexical_choice",
        }
    ),
    # DSH "Wissenschaftssprachliche Strukturen" (MPO §10(4)2d: syntactic, morphological, lexical,
    # idiomatic, text-type-related structures). Deliberately its own vocabulary — NOT the
    # telc Sprachbausteine "language_elements" one.
    "scientific_structures": frozenset(
        {
            "syntactic_structure",
            "morphological_structure",
            "lexical_structure",
            "idiomatic_structure",
            "text_type_structure",
            "paraphrase",
            "transformation",
            "complex_structure_comprehension",
        }
    ),
}


class UnknownSkillTagError(Exception):
    def __init__(self, module: str, tag: str) -> None:
        super().__init__(f"unknown skill tag {tag!r} for module {module!r}")
        self.module = module
        self.tag = tag


def validate_tags(module: str, tags: list[str]) -> None:
    """Raises UnknownSkillTagError on the first tag not in this module's
    controlled vocabulary. Callers route the exception into the generator's
    per-item repair loop rather than silently dropping the tag."""
    vocabulary = SKILL_TAGS.get(module, frozenset())
    for tag in tags:
        if tag not in vocabulary:
            raise UnknownSkillTagError(module, tag)
