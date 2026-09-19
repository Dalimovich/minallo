from app.services.fallback_research import research_unresolved_items
from app.services.multi_item_retrieval import retrieve_multi_item_course_evidence

QUESTION = "What is DIN 8582?\nWhat are the advantages of gear rolling?"


def _result():
    return retrieve_multi_item_course_evidence(
        user_id="u", course_id="c", question=QUESTION,
        inventory_loader=lambda **_: (["d"], [], False),
        semantic_retriever=lambda **_: [],
    )


def test_only_standard_specific_unresolved_item_uses_web():
    calls = []

    def researcher(question, **_):
        calls.append(question)
        return {
            "answer": "DIN classification verified.",
            "webSources": [{"title": "DIN", "url": "https://din.example/8582", "snippet": ""}],
        }

    result = research_unresolved_items(
        _result(), grounding_policy="course_first", researcher=researcher,
    )
    assert calls == ["What is DIN 8582?"]
    assert len(result.items) == 1
    assert "Source basis: External verification" in result.prompt_overlay()
    assert result.sources[0]["url"] == "https://din.example/8582"


def test_course_only_modes_never_invoke_external_research():
    def forbidden(*_, **__):
        raise AssertionError("web must not run")

    for policy in ("strict_course", "selected_files_only"):
        assert not research_unresolved_items(
            _result(), grounding_policy=policy, researcher=forbidden,
        ).items


def test_web_answer_without_sources_is_not_treated_as_verified():
    result = research_unresolved_items(
        _result(), grounding_policy="course_first",
        researcher=lambda *_, **__: {"answer": "uncited", "webSources": []},
    )
    assert not result.items
