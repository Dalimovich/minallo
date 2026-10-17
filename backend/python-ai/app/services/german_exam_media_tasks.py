"""Vendor-neutral media task content, validation and practice grading.

A generated script is not playable media. A separate delivery service must attach
an asset reference; neither this module nor its generator performs TTS/video work.
"""
import json
import math
import re
import unicodedata
from .german_exam_objective import _rows, _text

MEDIA_TASKS = {
    "listening_overview_completion": "short_answer",
    "listening_concept_pair_notes": "short_answer",
    "video_outline_completion": "short_answer",
    "video_speaker_statement_matching": "choice",
    "listening_multiple_choice": "choice",
    "listening_summary_error_detection": "error_selection",
    "sound_script_comparison": "word_selection",
}


def normalize_answer(value, policy=None):
    policy = policy or {}
    value = unicodedata.normalize("NFKC", value)
    if policy.get("ignoreCase"): value = value.casefold()
    if policy.get("ignorePunctuation"):
        value = "".join(c for c in value if not unicodedata.category(c).startswith("P"))
    return " ".join(value.split())


def validate_media_reference(media, expected_type):
    if not isinstance(media, dict) or media.get("mediaType") != expected_type:
        raise ValueError("media type mismatch")
    _text(media.get("mediaId"), "mediaId")
    duration = media.get("duration")
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
        raise ValueError("invalid media duration")
    if media.get("transcriptAvailability") not in ("hidden", "after_submission", "available"):
        raise ValueError("invalid transcript availability")
    url = media.get("videoUrl" if expected_type == "video" else "audioUrl")
    if url is not None and (not isinstance(url, str) or not re.match(r"^(https://|/(?!/)|blob:)", url)):
        raise ValueError("unsafe media URL")
    segments = media.get("segments", [])
    if not isinstance(segments, list): raise ValueError("invalid media segments")
    for seg in segments:
        if not isinstance(seg, dict) or not isinstance(seg.get("sourceId"), str): raise ValueError("invalid segment reference")
        start, end = seg.get("start"), seg.get("end")
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in (start, end)) or not 0 <= start < end <= duration:
            raise ValueError("invalid segment timing")


def validate_media_task(part, content):
    if not isinstance(content, dict) or content.get("schemaVersion") != "media-task-v1": raise ValueError("invalid media-task schema")
    kind = MEDIA_TASKS[part.task_type]
    source = _rows(content.get("source", {}).get("segments"), "source segments")
    for seg in source:
        _text(seg.get("text"), "segment text"); _text(seg.get("speakerId"), "speaker ID")
    source_ids = {s["id"] for s in source}
    questions = _rows(content.get("questions"), "questions")
    for q in questions:
        _text(q.get("prompt"), "prompt")
        if not isinstance(q.get("evidenceIds"), list) or not q["evidenceIds"] or any(i not in source_ids for i in q["evidenceIds"]): raise ValueError("invalid evidence reference")
        if not isinstance(q.get("skillTags"), list) or not q["skillTags"] or any(t not in part.allowed_skill_tags for t in q["skillTags"]): raise ValueError("invalid skill tags")
    count = part.constraints["itemCount"]
    if kind in ("short_answer", "choice") and len(questions) != count: raise ValueError("wrong item count")
    if kind == "short_answer":
        for q in questions:
            variants = q.get("acceptedAnswers")
            if not isinstance(variants, list) or not variants: raise ValueError("accepted variants required")
            for v in variants:
                _text(v, "accepted answer")
                if part.constraints.get("answerWordMax") and len(v.split()) > part.constraints["answerWordMax"]: raise ValueError("answer exceeds word maximum")
    elif kind == "choice":
        for q in questions:
            options = _rows(q.get("options"), "options")
            for o in options: _text(o.get("text"), "option text")
            if len(options) != part.constraints["optionCount"] or q.get("answerId") not in {o["id"] for o in options}: raise ValueError("invalid choices")
            if len({o["text"].strip().casefold() for o in options}) != len(options): raise ValueError("duplicate options")
            roles = part.constraints.get("categoryRoles")
            if roles and sorted(o.get("role", "") for o in options) != sorted(roles): raise ValueError("invalid speaker categories")
    else:
        keys = content.get("correctIds")
        if not isinstance(keys, list) or len(keys) != count or len(set(keys)) != count or not set(keys) < {q["id"] for q in questions}: raise ValueError("invalid error selection key/count")
        if kind == "word_selection":
            for q in questions:
                _text(q.get("spokenText"), "spoken word")
                if len(q["prompt"].split()) != 1 or len(q["spokenText"].split()) != 1: raise ValueError("word comparison requires tokens")
                if (normalize_answer(q["prompt"]) != normalize_answer(q["spokenText"])) != (q["id"] in keys): raise ValueError("word mismatch key inconsistent")
            if normalize_answer(" ".join(q["spokenText"] for q in questions)) != normalize_answer(" ".join(s["text"] for s in source)): raise ValueError("spoken tokens do not match source")
    media = content.get("media")
    if media is not None:
        validate_media_reference(media, part.constraints["mediaType"])
        if any(s["sourceId"] not in source_ids for s in media.get("segments", [])): raise ValueError("media segment references unknown source")


def grade_media_task(part, content, answers):
    validate_media_task(part, content)
    kind = MEDIA_TASKS[part.task_type]
    ids = {q["id"] for q in content["questions"]}
    if not isinstance(answers, dict) or set(answers) - ids: raise ValueError("unknown answers")
    if kind in ("error_selection", "word_selection"):
        selected = {k for k, v in answers.items() if v is True}
        if len(selected) > part.constraints["itemCount"]: raise ValueError("too many selected errors")
        correct = len(selected & set(content["correctIds"]))
    else:
        correct = 0
        for q in content["questions"]:
            given = answers.get(q["id"], "")
            if not isinstance(given, str): raise ValueError("answer must be text")
            if kind == "choice": correct += given == q["answerId"]
            else:
                policy = part.constraints.get("answerNormalization", {})
                within_limit = not part.constraints.get("answerWordMax") or len(given.split()) <= part.constraints["answerWordMax"]
                correct += within_limit and normalize_answer(given, policy) in [normalize_answer(v, policy) for v in q["acceptedAnswers"]]
    return {"kind": "practice", "correct": correct, "total": part.constraints["itemCount"],
            "gradingPolicy": "accepted_variants_only" if kind == "short_answer" else "objective_key"}


def validate_media_audit(part, content, audit):
    validate_media_task(part, content)
    rows = _rows(audit.get("items"), "audit items")
    if {r["id"] for r in rows} != {q["id"] for q in content["questions"]}: raise ValueError("audit coverage")
    by_id = {q["id"]: q for q in content["questions"]}
    kind = MEDIA_TASKS[part.task_type]
    for r in rows:
        q = by_id[r["id"]]
        expected = q.get("acceptedAnswers") if kind == "short_answer" else [q["answerId"]] if kind == "choice" else [q["id"] in content["correctIds"]]
        if r.get("verifiedAnswers") != expected or r.get("ambiguous") is not False or r.get("outsideKnowledge") is not False or r.get("keyContradictsSource") is not False or r.get("implausibleDistractor") is not False:
            raise ValueError("semantic audit failed")
        _text(r.get("explanation"), "audit explanation")
        if not isinstance(r.get("evidenceIds"), list) or not r["evidenceIds"] or any(e not in {s["id"] for s in content["source"]["segments"]} for e in r["evidenceIds"]): raise ValueError("audit evidence")


def generate_media_task(profile, part, plan, topic, *, provider=None):
    from .llm_json import chat_json
    from ..config import get_settings
    call = provider or chat_json
    model = part.constraints.get("generationModel") or get_settings().german_exam_model
    shape = {"schemaVersion": "media-task-v1", "source": {"segments": [{"id": "s1", "speakerId": "speaker1", "text": "original spoken text"}]},
             "questions": [{"id": "q1", "prompt": "slot, question, summary sentence or displayed word", "evidenceIds": ["s1"], "skillTags": [],
                            "acceptedAnswers": ["short-answer variants only"], "options": [{"id": "a", "text": "choice only"}], "answerId": "choice only",
                            "spokenText": "word comparison only"}], "correctIds": "selection tasks only: erroneous sentence or word IDs"}
    contract = {"shape": shape, "interaction": MEDIA_TASKS[part.task_type], "constraints": part.constraints, "skillTags": part.allowed_skill_tags}
    content = call(system="Generate an original German listening script and source-grounded task JSON. Do not generate media URLs. " + json.dumps(contract, ensure_ascii=False), user=json.dumps(topic), model=model, max_tokens=6000).data
    if "media" in content: raise ValueError("content generator cannot supply media")
    validate_media_task(part, content)
    audit = call(system="Independently check every answer against ONLY the script. Never trust the writer key or external knowledge. "
                        "Return {items:[{id,verifiedAnswers:[],ambiguous:false,outsideKnowledge:false,keyContradictsSource:false,implausibleDistractor:false,evidenceIds:[],explanation:string}]}. "
                        "verifiedAnswers contains all defensible choice IDs, all validated accepted variants, or one boolean indicating whether the sentence/word is erroneous. "
                        "Flag unsupported, ambiguous, contradictory answers or implausible distractors.",
                 user=json.dumps({"contract": contract, "content": content}, ensure_ascii=False), model=part.constraints.get("verifierModel") or model, max_tokens=4000).data
    validate_media_audit(part, content, audit)
    return content, {"deterministicPassed": True, "semantic": {"passed": True, "audit": audit}, "mediaReady": False}
