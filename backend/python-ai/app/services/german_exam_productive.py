"""Productive task and formative-feedback contracts, with injectable graders.

Feedback is practice-only. There is no conversion to an official scaled result.
"""
import json
import math
from .german_exam_objective import _rows, _text
WRITING_TYPES = frozenset({"argumentative_essay", "text_graph_summary"})
SPEAKING_TYPES = frozenset({"spoken_advice", "spoken_option_comparison", "spoken_text_summary",
    "spoken_information_comparison", "recorded_topic_presentation", "spoken_argument_response", "spoken_measure_critique"})


def validate_graphic(graphic):
    if not isinstance(graphic, dict): raise ValueError("graphic required")
    _text(graphic.get("title"), "graphic title"); _text(graphic.get("unit"), "graphic unit")
    columns = _rows(graphic.get("columns"), "graphic columns")
    for col in columns: _text(col.get("label"), "column label")
    rows = _rows(graphic.get("rows"), "graphic rows")
    for row in rows:
        _text(row.get("label"), "row label")
        values = row.get("values")
        if not isinstance(values, dict) or set(values) != {c["id"] for c in columns}: raise ValueError("graphic values mismatch")
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values.values()): raise ValueError("nonfinite graphic data")


def validate_productive(part, content):
    if not isinstance(content, dict) or content.get("schemaVersion") != "productive-task-v1": raise ValueError("invalid productive schema")
    _text(content.get("id"), "task id"); _text(content.get("prompt"), "task prompt")
    sources = content.get("sources")
    if not isinstance(sources, list): raise ValueError("sources must be an array")
    if sources: _rows(sources, "sources")
    for source in sources:
        kind = source.get("kind")
        if kind == "graphic": validate_graphic(source.get("graphic"))
        elif kind in ("text", "script"): _text(source.get("text"), "source text")
        else: raise ValueError("unknown source kind")
    required = part.constraints.get("requiredSourceKinds", ())
    if not set(required) <= {s["kind"] for s in sources}: raise ValueError("missing required source")
    if "answer" in content or "modelAnswer" in content: raise ValueError("learner task must not contain model answer")


def grading_request(part, content, submission):
    validate_productive(part, content)
    if not isinstance(submission, dict): raise ValueError("invalid submission")
    if part.task_type in WRITING_TYPES:
        _text(submission.get("text"), "submission text")
        normalized = {"text": submission["text"], "wordCount": len(submission["text"].split())}
    else:
        _text(submission.get("recordingId"), "recording ID")
        duration = submission.get("durationSeconds")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= part.constraints["speakingSeconds"]:
            raise ValueError("recording duration out of range")
        normalized = {"recordingId": submission["recordingId"], "durationSeconds": duration}
    return {"kind": "practice_feedback", "taskType": part.task_type, "dimensions": list(part.grading_dimensions or ()),
            "task": content, "submission": normalized, "constraints": part.constraints}


def validate_feedback(part, request, feedback):
    if not isinstance(feedback, dict) or feedback.get("kind") != "practice_feedback": raise ValueError("practice feedback required")
    if any(k in feedback for k in ("scaledScore", "tdn", "pass", "officialScore", "rawScore")): raise ValueError("official score not permitted")
    dimensions = _rows(feedback.get("dimensions"), "feedback dimensions")
    if {d["id"] for d in dimensions} != set(part.grading_dimensions or ()): raise ValueError("feedback dimension coverage")
    for d in dimensions:
        _text(d.get("feedback"), "dimension feedback")
        evidence = d.get("evidence")
        if not isinstance(evidence, list): raise ValueError("feedback evidence array required")
        for e in evidence:
            if not isinstance(e, dict): raise ValueError("evidence object required")
            _text(e.get("quote"), "evidence quote")
            if part.task_type in WRITING_TYPES and e["quote"] not in request["submission"]["text"]: raise ValueError("fabricated learner quote")
            if part.task_type in SPEAKING_TYPES:
                time = e.get("startSeconds")
                if isinstance(time, bool) or not isinstance(time, (int, float)) or not 0 <= time < request["submission"]["durationSeconds"]: raise ValueError("invalid recording evidence timestamp")
    if part.task_type in WRITING_TYPES and feedback.get("wordCount") != request["submission"]["wordCount"]: raise ValueError("word count mismatch")
    return feedback


def grade_productive(part, content, submission, *, grader):
    """Grader injection supports offline fixtures; provider adapters own delivery."""
    request = grading_request(part, content, submission)
    return validate_feedback(part, request, grader(request))


def generate_productive(profile, part, plan, topic, *, provider=None):
    from .llm_json import chat_json
    from ..config import get_settings
    call = provider or chat_json
    contract = {"taskType": part.task_type, "constraints": part.constraints,
                "shape": {"schemaVersion":"productive-task-v1", "id":"task", "prompt":"original German task instructions",
                          "sources":[{"id":"s1", "kind":"text or script or graphic", "text":"only for text/script",
                                      "graphic":{"title":"...", "unit":"...", "columns":[{"id":"a","label":"..."}], "rows":[{"id":"r1","label":"...","values":{"a":1}}]}}]}}
    content = call(system="Create a German productive task following the supplied contract. No model answer. "
                         "All source data must be self-contained, accessible and internally consistent. " + json.dumps(contract, ensure_ascii=False),
                   user=json.dumps(topic), model=part.constraints.get("generationModel") or get_settings().german_exam_model, max_tokens=5000).data
    validate_productive(part, content)
    return content, {"deterministicPassed": True, "liveQualificationRequired": True}
