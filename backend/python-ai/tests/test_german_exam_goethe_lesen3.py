"""Goethe Lesen Teil 3 reuses the generic text_reconstruction_sentence_matching task type.

Proves (1) telc's reading prompts are byte-identical to the pre-generalisation snapshot,
(2) the same generator/validator/verifier serve Goethe with Goethe's own constraints,
(3) the Goethe-only integrity checks work and never apply to telc."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services import german_exam_reading as reading
from app.services import german_exam_semantic_verify as verify
from app.services.german_exam_validator import hard_issues, validate_content
from app.services.german_exams import get_part, get_profile

TELC = "telc_c1_hochschule"
GOETHE = "goethe_c1"
TOPIC = {"topicId": "t", "label": "Digitales Lernen"}
FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "telc_reading_prompts.json").read_text(encoding="utf8"))
_PAYLOAD = {
    "text": {"title": "T", "paragraphs": ["a {{g1}}"], "gaps": [{"gapId": "g1"}]},
    "candidates": [{"candidateId": "c1", "text": "x"}],
    "questions": [{"questionId": "q1", "gapId": "g1", "correctCandidateId": "c1", "correctSectionId": "a", "statement": "s"}],
    "sections": [{"sectionId": "a", "text": "t"}],
}


@pytest.mark.parametrize("part_id", ["lesen_1", "lesen_2", "lesen_3"])
def test_telc_reading_prompts_are_unchanged(part_id: str) -> None:
    part = get_part(TELC, "reading", part_id)
    gen = list(reading._PROMPT_BUILDERS[part.task_type](get_profile(TELC), part, [], TOPIC))
    ver = list(verify._VERIFY_PROMPT_BUILDERS[part.task_type](part, _PAYLOAD))
    assert gen == FIXTURE[f"gen_{part_id}"]
    assert ver == FIXTURE[f"ver_{part_id}"]


def test_goethe_lesen3_uses_the_same_task_type_and_builder_as_telc_lesen1() -> None:
    goethe = get_part(GOETHE, "reading", "lesen_3")
    telc = get_part(TELC, "reading", "lesen_1")
    assert goethe.task_type == telc.task_type == "text_reconstruction_sentence_matching"
    assert reading._PROMPT_BUILDERS[goethe.task_type] is reading._PROMPT_BUILDERS[telc.task_type]


def test_goethe_prompt_carries_goethe_constraints_not_telc_ones() -> None:
    part = get_part(GOETHE, "reading", "lesen_3")
    system, _ = reading._PROMPT_BUILDERS[part.task_type](get_profile(GOETHE), part, [], TOPIC)
    assert "exactly 8 gaps" in system and "exactly 10 candidate sentences" in system
    assert "exactly 2 are never correct" in system
    assert "Kommentar" in system and "Reportage" in system
    assert "477-583 words" in system and "about 600 words once" in system
    assert "academic/study-relevant" not in system and "Hochschule" not in system
    assert "across the 8 items" in system
    assert "scrambled order" in system


def test_goethe_verifier_prompt_counts_ten_candidates() -> None:
    part = get_part(GOETHE, "reading", "lesen_3")
    system, _ = verify._verify_prompt_lesen1(part, _PAYLOAD)
    assert "10 candidate sentences" in system and "ALL 10 candidates" in system
    assert "Hochschule" not in system and "telc" not in system


def test_word_range_prefers_exact_bounds_then_approx() -> None:
    assert reading.word_range({"wordCountMin": 400, "wordCountMax": 500}, 1, 2) == (400, 500)
    assert reading.word_range({"wordCountApprox": 530}, 1, 2) == (477, 583)
    assert reading.word_range({}, 7, 9) == (7, 9)


# ── deterministic validation ────────────────────────────────────────────────


def _valid_content() -> dict:
    paras = []
    for i in range(1, 9):
        paras.append(" ".join(["Wort"] * 62) + f" {{{{g{i}}}}} " + " ".join(["Ende"] * 4))
    cands = [{"candidateId": f"c{i}", "text": f"Das ist der vollständige Satz Nummer {i}."} for i in range(1, 11)]
    questions = [
        {"questionId": f"q{i}", "gapId": f"g{i}", "correctCandidateId": f"c{i}", "skillTags": ["text_structure"]}
        for i in range(1, 9)
    ]
    return {
        "text": {"title": "T", "paragraphs": paras, "gaps": [{"gapId": f"g{i}"} for i in range(1, 9)]},
        "candidates": cands,
        "questions": questions,
    }


def _issues(content: dict) -> list[str]:
    part = get_part(GOETHE, "reading", "lesen_3")
    return [i.message for i in hard_issues(validate_content(part, content))]


def test_valid_goethe_lesen3_passes() -> None:
    assert _issues(_valid_content()) == []


def test_goethe_counts_are_enforced() -> None:
    c = _valid_content()
    c["candidates"] = c["candidates"][:8]
    assert any("expected 10 candidates" in m for m in _issues(c))
    c = _valid_content()
    c["questions"][7]["correctCandidateId"] = "c1"
    assert any("candidate is used for more than one gap" in m for m in _issues(c))


def test_missing_duplicate_and_unknown_placeholders_are_rejected() -> None:
    c = _valid_content()
    c["text"]["paragraphs"][0] = c["text"]["paragraphs"][0].replace("{{g1}}", "")
    assert any("{{g1}} must appear exactly once" in m for m in _issues(c))
    c = _valid_content()
    c["text"]["paragraphs"][1] += " {{g1}}"
    assert any("{{g1}} must appear exactly once" in m for m in _issues(c))
    c = _valid_content()
    c["text"]["paragraphs"][2] += " {{g99}}"
    assert any("not declared gaps" in m for m in _issues(c))


def test_adjacent_gaps_and_wrong_length_are_rejected() -> None:
    c = _valid_content()
    c["text"]["paragraphs"][1] = c["text"]["paragraphs"][1].replace("{{g2}}", "{{g2}} {{g3}}").replace(" {{g3}} Ende", " Ende", 0)
    c["text"]["paragraphs"][2] = c["text"]["paragraphs"][2].replace(" {{g3}} ", " ")
    assert any("adjacent" in m for m in _issues(c))
    c = _valid_content()
    c["text"]["paragraphs"] = [" ".join(["Wort"] * 5) + f" {{{{g{i}}}}}" for i in range(1, 9)]
    assert any("gapped text has" in m for m in _issues(c))


def test_candidate_shape_is_enforced() -> None:
    c = _valid_content()
    c["candidates"][0]["text"] = "Zu kurz"
    assert any("candidate c1" in m for m in _issues(c))
    c = _valid_content()
    c["candidates"][1]["text"] = "Dies ist der erste Satz. Und dies ist noch ein zweiter Satz."
    assert any("more than one sentence" in m for m in _issues(c))
    c = _valid_content()
    c["candidates"][2]["text"] = "Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort Wort."
    assert any("candidate c3" in m for m in _issues(c))


def test_abbreviations_do_not_count_as_a_second_sentence() -> None:
    c = _valid_content()
    c["candidates"][0]["text"] = "Viele Kommunen, z. B. Hamburg, planen das bereits."
    assert not any("more than one sentence" in m for m in _issues(c))


def test_telc_lesen1_never_gets_the_goethe_only_checks() -> None:
    telc = get_part(TELC, "reading", "lesen_1")
    assert not telc.constraints.get("strictPlaceholders") and not telc.constraints.get("shuffleCandidates")
    content = {
        "text": {"title": "T", "paragraphs": ["ohne platzhalter"], "gaps": [{"gapId": f"g{i}"} for i in range(1, 7)]},
        "candidates": [{"candidateId": f"c{i}", "text": f"S{i}"} for i in range(1, 9)],
        "questions": [
            {"questionId": f"q{i}", "gapId": f"g{i}", "correctCandidateId": f"c{i}", "skillTags": ["text_structure"]}
            for i in range(1, 7)
        ],
    }
    assert hard_issues(validate_content(telc, content)) == []  # same lenient behaviour as before


def test_shuffle_keeps_ids_texts_and_keys_and_is_stable() -> None:
    c = _valid_content()
    part = get_part(GOETHE, "reading", "lesen_3")
    out = reading._postprocess(part, c)
    assert {x["candidateId"]: x["text"] for x in out["candidates"]} == {x["candidateId"]: x["text"] for x in c["candidates"]}
    assert [x["candidateId"] for x in out["candidates"]] != [x["candidateId"] for x in c["candidates"]]
    assert reading._postprocess(part, c)["candidates"] == out["candidates"]
    assert out["questions"] == c["questions"]
    telc = get_part(TELC, "reading", "lesen_1")
    assert reading._postprocess(telc, c) is c  # untouched for telc


# ── article-first generation (Goethe Teil 3) ────────────────────────────────


def _article():
    paragraphs = [[f"Dies ist der Satz {p * 5 + s} mit ausreichend vielen Wörtern für den Test." for s in range(1, 6)] for p in range(11)]
    return {"title": "Titel", "paragraphs": paragraphs}


def _numbered(article):
    out = []
    for para in article["paragraphs"]:
        for sentence in para:
            out.append((f"s{len(out) + 1}", sentence))
    return out


def _selection(ids=("s3", "s9", "s14", "s20", "s27", "s33", "s41", "s50")):
    return {
        "removed": [{"id": i, "function": "example", "skillTag": "reference_resolution"} for i in ids],
        "distractors": [{"text": "Völlig andere Behauptung über Lieferketten und Zölle.", "breaksBecause": "x"},
                        {"text": "Noch eine ganz eigene Aussage zum Wetter im Herbst.", "breaksBecause": "y"}],
    }


def test_selection_rules() -> None:
    order = [f"s{i}" for i in range(1, 56)]
    assert reading._check_selection(_selection(), order, 8, 2) == []
    assert any("first sentence" in p for p in reading._check_selection(_selection(("s1", "s9", "s14", "s20", "s27", "s33", "s41", "s50")), order, 8, 2))
    assert any("consecutive" in p for p in reading._check_selection(_selection(("s3", "s4", "s14", "s20", "s27", "s33", "s41", "s50")), order, 8, 2))
    assert any("thirds" in p for p in reading._check_selection(_selection(("s3", "s5", "s7", "s9", "s11", "s13", "s15", "s17")), order, 8, 2))
    assert any("exactly 8" in p for p in reading._check_selection({"removed": [], "distractors": []}, order, 8, 2))
    assert reading._check_selection("kaputt", order, 8, 2)


def test_distractor_that_paraphrases_a_removed_sentence_is_rejected() -> None:
    order = [f"s{i}" for i in range(1, 56)]
    texts = {i: f"Neutraler Füllsatz {i} ohne Bezug." for i in order}
    texts["s3"] = "Digitale Medien können diesen Dialog nicht immer angemessen ersetzen."
    sel = _selection()
    sel["distractors"][0]["text"] = "Digitale Endgeräte sollten den Dialog nicht ersetzen wollen, denn Medien ersetzen Dialog kaum."
    assert any("near-paraphrase" in p for p in reading._check_selection(sel, order, 8, 2, texts))
    assert reading._check_selection(_selection(), order, 8, 2, texts) == []


def test_near_paraphrase_helper() -> None:
    assert reading.near_paraphrase("Digitale Medien ersetzen den Dialog nicht.", "Der Dialog wird von digitalen Medien nicht ersetzt.")
    assert not reading.near_paraphrase("Die Lieferketten leiden unter Zöllen.", "Der Dialog wird von digitalen Medien nicht ersetzt.")


def test_assembly_is_deterministically_valid() -> None:
    part = get_part(GOETHE, "reading", "lesen_3")
    article = _article()
    numbered = _numbered(article)
    content = reading._assemble_reconstruction(part, article, numbered, _selection())
    assert len(content["candidates"]) == 10 and len(content["questions"]) == 8
    assert [q["gapId"] for q in content["questions"]] == [f"g{i}" for i in range(1, 9)]
    content = reading._postprocess(part, content)
    joined = "\n".join(content["text"]["paragraphs"])
    for i in range(1, 9):
        assert joined.count("{{g%d}}" % i) == 1
    cand = {c["candidateId"]: c["text"] for c in content["candidates"]}
    by_id = dict(numbered)
    for q, sid in zip(content["questions"], _selection()["removed"]):
        assert cand[q["correctCandidateId"]] == by_id[sid["id"]]
    assert all(t in cand.values() for t in (d["text"] for d in _selection()["distractors"]))


def test_blind_solver_flags_wrong_choices_and_alternatives(monkeypatch) -> None:
    part = get_part(GOETHE, "reading", "lesen_3")
    content = _valid_content()

    class R:
        def __init__(self, data):
            self.data = data

    def solver(assignments):
        return lambda **kw: R({"assignments": assignments, "unused": []})

    good = [{"gapId": f"g{i}", "candidateId": f"c{i}", "alsoFits": []} for i in range(1, 9)]
    monkeypatch.setattr(reading, "chat_json", solver(good))
    assert reading._blind_solve(part, content).passed

    wrong = [dict(a) for a in good]
    wrong[2]["candidateId"] = "c9"
    monkeypatch.setattr(reading, "chat_json", solver(wrong))
    res = reading._blind_solve(part, content)
    assert not res.passed and res.items[2].issues[0].code == "UNSUPPORTED_CORRECT_ANSWER"

    tied = [dict(a) for a in good]
    tied[4]["alsoFits"] = ["c10"]
    monkeypatch.setattr(reading, "chat_json", solver(tied))
    res = reading._blind_solve(part, content)
    assert not res.passed and res.items[4].issues[0].code == "AMBIGUOUS_MAPPING"

    monkeypatch.setattr(reading, "chat_json", lambda **kw: R("kaputt"))
    res = reading._blind_solve(part, content)
    assert not res.passed and res.part_wide_issues[0].code == "VERIFIER_RESPONSE_INVALID"


def test_solver_guided_repair_rewrites_only_the_confused_gap_and_its_next_sentence(monkeypatch) -> None:
    from app.services.german_exam_semantic_verify import SemanticIssue

    part = get_part(GOETHE, "reading", "lesen_3")
    content = _valid_content()
    content["text"]["paragraphs"][1] = "Davor steht ein Satz. {{g2}} Danach folgt der alte Folgesatz. Und noch einer."
    before = json.loads(json.dumps(content))

    class R:
        data = {
            "rewrites": [{"gapId": "g2", "gapSentence": "Dieser neue Lückensatz greift den Vorsatz auf.", "nextSentence": "Der neue Folgesatz nimmt dessen Begriff auf."}],
            "newDistractors": [{"replaces": "Das ist der vollständige Satz Nummer 9.", "text": "Diese Studie von 2019 widerlegt das Gegenteil."}],
        }

    monkeypatch.setattr(reading, "chat_json", lambda **kw: R())
    errors = {"q2": [SemanticIssue("AMBIGUOUS_MAPPING", "error", "x", {"questionIds": ["q2"], "confusedWith": ["c9"]})]}
    out, changed = reading._repair_reconstruction(part, content, errors)
    assert changed
    cand = {c["candidateId"]: c["text"] for c in out["candidates"]}
    assert cand["c2"] == "Dieser neue Lückensatz greift den Vorsatz auf."
    assert cand["c9"] == "Diese Studie von 2019 widerlegt das Gegenteil."  # the confused distractor was replaced
    assert "Der neue Folgesatz nimmt dessen Begriff auf." in out["text"]["paragraphs"][1]
    assert "alte Folgesatz" not in out["text"]["paragraphs"][1] and "Und noch einer." in out["text"]["paragraphs"][1]
    assert "{{g2}}" in out["text"]["paragraphs"][1]  # the placeholder is untouched
    assert content == before  # the input is never mutated
    for cid in ("c1", "c3", "c4", "c10"):
        assert cand[cid] == next(c["text"] for c in before["candidates"] if c["candidateId"] == cid)


def test_solver_guided_repair_is_a_noop_on_a_bad_answer(monkeypatch) -> None:
    from app.services.german_exam_semantic_verify import SemanticIssue

    part = get_part(GOETHE, "reading", "lesen_3")
    content = _valid_content()
    monkeypatch.setattr(reading, "chat_json", lambda **kw: type("R", (), {"data": "kaputt"})())
    errors = {"q2": [SemanticIssue("AMBIGUOUS_MAPPING", "error", "x", {"confusedWith": ["c4"]})]}
    assert reading._repair_reconstruction(part, content, errors) == (content, False)


def test_placeholder_names_are_rejected() -> None:
    for bad in ("Ein Beispiel dafür ist die Firma XYZ, die viel tut.", "So handelt Max Mustermann in solchen Fällen.", "Die Musterfirma zeigt es deutlich."):
        c = _valid_content()
        c["candidates"][0]["text"] = bad
        assert any("placeholder name" in m for m in _issues(c)), bad
    c = _valid_content()
    c["candidates"][0]["text"] = "Ein Beispiel dafür ist die Firma Siemens, die viel tut."
    assert not any("placeholder name" in m for m in _issues(c))


def test_blind_solver_rejects_an_absurd_unused_candidate(monkeypatch) -> None:
    part = get_part(GOETHE, "reading", "lesen_3")
    content = _valid_content()
    good = [{"gapId": f"g{i}", "candidateId": f"c{i}", "alsoFits": []} for i in range(1, 9)]

    def solver(assessment):
        return lambda **kw: type("R", (), {"data": {"assignments": good, "unused": ["c9", "c10"], "unusedAssessment": assessment}})()

    monkeypatch.setattr(reading, "chat_json", solver([{"candidateId": "c9", "verdict": "plausible"}, {"candidateId": "c10", "verdict": "plausible"}]))
    assert reading._blind_solve(part, content).passed
    monkeypatch.setattr(reading, "chat_json", solver([{"candidateId": "c9", "verdict": "absurd"}, {"candidateId": "c10", "verdict": "plausible"}]))
    res = reading._blind_solve(part, content)
    assert not res.passed and res.part_wide_issues[0].code == "IMPLAUSIBLE_DISTRACTOR"
    # a verdict about a KEYED candidate is never held against the distractors
    monkeypatch.setattr(reading, "chat_json", solver([{"candidateId": "c3", "verdict": "absurd"}]))
    assert reading._blind_solve(part, content).passed
