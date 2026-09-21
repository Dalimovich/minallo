from types import SimpleNamespace
import copy
import pytest
from app.services.german_exams.testdaf_digital import TESTDAF_DIGITAL
from app.services.german_exam_media_tasks import *
from app.services.german_exam_validator import validate_content
PARTS = TESTDAF_DIGITAL.modules["listening"]


def fixture(part):
    kind = MEDIA_TASKS[part.task_type]; count = part.constraints["itemCount"]
    questions = [{"id":f"q{i}", "prompt":f"Notiz {i}", "evidenceIds":["s1"], "skillTags":[part.allowed_skill_tags[0]]} for i in range(count + (2 if kind.endswith("selection") else 0))]
    source = {"segments":[{"id":"s1", "speakerId":"speaker1", "text":"Die Bibliothek bleibt heute bis achtzehn Uhr ge?ffnet."}]}
    for i,q in enumerate(questions):
        if kind == "short_answer": q["acceptedAnswers"] = ["achtzehn Uhr", "18 Uhr"]
        elif kind == "choice":
            q["options"] = [{"id":f"a{j}","text":f"Aussage {j}"} for j in range(part.constraints["optionCount"])]
            for option,role in zip(q["options"],part.constraints.get("categoryRoles",[])):option["role"]=role
            q["answerId"] = "a0"
        elif kind == "word_selection": q.update(prompt="falsch" if i<count else "gleich", spokenText="richtig" if i<count else "gleich")
    if kind == "word_selection": source["segments"][0]["text"] = " ".join(q["spokenText"] for q in questions)
    c = {"schemaVersion":"media-task-v1", "source":source, "questions":questions}
    if kind.endswith("selection"): c["correctIds"] = [q["id"] for q in questions[:count]]
    return c


def audit_for(part,c):
    kind=MEDIA_TASKS[part.task_type]
    return {"items":[{"id":q["id"], "verifiedAnswers":q.get("acceptedAnswers") if kind=="short_answer" else [q["answerId"]] if kind=="choice" else [q["id"] in c["correctIds"]],
                     "ambiguous":False,"outsideKnowledge":False,"keyContradictsSource":False,"implausibleDistractor":False,"evidenceIds":["s1"],"explanation":"Source evidence in fixture."} for q in c["questions"]]}


@pytest.mark.parametrize("part", PARTS, ids=lambda p:p.task_type)
def test_valid_generation_and_grade_with_mock(part):
    c=fixture(part); validate_media_task(part,c); validate_media_audit(part,c,audit_for(part,c))
    kind=MEDIA_TASKS[part.task_type]
    answers={q["id"]:q["acceptedAnswers"][0] if kind=="short_answer" else q["answerId"] if kind=="choice" else q["id"] in c["correctIds"] for q in c["questions"]}
    assert grade_media_task(part,c,answers)["correct"]==part.constraints["itemCount"]
    replies=iter([c,audit_for(part,c)])
    result,meta=generate_media_task(TESTDAF_DIGITAL,part,[],{},provider=lambda **kw:SimpleNamespace(data=next(replies)))
    assert meta["mediaReady"] is False and "media" not in result


@pytest.mark.parametrize("part", PARTS, ids=lambda p:p.task_type)
@pytest.mark.parametrize("failure", ["count","duplicate","missing","reference","source","media","timing"])
def test_malformed(part,failure):
    c=fixture(part)
    if failure=="count":
        if "correctIds" in c:c["correctIds"].pop()
        else:c["questions"].pop()
    if failure=="duplicate":c["questions"][1]["id"]=c["questions"][0]["id"]
    if failure=="missing":del c["questions"][0]["id"]
    if failure=="reference":c["questions"][0]["evidenceIds"]=["missing"]
    if failure=="source":c["source"]["segments"][0]["text"]=""
    if failure in ("media","timing"):
        c["media"]={"mediaType":part.constraints["mediaType"],"mediaId":"asset", "duration":10,"transcriptAvailability":"after_submission"}
        if failure=="media":c["media"]["videoUrl" if part.constraints["mediaType"]=="video" else "audioUrl"]="javascript:alert(1)"
        else:c["media"]["segments"]=[{"sourceId":"s1","start":8,"end":12}]
    assert validate_content(part,c)


@pytest.mark.parametrize("part", PARTS, ids=lambda p:p.task_type)
@pytest.mark.parametrize("failure", ["unsupported","multiple","outsideKnowledge","keyContradictsSource","implausibleDistractor","evidence"])
def test_semantic_fixture_failures(part,failure):
    c=fixture(part);audit=audit_for(part,c);r=audit["items"][0]
    if failure=="unsupported":r["verifiedAnswers"]=[]
    elif failure=="multiple":r["ambiguous"]=True
    elif failure=="evidence":r["evidenceIds"]=["unknown"]
    else:r[failure]=True
    with pytest.raises(ValueError):validate_media_audit(part,c,audit)


def test_short_answers_normalize_only_explicit_variants():
    p=PARTS[0];c=fixture(p)
    assert grade_media_task(p,c,{"q0":"  ACHTZEHN   Uhr.  "})["correct"]==1
    assert grade_media_task(p,c,{"q0":"am fr?hen Abend"})["correct"]==0


def test_overselect_cannot_get_full_marks():
    p=PARTS[2];c=fixture(p)
    with pytest.raises(ValueError):grade_media_task(p,c,{q["id"]:True for q in c["questions"]})
