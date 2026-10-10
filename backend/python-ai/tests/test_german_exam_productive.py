from types import SimpleNamespace
import pytest
from app.services.german_exam_productive import *
from app.services.german_exams.testdaf_digital import TESTDAF_DIGITAL
from app.services.german_exam_validator import validate_content
PARTS=list(TESTDAF_DIGITAL.modules["writing"])


def fixture(part):
    sources=[]
    for i,kind in enumerate(part.constraints.get("requiredSourceKinds",())):
        s={"id":f"s{i}","kind":kind}
        if kind=="graphic":s["graphic"]={"title":"Besuche","unit":"Personen","columns":[{"id":"a","label":"Heute"}],"rows":[{"id":"r1","label":"Bibliothek","values":{"a":20}}]}
        else:s["text"]="Die Bibliothek hat heute zwanzig Besucher."
        sources.append(s)
    return {"schemaVersion":"productive-task-v1","id":"fixture-task","prompt":"Begr?nden Sie Ihre Position anhand der Materialien.","sources":sources}


def feedback(part,request):
    result={"kind":"practice_feedback","dimensions":[{"id":d,"feedback":"Ein nachvollziehbarer Beitrag.","evidence":[]} for d in part.grading_dimensions]}
    if part.task_type in WRITING_TYPES:result["wordCount"]=request["submission"]["wordCount"]
    return result


@pytest.mark.parametrize("part", PARTS, ids=lambda p:p.task_type)
def test_contract_generation_and_mock_grading(part):
    c=fixture(part);assert not validate_content(part,c)
    generated,_=generate_productive(TESTDAF_DIGITAL,part,[],{},provider=lambda **kw:SimpleNamespace(data=c))
    result=grade_productive(part,generated,{"text":"Mein kurzer Beitrag."},grader=lambda req:feedback(part,req))
    assert result["wordCount"]==3 and "scaledScore" not in result


@pytest.mark.parametrize("part", PARTS, ids=lambda p:p.task_type)
@pytest.mark.parametrize("failure", ["id","prompt","sources","source_id","graphic","missing_source"])
def test_bad_payload(part,failure):
    c=fixture(part)
    if failure=="id":c["id"]=""
    if failure=="prompt":c["prompt"]=""
    if failure=="sources":c["sources"]={}
    if failure=="source_id":c["sources"]=[{"id":"","kind":"text","text":"Text"}]
    if failure=="graphic":c["sources"]=[{"id":"s1","kind":"graphic","graphic":{"title":"x","unit":"x","columns":[],"rows":[]}}]
    if failure=="missing_source":
        if part.constraints.get("requiredSourceKinds"):c["sources"]=[]
        else:c["sources"]=[{"id":"s1","kind":"unknown"}]
    assert validate_content(part,c)


@pytest.mark.parametrize("part", PARTS, ids=lambda p:p.task_type)
@pytest.mark.parametrize("failure", ["dimensions","duplicate","quote","wordcount","scaled","tdn"])
def test_reject_invalid_feedback(part,failure):
    c=fixture(part);request=grading_request(part,c,{"text":"Mein Beitrag."});result=feedback(part,request)
    if failure=="dimensions":result["dimensions"].pop()
    if failure=="duplicate":result["dimensions"][1]["id"]=result["dimensions"][0]["id"]
    if failure=="quote":result["dimensions"][0]["evidence"]=[{"quote":"Invented quote"}]
    if failure=="wordcount":result["wordCount"]=900
    if failure=="scaled":result["scaledScore"]=15
    if failure=="tdn":result["tdn"]="TDN 4"
    with pytest.raises(ValueError):validate_feedback(part,request,result)


@pytest.mark.parametrize("part", TESTDAF_DIGITAL.modules["speaking"], ids=lambda p:p.task_type)
def test_speaking_contract_generation_feedback_and_duration(part):
    c=fixture(part);validate_productive(part,c)
    generate_productive(TESTDAF_DIGITAL,part,[],{},provider=lambda **kw:SimpleNamespace(data=c))
    submission={"recordingId":"fixture-recording","durationSeconds":part.constraints["speakingSeconds"]}
    result=grade_productive(part,c,submission,grader=lambda req:feedback(part,req))
    assert result["kind"]=="practice_feedback"
    for duration in (0,-1,True,float("nan"),part.constraints["speakingSeconds"]+1):
        with pytest.raises(ValueError):grading_request(part,c,{**submission,"durationSeconds":duration})
    if c["sources"]:
        c["sources"].append(dict(c["sources"][0]))
        with pytest.raises(ValueError):validate_productive(part,c)
