from app.services import flashcards


def test_extract_flashcard_items_accepts_compatibility_cards_key() -> None:
    cards = [{"front": "Question?", "back": "Answer"}]
    assert flashcards.extract_flashcard_items({"cards": cards}) == cards
    assert flashcards.extract_flashcard_items({"items": cards}) == cards
    assert flashcards.extract_flashcard_items({"items": "invalid"}) == []


def test_empty_retrieval_returns_typed_failure(monkeypatch) -> None:
    monkeypatch.setattr(flashcards, "retrieve_chunks", lambda **_kw: [])
    result = flashcards.generate_flashcards(
        user_id="user", course_id="course", document_ids=["doc"],
        requested_count=10, doc_names={"doc": "lecture.pdf"}, topic="Umformen",
    )
    assert result["actualCount"] == 0
    assert result["failureCode"] == "flashcard_retrieval_empty"
    assert result["diagnostics"]["retrieved_chunk_count"] == 0
    assert "Only 0 strong flashcards" not in result["error"]
