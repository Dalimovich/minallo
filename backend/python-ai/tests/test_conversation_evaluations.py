"""Production-like multi-turn dialogue/state regression fixtures."""

from app.services.dialogue_state import DialogueAct, resolve_dialogue
from app.services.reference_resolution import resolve_language_context
from app.services.tutor_state import TutorState, VerifiedResult


def _turn(role, text):
    return {"role": role, "text": text}


def _resolve(message, history):
    language = resolve_language_context(message, previous_turns=history)
    return resolve_dialogue(
        message,
        previous_turns=history,
        response_language=language.requested_response_language,
    )


def test_five_turn_repair_conversation_has_no_critical_identity_failure():
    history = [
        _turn("user", "Explain Aufgabe 13.11 in English."),
        _turn("assistant", "The answer is 10."),
        _turn("user", "No, the professor marked 11."),
        _turn("assistant", "You're right—the marked and calculated result is 11."),
        _turn("user", "Are you sure?"),
    ]
    correction = _resolve(history[2]["text"], history[:2])
    challenge = _resolve(history[4]["text"], history[:4])
    assert correction.active_question == "13.11"
    assert correction.invalidate_previous_answer
    assert challenge.active_question == "13.11"
    assert challenge.dialogue_act == DialogueAct.VERIFY_PREVIOUS_ANSWER
    assert challenge.response_language == "en"


def test_ten_turn_language_depth_and_retry_conversation():
    history = [
        _turn("user", "Solve Aufgabe 12.1."),
        _turn("assistant", "The verified result is f = 0.15 mm/rev."),
        _turn("user", "Answer in English please."),
        _turn("assistant", "Sure—the verified result is f = 0.15 mm/rev."),
        _turn("user", "Now 12.2"),
        _turn("assistant", "Retrieval temporarily failed."),
        _turn("user", "Again"),
        _turn("assistant", "Here is the substitution."),
        _turn("user", "I understand the formula, but not the substitution."),
        _turn("assistant", "Substitute only the verified value from 12.1."),
    ]
    continuation = _resolve(history[4]["text"], history[:4])
    retry = _resolve(history[6]["text"], history[:6])
    confusion = _resolve(history[8]["text"], history[:8])
    assert continuation.active_question == "12.2"
    assert continuation.response_language == "en"
    assert retry.dialogue_act == DialogueAct.RETRY_PREVIOUS_REQUEST
    assert "12.2" in retry.resolved_request
    assert confusion.dialogue_act == DialogueAct.REQUEST_SIMPLIFICATION
    assert confusion.requested_depth == "one_step"


def test_twenty_turn_state_rejects_stale_result_after_two_corrections_and_page_change():
    state = TutorState(
        conversation_id="conversation",
        document_id="exam-a",
        document_revision="rev-1",
        exam_variant="A",
        active_question="12.1",
        active_page=10,
    )
    state.add_verified_result(VerifiedResult(
        id="12.1",
        document_id="exam-a",
        document_revision="rev-1",
        exam_variant="A",
        question_id="12.1",
        value="580",
        unit="m/min",
        derived_from_evidence_ids=("vc-old",),
    ))
    state.add_verified_result(VerifiedResult(
        id="12.2",
        document_id="exam-a",
        document_revision="rev-1",
        exam_variant="A",
        question_id="12.2",
        value="result-old",
        derived_from_result_ids=("12.1",),
    ))
    history = [
        _turn("user", "Solve Aufgabe 12.1."), _turn("assistant", "580 m/min."),
        _turn("user", "No, it says 560."), _turn("assistant", "I will re-check."),
        _turn("user", "Now 12.2."), _turn("assistant", "Using the corrected value."),
        _turn("user", "Answer in German."), _turn("assistant", "Ich rechne weiter."),
        _turn("user", "Nur der erste Schritt."), _turn("assistant", "Erster Schritt."),
        _turn("user", "Weiter."), _turn("assistant", "Nächster Schritt."),
        _turn("user", "No, use Variante B."), _turn("assistant", "I will verify B."),
        _turn("user", "Use the previous verified result."), _turn("assistant", "It is stale."),
        _turn("user", "Open page 14."), _turn("assistant", "Page changed."),
        _turn("user", "Are you sure?"), _turn("assistant", "I verified the new page."),
    ]
    invalid = state.invalidate(rejected_evidence_ids={"vc-old"}, turn_id="3")
    assert invalid == {"12.1", "12.2"}
    assert state.reusable_result(
        "12.2",
        document_id="exam-a",
        document_revision="rev-1",
        exam_variant="A",
    ) is None
    state.exam_variant = "B"
    state.active_page = 14
    final = _resolve(history[18]["text"], history[:18])
    assert final.dialogue_act == DialogueAct.VERIFY_PREVIOUS_ANSWER
    assert final.active_question == "12.2"
    assert len(history) == 20
