from app.services.tutor_state import TutorState, VerifiedResult


def test_state_round_trip_preserves_provenance_and_rejects_stale_dependencies():
    state = TutorState(
        conversation_id="conversation-1",
        user_id="user-1",
        course_id="course-1",
        generation=20,
        document_id="doc-1",
        document_revision="rev-2",
        active_question="13.11",
        active_subquestion="b",
        active_page=33,
        active_region_id="region-2",
        response_language="de",
        response_mode="solve",
        explanation_level="detailed",
    )
    state.evidence_dependencies["given:vc:560"] = {
        "status": "verified",
        "document_id": "doc-1",
        "document_revision": "rev-2",
    }
    state.add_verified_result(VerifiedResult(
        id="result:a",
        document_id="doc-1",
        document_revision="rev-2",
        exam_variant="A",
        question_id="13.11a",
        value="560",
        unit="m/min",
        derived_from_evidence_ids=("given:vc:560",),
    ))
    state.exam_variant = "A"
    state.add_verified_result(VerifiedResult(
        id="result:b",
        document_id="doc-1",
        document_revision="rev-2",
        exam_variant="A",
        question_id="13.11b",
        value="11",
        derived_from_result_ids=("result:a",),
    ))

    restored = TutorState.from_api(state.to_api(), conversation_id="conversation-1")
    assert {item.id for item in restored.reusable_results()} == {"result:a", "result:b"}

    invalidated = restored.invalidate(
        rejected_evidence_ids={"given:vc:560"},
        status="rejected",
        turn_id="turn-14",
        reason="user corrected vc",
    )
    assert invalidated == {"result:a", "result:b"}
    assert restored.reusable_results() == []
