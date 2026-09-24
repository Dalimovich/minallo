"""Pure-function tests for quiz item normalisation."""

from __future__ import annotations

import os

import pytest


@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    os.environ.setdefault("OPENAI_API_KEY", "stub")
    os.environ.setdefault("INTERNAL_SECRET", "stub")


def test_mcq_accepts_letter_answer() -> None:
    from app.services.quiz import _normalize

    n = _normalize({
        "type": "mcq",
        "question": "What is F?",
        "options": {"A": "mass times acceleration", "B": "energy", "C": "power", "D": "velocity"},
        "answer": "A",
    })
    assert n and n["answer"] == "A"


def test_mcq_accepts_letter_with_paren_answer() -> None:
    from app.services.quiz import _normalize

    n = _normalize({
        "type": "mcq", "question": "What is F?",
        "options": {"A": "x", "B": "y", "C": "z", "D": "w"},
        "answer": "B) explanation",
    })
    assert n and n["answer"] == "B"


def test_mcq_accepts_option_text_answer() -> None:
    from app.services.quiz import _normalize

    n = _normalize({
        "type": "mcq", "question": "What is F?",
        "options": {"A": "mass times acceleration", "B": "energy", "C": "power", "D": "velocity"},
        "answer": "mass times acceleration",
    })
    assert n and n["answer"] == "A"


def test_true_false_normalises_strings() -> None:
    from app.services.quiz import _normalize

    yes = _normalize({"type": "true_false", "question": "Force = mass × acceleration?", "answer": "true"})
    assert yes and yes["answer"] is True
    no = _normalize({"type": "true_false", "question": "Energy = m × v?", "answer": "Falsch"})
    assert no and no["answer"] is False


def test_short_answer_keeps_text() -> None:
    from app.services.quiz import _normalize

    n = _normalize({"type": "short_answer", "question": "Define velocity.", "answer": "Rate of change of displacement."})
    assert n and n["answer"].startswith("Rate")


def test_short_answer_rejects_procedural_instruction() -> None:
    """P1 regression: a procedural instruction is not an answer key."""
    from app.services.quiz import _normalize

    n = _normalize({
        "type": "short_answer",
        "question": "What is the derivative of x^2?",
        "answer": "Use the formula above to calculate the derivative.",
    })
    assert n is None


def test_rejects_unknown_type() -> None:
    from app.services.quiz import _normalize

    assert _normalize({"type": "essay", "question": "...", "answer": "..."}) is None


def test_dedupe_strips_near_duplicates() -> None:
    from app.services.quiz import _dedupe

    items = [
        {"question": "What is Newton's second law?"},
        {"question": "what is newton's second law??"},
        {"question": "What is Hooke's law?"},
    ]
    out = _dedupe(items)
    assert len(out) == 2


def _mcq(question: str, answer: str) -> dict:
    return {
        "type": "mcq",
        "question": question,
        "options": {"A": "8% Si, 3% Cu", "B": "4% Si, 1% Cu", "C": "8% Cu, 3% other", "D": "8% Cu, 3% Si"},
        "answer": answer,
    }


def _stub_chat_json(monkeypatch, verdicts) -> dict:
    """Patch quiz.chat_json to return the given verdicts; record the call."""
    from app.services import quiz
    from app.services.llm_json import LlmResult

    captured: dict = {}

    def fake(*, system, user, max_tokens):
        captured["called"] = True
        return LlmResult(data={"verdicts": verdicts}, model="gpt-4o-mini", prompt_tokens=100, completion_tokens=20)

    monkeypatch.setattr(quiz, "chat_json", fake)
    return captured


def test_verify_drops_confident_disagreement(monkeypatch) -> None:
    from app.services.quiz import _verify_mcq_keys

    # Key says C, verifier confidently says A → drop the item.
    items = [_mcq("What does AlSi8Cu3 mean?", "C")]
    diag = {"prompt_tokens": 0, "completion_tokens": 0}
    _stub_chat_json(monkeypatch, [{"n": 1, "letter": "A", "confident": True}])

    out = _verify_mcq_keys(items, "AlSi8Cu3: aluminium with 8% silicon and 3% copper.", diag)
    assert out == []
    assert diag["prompt_tokens"] == 100  # usage rolled up


def test_verify_keeps_agreement(monkeypatch) -> None:
    from app.services.quiz import _verify_mcq_keys

    items = [_mcq("What does AlSi8Cu3 mean?", "A")]
    _stub_chat_json(monkeypatch, [{"n": 1, "letter": "A", "confident": True}])
    out = _verify_mcq_keys(items, "ctx", {"prompt_tokens": 0, "completion_tokens": 0})
    assert len(out) == 1


def test_verify_keeps_unconfident_disagreement(monkeypatch) -> None:
    from app.services.quiz import _verify_mcq_keys

    # Verifier disagrees but is not confident → never erode the count.
    items = [_mcq("Ambiguous?", "C")]
    _stub_chat_json(monkeypatch, [{"n": 1, "letter": "A", "confident": False}])
    out = _verify_mcq_keys(items, "ctx", {"prompt_tokens": 0, "completion_tokens": 0})
    assert len(out) == 1


def test_verify_passes_through_on_llm_failure(monkeypatch) -> None:
    from app.services import quiz
    from app.services.quiz import _verify_mcq_keys

    def boom(*, system, user, max_tokens):
        raise RuntimeError("openai down")

    monkeypatch.setattr(quiz, "chat_json", boom)
    items = [_mcq("Q?", "C")]
    out = _verify_mcq_keys(items, "ctx", {"prompt_tokens": 0, "completion_tokens": 0})
    assert out == items  # verification must never block a quiz


def test_verify_skips_when_no_verifiable_items(monkeypatch) -> None:
    from app.services.quiz import _verify_mcq_keys

    captured = _stub_chat_json(monkeypatch, [])
    items: list = []
    out = _verify_mcq_keys(items, "ctx", {"prompt_tokens": 0, "completion_tokens": 0})
    assert out == items
    assert "called" not in captured  # no LLM call when there is nothing to verify


def test_verify_drops_confident_true_false_disagreement(monkeypatch) -> None:
    """P1 regression: a wrong true/false key must not survive verification."""
    from app.services.quiz import _verify_mcq_keys

    items = [{"type": "true_false", "question": "Force = mass x acceleration?", "answer": False}]
    diag = {"prompt_tokens": 0, "completion_tokens": 0}
    _stub_chat_json(monkeypatch, [{"n": 1, "answer": True, "confident": True}])

    out = _verify_mcq_keys(items, "Newton's second law: F = m*a.", diag)
    assert out == []  # confidently wrong key dropped, not passed through


def test_verify_keeps_true_false_agreement(monkeypatch) -> None:
    from app.services.quiz import _verify_mcq_keys

    items = [{"type": "true_false", "question": "Force = mass x acceleration?", "answer": True}]
    _stub_chat_json(monkeypatch, [{"n": 1, "answer": True, "confident": True}])
    out = _verify_mcq_keys(items, "ctx", {"prompt_tokens": 0, "completion_tokens": 0})
    assert len(out) == 1


def test_verify_keeps_unconfident_true_false_disagreement(monkeypatch) -> None:
    from app.services.quiz import _verify_mcq_keys

    items = [{"type": "true_false", "question": "Ambiguous?", "answer": False}]
    _stub_chat_json(monkeypatch, [{"n": 1, "answer": True, "confident": False}])
    out = _verify_mcq_keys(items, "ctx", {"prompt_tokens": 0, "completion_tokens": 0})
    assert len(out) == 1  # low confidence never erodes the count


def test_verify_drops_confident_short_answer_disagreement(monkeypatch) -> None:
    from app.services.quiz import _verify_mcq_keys

    items = [{"type": "short_answer", "question": "What is the SI unit of force?", "answer": "Joule"}]
    diag = {"prompt_tokens": 0, "completion_tokens": 0}
    _stub_chat_json(monkeypatch, [{"n": 1, "answer": "Newton", "confident": True}])

    out = _verify_mcq_keys(items, "The SI unit of force is the Newton (N).", diag)
    assert out == []


def test_verify_keeps_short_answer_agreement(monkeypatch) -> None:
    from app.services.quiz import _verify_mcq_keys

    items = [{"type": "short_answer", "question": "What is the SI unit of force?", "answer": "Newton"}]
    _stub_chat_json(monkeypatch, [{"n": 1, "answer": "Newton", "confident": True}])
    out = _verify_mcq_keys(items, "ctx", {"prompt_tokens": 0, "completion_tokens": 0})
    assert len(out) == 1


def _inline_quiz_answer(intro: str, title: str, questions: list[dict]) -> str:
    import json

    block = json.dumps({"title": title, "questions": questions})
    return intro + "\n\n```minallo-quiz\n" + block + "\n```"


def test_inline_quiz_corrects_confident_disagreement_in_place() -> None:
    from app.services.quiz import verify_and_correct_inline_quiz

    answer = _inline_quiz_answer(
        "Here is a quiz on aluminium alloys.",
        "Alloys",
        [{
            "q": "What does AlSi8Cu3 mean?",
            "options": ["8% copper, 3% silicon", "8% silicon, 3% copper", "Pure aluminium", "8% iron, 3% zinc"],
            "answer": 0,  # wrong on purpose — verifier should flip this to index 1 ("B")
            "explanation": "Reads the alloy code left to right.",
        }],
    )

    class _FakeQuiz:
        def __call__(self, *, system, user, max_tokens):
            from app.services.llm_json import LlmResult
            return LlmResult(
                data={"verdicts": [{"n": 1, "letter": "B", "confident": True}]},
                model="gpt-4o-mini", prompt_tokens=80, completion_tokens=15,
            )

    import app.services.quiz as quiz_module
    original = quiz_module.chat_json
    quiz_module.chat_json = _FakeQuiz()
    try:
        new_answer, diag = verify_and_correct_inline_quiz(
            answer, "AlSi8Cu3: aluminium with 8% silicon and 3% copper."
        )
    finally:
        quiz_module.chat_json = original

    import json
    fence = new_answer.split("```minallo-quiz\n", 1)[1].rsplit("\n```", 1)[0]
    payload = json.loads(fence)
    assert payload["questions"][0]["answer"] == 1  # corrected from 0 ("A") to 1 ("B")
    # The rest of the answer (intro text, title, explanation) is untouched.
    assert new_answer.startswith("Here is a quiz on aluminium alloys.")
    assert payload["questions"][0]["explanation"] == "Reads the alloy code left to right."
    assert diag["model"] == "gpt-4o-mini"
    assert diag["prompt_tokens"] == 80


def test_inline_quiz_leaves_agreement_untouched() -> None:
    from app.services.quiz import verify_and_correct_inline_quiz

    answer = _inline_quiz_answer("Quiz time.", "T", [{
        "q": "Q1", "options": ["A", "B"], "answer": 0, "explanation": "e",
    }])

    import app.services.quiz as quiz_module
    from app.services.llm_json import LlmResult
    original = quiz_module.chat_json
    quiz_module.chat_json = lambda **_: LlmResult(
        data={"verdicts": [{"n": 1, "letter": "A", "confident": True}]},
        model="gpt-4o-mini", prompt_tokens=10, completion_tokens=5,
    )
    try:
        new_answer, _ = verify_and_correct_inline_quiz(answer, "ctx")
    finally:
        quiz_module.chat_json = original

    assert new_answer == answer  # byte-for-byte unchanged — nothing to correct


def test_inline_quiz_never_drops_questions_on_unconfident_disagreement() -> None:
    from app.services.quiz import verify_and_correct_inline_quiz

    answer = _inline_quiz_answer("Quiz.", "T", [{
        "q": "Ambiguous?", "options": ["A", "B"], "answer": 0, "explanation": "e",
    }])

    import app.services.quiz as quiz_module
    from app.services.llm_json import LlmResult
    original = quiz_module.chat_json
    quiz_module.chat_json = lambda **_: LlmResult(
        data={"verdicts": [{"n": 1, "letter": "B", "confident": False}]},
        model="gpt-4o-mini", prompt_tokens=10, completion_tokens=5,
    )
    try:
        new_answer, _ = verify_and_correct_inline_quiz(answer, "ctx")
    finally:
        quiz_module.chat_json = original

    assert new_answer == answer
    import json
    fence = new_answer.split("```minallo-quiz\n", 1)[1].rsplit("\n```", 1)[0]
    assert len(json.loads(fence)["questions"]) == 1  # count preserved — no drop


def test_inline_quiz_passes_through_on_llm_failure() -> None:
    from app.services.quiz import verify_and_correct_inline_quiz

    answer = _inline_quiz_answer("Quiz.", "T", [{
        "q": "Q?", "options": ["A", "B"], "answer": 0, "explanation": "e",
    }])

    import app.services.quiz as quiz_module

    def boom(**_):
        raise RuntimeError("openai down")

    original = quiz_module.chat_json
    quiz_module.chat_json = boom
    try:
        new_answer, diag = verify_and_correct_inline_quiz(answer, "ctx")
    finally:
        quiz_module.chat_json = original

    assert new_answer == answer
    assert diag["model"] is None


def test_inline_quiz_passes_through_when_no_fence_present() -> None:
    from app.services.quiz import verify_and_correct_inline_quiz

    answer = "Just a plain answer with no quiz block."
    new_answer, diag = verify_and_correct_inline_quiz(answer, "ctx")
    assert new_answer == answer
    assert diag == {"prompt_tokens": 0, "completion_tokens": 0, "model": None}


def test_inline_quiz_passes_through_on_malformed_json() -> None:
    from app.services.quiz import verify_and_correct_inline_quiz

    answer = "Quiz:\n\n```minallo-quiz\n{not valid json\n```"
    new_answer, diag = verify_and_correct_inline_quiz(answer, "ctx")
    assert new_answer == answer
    assert diag["model"] is None


def test_deterministic_backfill_honours_requested_count() -> None:
    from app.services.quiz import _deterministic_mcq_backfill
    from app.services.retrieval import RetrievedChunk

    chunks = [
        RetrievedChunk(
            chunk_id=f"c{i}",
            document_id="doc1",
            page_start=i,
            page_end=i,
            text=f"Important course statement number {i} explains the professor's method clearly.",
            score=1.0,
            similarity=0.8,
            chunk_type="lecture",
            section_title="Section",
        )
        for i in range(1, 11)
    ]

    items = _deterministic_mcq_backfill(
        chunks=chunks,
        doc_names={"doc1": "lecture.pdf"},
        needed=10,
        seen_questions=set(),
    )

    assert len(items) == 10
    assert all(item["type"] == "mcq" for item in items)
    assert all(item["source"].startswith("lecture.pdf") for item in items)


def test_generate_quiz_drops_wrong_true_false_key(monkeypatch) -> None:
    """P1 regression, end-to-end: a mocked LLM returns a correct MCQ plus a
    true_false item with a confidently-wrong key. The independent
    verification pass inside generate_quiz must drop the bad true_false item
    before it reaches result["questions"] — a wrong key must never survive
    to be served as ground truth to a student.
    """
    from app.services import quiz
    from app.services.llm_json import LlmResult
    from app.services.retrieval import RetrievedChunk

    chunk = RetrievedChunk(
        chunk_id="c1",
        document_id="doc1",
        page_start=1,
        page_end=1,
        text="Newton's second law states F = m * a. Energy is measured in Joules, not Newtons.",
        score=1.0,
        similarity=0.9,
        chunk_type="lecture",
        section_title="Mechanics",
    )
    monkeypatch.setattr(quiz, "retrieve_chunks", lambda **kw: [chunk])
    monkeypatch.setattr(quiz, "_fetch_course_topics", lambda *a, **kw: [])
    monkeypatch.setattr(quiz, "understanding_block_for_ids", lambda *a, **kw: "")

    def fake_chat_json(*, system, user, max_tokens, model=None):
        if "verdicts" in system:
            # Independent, answer-key-blind verification: agrees with the
            # MCQ key, confidently disagrees with the true_false key.
            return LlmResult(
                data={"verdicts": [
                    {"n": 1, "letter": "A", "confident": True},
                    {"n": 2, "answer": False, "confident": True},
                ]},
                model="gpt-4o-mini", prompt_tokens=50, completion_tokens=10,
            )
        return LlmResult(
            data={"items": [
                {
                    "type": "mcq",
                    "question": "What is Newton's second law?",
                    "options": {"A": "F = m * a", "B": "F = m / a", "C": "F = m + a", "D": "F = m - a"},
                    "answer": "A",
                    "explanation": "F = m * a per the course material.",
                    "difficulty": "easy",
                    "source": "lecture.pdf, p.1",
                },
                {
                    "type": "true_false",
                    "question": "Energy is measured in Newtons.",
                    # Deliberately wrong key — the material says Joules.
                    "answer": True,
                    "explanation": "Wrong on purpose to exercise verification.",
                    "difficulty": "easy",
                    "source": "lecture.pdf, p.1",
                },
            ]},
            model="gpt-4o-mini", prompt_tokens=200, completion_tokens=80,
        )

    monkeypatch.setattr(quiz, "chat_json", fake_chat_json)

    result = quiz.generate_quiz(
        user_id="u1",
        course_id="course1",
        document_ids=["doc1"],
        requested_count=1,
        difficulty="medium",
        question_types=["mcq", "true_false"],
        doc_names={"doc1": "lecture.pdf"},
    )

    questions = result["questions"]
    assert questions, "expected at least one surviving question"
    assert all(
        not (q["type"] == "true_false" and q["question"] == "Energy is measured in Newtons.")
        for q in questions
    ), "wrong-key true_false item must not survive verification"
