import copy
from types import SimpleNamespace
import pytest
from app.services.german_exams.testdaf_digital import TESTDAF_DIGITAL
from app.services.german_exam_objective import (
    SELECTION_TYPES, validate_selection, validate_audit, grade_selection, generate_selection,
)
from app.services.german_exam_validator import validate_content

PARTS = [p for p in TESTDAF_DIGITAL.modules["reading"] if p.task_type in SELECTION_TYPES]


def fixture(part):
    n = part.constraints["itemCount"]
    options = [{"id": f"o{i}", "text": f"Aussage {i}"} for i in range(part.constraints["optionCount"])]
    for option, role in zip(options, part.constraints.get("categoryRoles", [])):
        option["role"] = role
    questions = [{"id": f"q{i}", "prompt": f"Textstelle {i}", "answerId": options[i % len(options)]["id"],
                  "evidenceIds": ["p1"], "skillTags": [part.allowed_skill_tags[0]]} for i in range(n)]
    if part.constraints.get("groupCount"):
        for i, q in enumerate(questions): q["group"] = f"Begriff {i % part.constraints['groupCount']}"
    text = "Die Bibliothek verl?ngert ihre ?ffnungszeiten, damit Studierende abends arbeiten k?nnen."
    if part.task_type == "lexical_cloze":
        text += " " + " ".join("{{" + q["id"] + "}}" for q in questions)
        for q in questions: q["options"] = copy.deepcopy(options)
    return {"schemaVersion": "source-selection-v1", "source": {"paragraphs": [{"id": "p1", "text": text}]},
            "options": options, "questions": questions}


def audit_for(content):
    return {"items": [{"id": q["id"], "supportedAnswerIds": [q["answerId"]], "evidenceIds": q["evidenceIds"],
                        "sourceContradiction": False, "outsideKnowledge": False, "implausibleDistractorIds": [],
                        "explanation": "Fixture verifier finds the cited source supports only this answer."} for q in content["questions"]]}


@pytest.mark.parametrize("part", PARTS, ids=lambda p:p.task_type)
def test_valid_and_grade(part):
    content = fixture(part)
    assert not validate_content(part, content)
    validate_audit(part, content, audit_for(content))
    assert grade_selection(part, content, {})["correct"] == 0
    result = grade_selection(part, content, {q["id"]: q["answerId"] for q in content["questions"]})
    assert result["correct"] == part.constraints["itemCount"]
    assert "scaledScore" not in result


@pytest.mark.parametrize("part", PARTS, ids=lambda p:p.task_type)
@pytest.mark.parametrize("failure", ["count", "duplicate", "missing", "reference", "source", "evidence", "tags", "options"])
def test_reject_malformed(part, failure):
    c = fixture(part)
    if failure == "count": c["questions"].pop()
    if failure == "duplicate": c["questions"][1]["id"] = c["questions"][0]["id"]
    if failure == "missing": del c["questions"][0]["id"]
    if failure == "reference": c["questions"][0]["answerId"] = "missing"
    if failure == "source": c["source"]["paragraphs"][0]["text"] = None
    if failure == "evidence": c["questions"][0]["evidenceIds"] = ["missing"]
    if failure == "tags": c["questions"][0]["skillTags"] = ["unsupported"]
    if failure == "options":
        c["options"].pop()
        for q in c["questions"]: q.pop("options", None)
    assert validate_content(part, c)


@pytest.mark.parametrize("part", PARTS, ids=lambda p:p.task_type)
@pytest.mark.parametrize("failure", ["unsupported", "multiple", "implausible", "contradiction", "outside", "coverage", "evidence"])
def test_mock_semantic_failures(part, failure):
    c = fixture(part); audit = audit_for(c); r = audit["items"][0]
    if failure == "unsupported": r["supportedAnswerIds"] = []
    if failure == "multiple": r["supportedAnswerIds"].append("other")
    if failure == "implausible": r["implausibleDistractorIds"] = ["other"]
    if failure == "contradiction": r["sourceContradiction"] = True
    if failure == "outside": r["outsideKnowledge"] = True
    if failure == "coverage": audit["items"].pop()
    if failure == "evidence": r["evidenceIds"] = ["absent"]
    with pytest.raises(ValueError): validate_audit(part, c, audit)


@pytest.mark.parametrize("part", PARTS, ids=lambda p:p.task_type)
def test_mock_generation_repair_is_bounded_and_reverified(part):
    c = fixture(part); bad = audit_for(c); bad["items"][0]["outsideKnowledge"] = True
    replies = iter([c, bad, c, audit_for(c)])
    calls = []
    def provider(**kw):
        calls.append(kw); return SimpleNamespace(data=copy.deepcopy(next(replies)))
    result, meta = generate_selection(TESTDAF_DIGITAL, part, [], {"label": "Bibliothek"}, provider=provider)
    assert meta["repairCount"] == 1 and len(calls) == 4
    assert result["source"] == c["source"]
    assert "ONLY supplied source" in calls[1]["system"]
    replies = iter([c, bad, c, bad])
    with pytest.raises(ValueError): generate_selection(TESTDAF_DIGITAL, part, [], {}, provider=provider)


def test_category_roles_and_unique_mapping():
    for p in PARTS:
        c = fixture(p)
        if p.constraints.get("categoryRoles"):
            c["options"][0]["role"] = "invented"
        elif p.constraints.get("uniqueMappings"):
            c["questions"][1]["answerId"] = c["questions"][0]["answerId"]
        else:
            c["source"]["paragraphs"][0]["text"] += " {{unknown}}"
        assert validate_content(p, c)
