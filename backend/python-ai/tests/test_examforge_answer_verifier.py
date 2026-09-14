from unittest.mock import patch

from app.services.examforge_answer_verifier import answers_match, verify_examforge_answers
from app.services.llm_json import LlmResult


EVIDENCE = [{"id": "c1", "document": "notes.pdf", "page": 3, "text": "Stress is F/A. Here F=800 N and A=10 mm², so stress is 80 MPa."}]


def _llm(results):
    return LlmResult(data={"results": results}, model="test", prompt_tokens=1, completion_tokens=1)


def test_verifier_hides_generated_key_and_corrects_confident_mcq() -> None:
    question = {"id": "q1", "type": "mcq", "question": "What is F/A?", "options": ["strain", "mass", "speed", "stress"], "answer": "B", "source_chunk_ids": ["c1"]}
    with patch("app.services.examforge_answer_verifier.chat_json", return_value=_llm([
        {"id": "q1", "answer": "D", "confidence": 0.98, "status": "solved", "key_steps": ["Stress equals force divided by area."]}
    ])) as call:
        result = verify_examforge_answers([question], EVIDENCE)
    assert result[0].status == "corrected"
    assert result[0].verified_answer == "D"
    prompt = call.call_args.kwargs["user"]
    assert '"answer": "B"' not in prompt
    assert "solution" not in prompt
    assert '"evidence_chunk_ids": ["c1"]' in prompt


def test_true_false_can_be_corrected_but_uncertain_disagreement_is_rejected() -> None:
    questions = [
        {"id": "q1", "type": "true_false", "question": "Stress is F/A.", "answer": "false"},
        {"id": "q2", "type": "true_false", "question": "The claim holds.", "answer": "true"},
    ]
    with patch("app.services.examforge_answer_verifier.chat_json", return_value=_llm([
        {"id": "q1", "answer": "true", "confidence": "high", "status": "solved", "key_steps": []},
        {"id": "q2", "answer": "false", "confidence": 0.7, "status": "solved", "key_steps": []},
    ])):
        result = verify_examforge_answers(questions, EVIDENCE)
    assert [item.status for item in result] == ["corrected", "rejected"]
    assert result[1].verified_answer is None


def test_short_answer_numeric_error_is_corrected_with_units() -> None:
    question = {"id": "q1", "type": "short_answer", "question": "Compute stress for F=800 N, A=10 mm².", "answer": "60 MPa"}
    with patch("app.services.examforge_answer_verifier.chat_json", return_value=_llm([
        {"id": "q1", "answer": "80 MPa", "confidence": 0.99, "status": "solved", "key_steps": ["σ = F/A", "800/10 = 80 N/mm²"]}
    ])):
        result = verify_examforge_answers([question], EVIDENCE)
    assert result[0].status == "corrected"
    assert result[0].verified_answer == "80 MPa"
    assert len(result[0].key_steps) == 2


def test_low_confidence_and_missing_or_ambiguous_verdicts_fail_closed() -> None:
    questions = [
        {"id": "q1", "type": "short_answer", "question": "Name the value.", "answer": "alpha"},
        {"id": "q2", "type": "mcq", "question": "Choose.", "options": ["x", "y", "z", "w"], "answer": "A"},
    ]
    with patch("app.services.examforge_answer_verifier.chat_json", return_value=_llm([
        {"id": "q1", "answer": "beta", "confidence": 0.4, "status": "ambiguous", "key_steps": []}
    ])):
        result = verify_examforge_answers(questions, EVIDENCE)
    assert [item.status for item in result] == ["rejected", "rejected"]
    assert [item.reason for item in result] == ["not_confidently_solved", "missing_verdict"]


def test_comparison_canonicalises_supported_answer_types() -> None:
    assert answers_match("mcq", "D", "stress", ["strain", "mass", "speed", "stress"])
    assert answers_match("true_false", "wahr", True)
    assert answers_match("short_answer", "80,0 MPa", "80.0MPa")


def test_model_failure_rejects_every_question_without_exposing_exception() -> None:
    questions = [{"id": "q1", "type": "true_false", "question": "Claim.", "answer": "true"}]
    with patch("app.services.examforge_answer_verifier.chat_json", side_effect=RuntimeError("secret")):
        result = verify_examforge_answers(questions, EVIDENCE)
    assert result[0].status == "rejected"
    assert result[0].reason == "verifier_unavailable"
