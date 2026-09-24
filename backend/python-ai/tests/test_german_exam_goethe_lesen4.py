"""Goethe Lesen Teil 4 — the generic multi_author_statement_matching_with_none task type (offline: fixtures only)."""

from __future__ import annotations

import copy

from app.services import german_exam_reading as reading
from app.services import german_exam_semantic_verify as verify
from app.services.german_exam_semantic_verify import ItemSemanticResult, SemanticVerificationResult, _apply_audits
from app.services.german_exam_validator import hard_issues, validate_content
from app.services.german_exams import get_part, get_profile
from app.services.german_exams.task_types import is_task_type_implemented

PID = "goethe_c1"
PART = get_part(PID, "reading", "lesen_4")

# Three authors with clearly different stances; every sentence is unique so evidence quotes are unambiguous.
A_TEXT = (
    "Ich halte die Vier-Tage-Woche für einen überfälligen Schritt. Wer nur noch vier Tage arbeitet, kommt "
    "erholter ins Büro, und in meinem Team sind die Krankmeldungen seit der Umstellung spürbar zurückgegangen. "
    "Natürlich muss die Arbeit dann in weniger Zeit erledigt werden, aber gerade das zwingt uns, unnötige "
    "Besprechungen endlich zu streichen. Die Firmen, die das ausprobiert haben, berichten übrigens kaum von "
    "Produktivitätsverlusten, weshalb ich die Skepsis vieler Chefs nicht teilen kann. Dass sich manche Kollegen zunächst an den neuen "
    "Rhythmus gewöhnen mussten, war zu erwarten; nach wenigen Wochen wollte jedoch niemand mehr zurück. "
    "Wer heute in Stellenanzeigen mit flexiblen Modellen wirbt, erreicht deutlich mehr qualifizierte Bewerber, "
    "und genau darin liegt für mich der eigentliche Wettbewerbsvorteil der kommenden Jahre für unsere Branche."
)
B_TEXT = (
    "Mir fehlt in der Debatte der Blick auf die Pflegeberufe und andere Bereiche mit festen Schichtplänen. "
    "Für eine Krankenschwester bedeutet die Vier-Tage-Woche schlicht längere Dienste am Stück, und niemand "
    "kann ernsthaft behaupten, dass zwölf Stunden am Bett erholsamer seien. Solange dort Personal fehlt, "
    "bleibt das Modell ein Privileg für Büroangestellte, und ich finde es unehrlich, es als Lösung für "
    "die gesamte Arbeitswelt zu verkaufen, ohne diese Ungleichheit überhaupt zu benennen. Auch im Einzelhandel und in der Gastronomie hängen die "
    "Öffnungszeiten an der Kundschaft, nicht an den Wünschen der Belegschaft. Wer Arbeitszeitmodelle ernsthaft "
    "gerechter gestalten will, muss deshalb zuerst fragen, welche Beschäftigten sich freie Tage bisher schlicht "
    "nicht leisten konnten, statt weiter über Schreibtischjobs zu diskutieren."
)
C_TEXT = (
    "Aus Sicht eines kleinen Handwerksbetriebs klingt das alles theoretisch. Meine Kunden erwarten, dass ich "
    "montags und freitags erreichbar bin, und einen Ersatz für meinen besten Gesellen finde ich nirgends. "
    "Trotzdem will ich das Experiment nicht verdammen: Wenn der Staat die zusätzlichen Kosten für die "
    "Umstellung teilweise übernähme, würde ich es für ein halbes Jahr testen, um selbst zu sehen, "
    "ob meine Mitarbeiter dadurch länger im Betrieb bleiben. Bislang lösen wir Engpässe mit Überstunden, die ich "
    "ungern bezahle und die niemand gern leistet. Eine verlässliche Regelung, an der sich auch die Kunden "
    "orientieren können, wäre mir lieber als ständiges Improvisieren, aber sie darf die Betriebe nicht "
    "wirtschaftlich überfordern, sonst bleibt sie am Ende ein schöner Gedanke ohne jede Wirkung im Alltag."
)

QUESTIONS = [
    # (statement, answer, evidence quote)
    ("Weniger Arbeitstage können dazu führen, dass Beschäftigte seltener ausfallen.", "a", "die Krankmeldungen seit der Umstellung spürbar zurückgegangen"),
    ("Für Beschäftigte mit starren Dienstplänen kann die Arbeitszeitverkürzung sogar zusätzliche Belastung mit sich bringen.", "b", "längere Dienste am Stück"),
    ("Ohne finanzielle Unterstützung traut sich ein kleiner Betrieb kaum an einen solchen Versuch.", "c", "Wenn der Staat die zusätzlichen Kosten für die Umstellung teilweise übernähme"),
    ("Die Diskussion vernachlässigt, dass nicht alle Berufsgruppen gleichermaßen profitieren.", "b", "ein Privileg für Büroangestellte"),
    ("Wer Zeitdruck verspürt, überdenkt automatisch seine Arbeitsabläufe.", "a", "unnötige Besprechungen endlich zu streichen"),
    ("Gewerkschaften sollten die Einführung verbindlich für alle Unternehmen fordern.", "none", ""),
    ("Jüngere Beschäftigte legen auf freie Tage mehr Wert als ältere.", "none", ""),
]


def _content() -> dict:
    return {
        "text": {"title": "Vier-Tage-Woche: Segen oder Illusion?", "authors": [
            {"authorId": "a", "name": "Jana K.", "text": A_TEXT},
            {"authorId": "b", "name": "Miriam S.", "text": B_TEXT},
            {"authorId": "c", "name": "Torsten W.", "text": C_TEXT},
        ]},
        "questions": [
            {"questionId": f"q{i}", "statement": s, "correctAuthorId": ans, "evidenceQuote": quote,
             "skillTags": ["author_intention", "paraphrase_mapping", "inference"][i % 3], "difficulty": "c1"}
            for i, (s, ans, quote) in enumerate(QUESTIONS, start=1)
        ],
    }


def _fix(content: dict) -> dict:
    for q in content["questions"]:
        q["skillTags"] = [q["skillTags"]] if isinstance(q["skillTags"], str) else q["skillTags"]
    return content


def _valid() -> dict:
    return _fix(_content())


def _issues(content: dict) -> list[str]:
    return [i.message for i in hard_issues(validate_content(PART, content))]


def test_profile_wiring() -> None:
    assert PART.task_type == "multi_author_statement_matching_with_none"
    assert PART.available is False, "Goethe parts stay unavailable until live qualification"
    assert is_task_type_implemented("multi_author_statement_matching_with_none")
    assert reading._PROMPT_BUILDERS["multi_author_statement_matching_with_none"] is reading._prompt_multi_author_statement_matching
    assert "multi_author_statement_matching_with_none" in verify._VERIFY_PROMPT_BUILDERS


def test_prompt_is_built_from_the_blueprint() -> None:
    profile = get_profile(PID)
    system, user = reading._prompt_multi_author_statement_matching(profile, PART, [], {"topicId": "t", "label": "Vier-Tage-Woche"})
    assert "3 short opinion texts" in system and "exactly 7 statements" in system
    assert "2 statements are asserted by NO author" in system and "correctAuthorId" in system
    assert "evidenceQuote" in system and "Vier-Tage-Woche" in user


def test_valid_content_passes() -> None:
    assert _issues(_valid()) == []


def test_counts_are_enforced() -> None:
    c = _valid()
    c["questions"] = c["questions"][:6]
    assert any("expected 7 statements" in m for m in _issues(c))
    c = _valid()
    c["text"]["authors"] = c["text"]["authors"][:2]
    assert any("expected 3 authors" in m for m in _issues(c))


def test_answer_must_be_an_author_or_none() -> None:
    c = _valid()
    c["questions"][0]["correctAuthorId"] = "z"
    assert any("author id or 'none'" in m for m in _issues(c))


def test_number_of_unmatched_statements_is_enforced() -> None:
    c = _valid()
    c["questions"][5]["correctAuthorId"] = "a"
    c["questions"][5]["evidenceQuote"] = "unnötige Besprechungen endlich zu streichen"
    assert any("no matching author" in m for m in _issues(c))


def test_every_author_must_be_an_answer() -> None:
    c = _valid()
    for q in c["questions"]:
        if q["correctAuthorId"] == "c":
            q["correctAuthorId"] = "none"
            q["evidenceQuote"] = ""
    msgs = _issues(c)
    assert any("author c is not the answer" in m for m in msgs)


def test_evidence_must_come_from_the_named_author_only() -> None:
    c = _valid()
    c["questions"][0]["evidenceQuote"] = "ein Privileg für Büroangestellte"  # author b's words, keyed a
    assert any("does not occur in author a" in m for m in _issues(c))
    c = _valid()
    c["questions"][0]["evidenceQuote"] = ""
    assert any("needs an evidenceQuote" in m for m in _issues(c))
    # the same sentence in two authors' texts makes the evidence ambiguous
    c = _valid()
    shared = "wir alle wissen längst genau was hier passiert"
    c["text"]["authors"][0]["text"] += " " + shared
    c["text"]["authors"][1]["text"] += " " + shared
    c["questions"][0]["evidenceQuote"] = shared
    assert any("another author's text" in m for m in _issues(c))


def test_statements_must_paraphrase_not_copy() -> None:
    c = _valid()
    c["questions"][0]["statement"] = "Die Krankmeldungen seit der Umstellung spürbar zurückgegangen sind."
    c["questions"][0]["statement"] = "Ich halte die Vier-Tage-Woche für einen überfälligen Schritt und kein Problem."
    assert any("paraphrase" in m for m in _issues(c))


def test_duplicate_statements_and_ids_are_rejected() -> None:
    c = _valid()
    c["questions"][1]["statement"] = c["questions"][0]["statement"]
    assert any("duplicate statements" in m for m in _issues(c))
    c = _valid()
    c["questions"][1]["questionId"] = "q1"
    assert _issues(c)  # duplicate questionId is caught by the generic id check


def test_author_shape_is_enforced() -> None:
    c = _valid()
    c["text"]["authors"][1]["authorId"] = "none"
    assert any("unique authorId" in m for m in _issues(c))
    c = _valid()
    c["text"]["authors"][1]["text"] = ""
    assert any("non-empty text" in m for m in _issues(c))
    c = _valid()
    c["text"]["authors"][2]["text"] = "Zu kurz."
    assert any("substantial text" in m or "words in total" in m for m in _issues(c))


def test_total_word_budget_is_enforced() -> None:
    c = _valid()
    for a in c["text"]["authors"]:
        a["text"] = a["text"] + " " + " ".join(f"zusatz{i}" for i in range(80))
    assert any("words in total" in m for m in _issues(c))


def test_skill_tags_must_exist_for_reading() -> None:
    c = _valid()
    c["questions"][0]["skillTags"] = ["not_a_real_tag"]
    assert _issues(c)


# ── semantic verifier interpretation (no provider call) ─────────────────────────


def _clean(ids):
    return SemanticVerificationResult(True, [], [ItemSemanticResult(i, True, []) for i in ids])


def _audit(question, supporting):
    data = {"items": [{"questionId": question["questionId"], "audit": {"supportingAuthorIds": supporting}}]}
    return _apply_audits(_clean([question["questionId"]]), data, PART, {"questions": [question]})


def test_verifier_accepts_a_unique_author_and_an_empty_none_audit() -> None:
    assert _audit({"questionId": "q1", "correctAuthorId": "a"}, ["a"]).passed
    assert _audit({"questionId": "q6", "correctAuthorId": "none"}, []).passed


def test_verifier_flags_wrong_or_missing_author() -> None:
    r = _audit({"questionId": "q1", "correctAuthorId": "a"}, ["b"])
    assert [i.code for i in r.items[0].issues] == ["UNSUPPORTED_CORRECT_ANSWER"]


def test_verifier_flags_two_supporting_authors_as_ambiguous() -> None:
    r = _audit({"questionId": "q1", "correctAuthorId": "a"}, ["a", "c"])
    assert [i.code for i in r.items[0].issues] == ["AMBIGUOUS_MAPPING"]


def test_verifier_flags_a_none_statement_that_an_author_actually_makes() -> None:
    r = _audit({"questionId": "q6", "correctAuthorId": "none"}, ["b"])
    assert [i.code for i in r.items[0].issues] == ["UNSUPPORTED_CORRECT_ANSWER"]


def test_verifier_rejects_a_malformed_audit() -> None:
    r = _audit({"questionId": "q1", "correctAuthorId": "a"}, "a")
    assert [i.code for i in r.items[0].issues] == ["VERIFIER_RESPONSE_INVALID"]


def test_verifier_prompt_hides_the_evidence_quote_from_the_judge() -> None:
    system, user = verify._verify_prompt_multi_author(PART, _valid())
    assert "Lesen Teil 4" in system and "NO author" in system
    assert "evidenceQuote" not in user and "authors" in user
