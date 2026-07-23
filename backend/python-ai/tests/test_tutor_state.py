from app.services.tutor_state import TutorState, VerifiedResult


def result(
    result_id: str,
    *,
    evidence=(),
    results=(),
    revision="rev-1",
    variant="A",
    priority="active_question",
):
    return VerifiedResult(
        id=result_id,
        document_id="exam",
        document_revision=revision,
        exam_variant=variant,
        question_id=result_id,
        value="1",
        derived_from_evidence_ids=tuple(evidence),
        derived_from_result_ids=tuple(results),
        source_priority=priority,
    )


def test_correction_invalidates_entire_dependency_chain():
    state = TutorState(conversation_id="c")
    state.add_verified_result(result("12.1", evidence=("vc",)))
    state.add_verified_result(result("12.2", results=("12.1",)))
    state.add_verified_result(result("12.3", results=("12.2",)))

    invalid = state.invalidate(
        rejected_evidence_ids={"vc"},
        turn_id="turn-correction",
        reason="580 corrected to 560",
    )

    assert invalid == {"12.1", "12.2", "12.3"}
    assert all(state.results[item].status == "stale" for item in invalid)
    assert state.generation == 1


def test_only_matching_verified_revision_and_variant_can_be_reused():
    state = TutorState(conversation_id="c")
    state.add_verified_result(result("12.1"))
    assert state.reusable_result(
        "12.1", document_id="exam", document_revision="rev-1", exam_variant="A"
    )
    assert state.reusable_result(
        "12.1", document_id="exam", document_revision="rev-2", exam_variant="A"
    ) is None
    assert state.reusable_result(
        "12.1", document_id="exam", document_revision="rev-1", exam_variant="B"
    ) is None


def test_teaching_example_result_is_never_reusable():
    state = TutorState(conversation_id="c")
    state.add_verified_result(result("example", priority="teaching_example"))
    assert state.reusable_result(
        "example", document_id="exam", document_revision="rev-1", exam_variant="A"
    ) is None


def test_document_replacement_marks_old_results_stale():
    state = TutorState(conversation_id="c", document_id="exam", document_revision="rev-1")
    state.add_verified_result(result("12.1"))
    stale = state.change_document("exam", "rev-2")
    assert stale == {"12.1"}
    assert state.results["12.1"].status == "stale"
