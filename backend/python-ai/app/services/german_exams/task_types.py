"""Task-type registry: which `PartBlueprint.task_type` values the engine can
generate today. Profiles declare structure; task types decide behaviour
(generation / validation / rendering / grading). A profile part whose task type
is not yet implemented is still a valid part of the exam (it shows in the exam
navigation), but generating it fails cleanly with 501 instead of being routed
to some other exam's task type.

Flip a task type to True only when its generator, validator and renderer exist.
"""

from __future__ import annotations

TASK_TYPES: dict[str, bool] = {
    # Reserved reusable interactions; generation/validation/rendering not implemented.
    "lexical_cloze": False,
    "paragraph_ordering": False,
    "reading_multiple_choice": False,
    "speech_act_matching": False,
    "statement_category_matching": False,
    "statement_concept_pair_matching": False,
    "reading_summary_error_detection": False,
    "listening_overview_completion": False,
    "listening_concept_pair_notes": False,
    "listening_summary_error_detection": False,
    "video_speaker_statement_matching": False,
    "video_outline_completion": False,
    "listening_multiple_choice": False,
    "sound_script_comparison": False,
    "argumentative_essay": False,
    "text_graph_summary": False,
    "spoken_advice": False,
    "spoken_option_comparison": False,
    "spoken_text_summary": False,
    "spoken_information_comparison": False,
    "recorded_topic_presentation": False,
    "spoken_argument_response": False,
    "spoken_measure_critique": False,
    # --- telc C1 Hochschule (reusable by any exam whose interaction is equivalent) ---
    "speaker_statement_matching": True,
    "sentence_completion_mc3": True,
    "structured_note_completion": True,
    "text_reconstruction_sentence_matching": True,
    "section_statement_matching": True,
    "detail_tristate_with_global_heading": True,
    "cloze_mc4_language_elements": True,
    "choice_long_form_writing": True,
    "presentation_summary_followup": True,
    "quote_guided_discussion": True,
    # --- Goethe-Zertifikat C1 ---
    "contextual_cloze_mc4": True,
    "reading_detail_mc3": True,
    "multi_author_statement_matching_with_none": True,
    "multi_source_statement_matching": True,
    "listening_tristate": True,
    "segmented_dialogue_mc3": True,
    "listening_detail_mc3": True,
    "forum_discussion_post": True,
    "formal_context_message": True,
    "presentation_with_followup": True,
    "guided_pair_discussion": True,
}


def is_task_type_implemented(task_type: str) -> bool:
    return TASK_TYPES.get(task_type, False)
