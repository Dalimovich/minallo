"""Deep Learn guided tutor lessons.

Deep Learn teaches one course topic step by step from the student's uploaded
materials. It retrieves separate evidence buckets (definitions, formulas,
lecture explanations, exercises, common traps, related concepts), checks that
the topic is actually covered, then asks the model for a strict structured
lesson object that the frontend can render as academic learning sections.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from .learning_agent import retrieve_learning_context
from .llm_json import chat_json
from .notes import save_note
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

_BUCKET_TOP_K = 6
_MIN_TOTAL_EVIDENCE = 3
_MIN_BUCKETS_WITH_EVIDENCE = 2
_MAX_CHUNK_CHARS = 1100

_EVIDENCE_BUCKETS: dict[str, dict[str, Any]] = {
    "definitions": {
        "label": "definitions",
        "query": "{topic} definition meaning concept core idea",
        "document_types": ["lecture", "script", "notes"],
    },
    "formulas": {
        "label": "formulas",
        "query": "{topic} formula equation variables conditions theorem law",
        "document_types": ["lecture", "formula_sheet", "script"],
    },
    "lecture_explanations": {
        "label": "lecture explanations",
        "query": "{topic} explanation intuition derivation lecture notes",
        "document_types": ["lecture", "script", "notes"],
    },
    "worked_examples": {
        "label": "exercises / worked examples",
        "query": "{topic} exercise example solution task problem worked example",
        "document_types": ["exercise", "solution", "tutorial"],
    },
    "common_traps": {
        "label": "common traps or professor warnings",
        "query": "{topic} mistake warning注意 sign convention condition exception trap",
        "document_types": ["lecture", "exercise", "solution"],
    },
    "related_concepts": {
        "label": "related concepts",
        "query": "{topic} related concept prerequisite follows from connected topic",
        "document_types": ["lecture", "script", "notes"],
    },
}

_SYSTEM = (
    "You are Minallo Deep Learn, a professor-like guided tutor for university students.\n"
    "Use ONLY the provided COURSE EVIDENCE. Do not use outside knowledge. Do not invent "
    "professor examples. If an example comes from evidence, say which source supports it. "
    "If no worked example exists, create only a clearly labelled mini-example based on the "
    "cited formulas above.\n\n"
    "Teach in this order: what the topic is about, the intuition, the main formulas, when "
    "to use them, how to solve a typical exercise, mistakes to avoid, then self-checks.\n\n"
    "Citation rules:\n"
    "- Every formula must have a source string copied from one of the source labels.\n"
    "- Every important claim should be grounded in a source label.\n"
    "- Never cite a source label that is not in COURSE EVIDENCE.\n"
    "- If citation coverage is weak, include a short warning.\n\n"
    "Return ONLY JSON with exactly this shape:\n"
    "{"
    '"title":"","learningGoal":"","intuition":"","coreExplanation":"",'
    '"keyFormulas":[{"formula":"","meaning":"","variables":"","conditions":"","source":"","commonMistake":""}],'
    '"stepByStepMethod":[""],'
    '"workedExample":{"problem":"","solutionSteps":[""],"finalAnswer":"","sourceOrBasis":"","isMiniExample":false},'
    '"commonMistakes":[""],'
    '"selfCheck":[{"question":"","answer":"","explanation":""}],'
    '"nextTopics":[""],'
    '"groundedSources":[""],'
    '"citationWarning":""'
    "}"
)


def _backfill_doc_names(chunks: list[dict[str, Any]], doc_names: dict[str, str]) -> dict[str, str]:
    missing = {c.get("documentId") for c in chunks if c.get("documentId")} - set(doc_names)
    missing.discard(None)
    if not missing:
        return doc_names
    try:
        resp = (
            get_supabase().table("documents")
            .select("id, file_name")
            .in_("id", list(missing))
            .execute()
        )
        for row in (resp.data or []):
            if row.get("id") and row.get("file_name"):
                doc_names[row["id"]] = row["file_name"]
    except Exception:  # noqa: BLE001
        log.exception("deep_learn doc-name backfill failed (non-fatal)")
    return doc_names


def _chunk_key(c: dict[str, Any]) -> tuple[str, int | None, str]:
    return (str(c.get("documentId") or ""), c.get("pageStart"), str(c.get("chunkId") or c.get("id") or ""))


def _source_label(index: int, c: dict[str, Any], doc_names: dict[str, str]) -> str:
    fn = doc_names.get(c.get("documentId") or "", "Unknown")
    pg = c.get("pageStart")
    return f"Source {index}: {fn}" + (f", p.{pg}" if pg else "")


def _sources(chunks: list[dict[str, Any]], doc_names: dict[str, str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i, c in enumerate(chunks, 1):
        out.append({
            "index": i,
            "documentId": c.get("documentId"),
            "fileName": doc_names.get(c.get("documentId") or "", "Unknown"),
            "pageStart": c.get("pageStart"),
            "pageEnd": c.get("pageEnd"),
            "label": _source_label(i, c, doc_names),
        })
    return out


def _retrieve_bucketed_evidence(
    *,
    user_id: str,
    course_id: str,
    topic: str,
    document_ids: list[str] | None,
) -> dict[str, list[dict[str, Any]]]:
    buckets: dict[str, list[dict[str, Any]]] = {}
    for name, spec in _EVIDENCE_BUCKETS.items():
        try:
            buckets[name] = retrieve_learning_context(
                user_id=user_id,
                course_id=course_id,
                topic=topic,
                query=str(spec["query"]).format(topic=topic),
                document_types=spec.get("document_types"),
                document_ids=document_ids or None,
                purpose="deep_learn",
                top_k=_BUCKET_TOP_K,
            )
        except Exception:  # noqa: BLE001
            log.exception("deep_learn retrieval bucket failed bucket=%s topic=%s", name, topic)
            buckets[name] = []
    return buckets


def _merge_evidence(buckets: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[tuple[str, int | None, str]] = set()
    for name in _EVIDENCE_BUCKETS:
        for c in buckets.get(name, []):
            key = _chunk_key(c)
            if key in seen:
                continue
            seen.add(key)
            d = dict(c)
            d["evidenceBucket"] = name
            merged.append(d)
    return merged


def _topic_coverage_ok(topic: str, buckets: dict[str, list[dict[str, Any]]]) -> bool:
    total = sum(len(v) for v in buckets.values())
    non_empty = sum(1 for v in buckets.values() if v)
    if total < _MIN_TOTAL_EVIDENCE or non_empty < _MIN_BUCKETS_WITH_EVIDENCE:
        return False
    topic_words = [w for w in re.findall(r"[A-Za-zÄÖÜäöüß0-9]{4,}", topic.lower()) if w]
    if not topic_words:
        return True
    combined = " ".join((c.get("text") or "").lower() for chunks in buckets.values() for c in chunks[:3])
    hits = sum(1 for w in topic_words if w in combined)
    return hits > 0


def _format_evidence_by_bucket(
    buckets: dict[str, list[dict[str, Any]]],
    merged: list[dict[str, Any]],
    doc_names: dict[str, str],
) -> str:
    labels = {_chunk_key(c): _source_label(i, c, doc_names) for i, c in enumerate(merged, 1)}
    parts: list[str] = []
    for name, spec in _EVIDENCE_BUCKETS.items():
        chunks = buckets.get(name, [])
        if not chunks:
            parts.append(f"## {spec['label']}\nNo strong evidence retrieved.")
            continue
        lines = [f"## {spec['label']}"]
        for c in chunks:
            label = labels.get(_chunk_key(c))
            if not label:
                continue
            text = (c.get("text") or "").strip().replace("\r", " ")
            if len(text) > _MAX_CHUNK_CHARS:
                text = text[:_MAX_CHUNK_CHARS] + " ..."
            lines.append(f"[{label}]\n{text}")
        parts.append("\n\n".join(lines))
    return "\n\n---\n\n".join(parts)


def _as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if value in (None, ""):
        return []
    return [value]


def _as_str(value: Any) -> str:
    return str(value or "").strip()


def _normalize_lesson(data: dict[str, Any], topic: str) -> dict[str, Any]:
    worked_raw = data.get("workedExample") if isinstance(data.get("workedExample"), dict) else {}
    legacy_worked = data.get("workedExample") if isinstance(data.get("workedExample"), str) else ""
    lesson = {
        "title": _as_str(data.get("title")) or topic,
        "learningGoal": _as_str(data.get("learningGoal")),
        "intuition": _as_str(data.get("intuition")),
        "coreExplanation": _as_str(data.get("coreExplanation")) or _as_str(data.get("lesson")),
        "keyFormulas": [],
        "stepByStepMethod": [_as_str(x) for x in _as_list(data.get("stepByStepMethod")) if _as_str(x)],
        "workedExample": {
            "problem": _as_str(worked_raw.get("problem")) or legacy_worked,
            "solutionSteps": [_as_str(x) for x in _as_list(worked_raw.get("solutionSteps")) if _as_str(x)],
            "finalAnswer": _as_str(worked_raw.get("finalAnswer")),
            "sourceOrBasis": _as_str(worked_raw.get("sourceOrBasis")),
            "isMiniExample": bool(worked_raw.get("isMiniExample")),
        },
        "commonMistakes": [_as_str(x) for x in _as_list(data.get("commonMistakes")) if _as_str(x)],
        "selfCheck": [],
        "nextTopics": [_as_str(x) for x in _as_list(data.get("nextTopics")) if _as_str(x)],
        "groundedSources": [_as_str(x) for x in _as_list(data.get("groundedSources")) if _as_str(x)],
        "citationWarning": _as_str(data.get("citationWarning")),
    }
    for raw in _as_list(data.get("keyFormulas")):
        if not isinstance(raw, dict):
            continue
        lesson["keyFormulas"].append({
            "formula": _as_str(raw.get("formula")),
            "meaning": _as_str(raw.get("meaning")),
            "variables": _as_str(raw.get("variables")),
            "conditions": _as_str(raw.get("conditions")),
            "source": _as_str(raw.get("source")),
            "commonMistake": _as_str(raw.get("commonMistake")),
        })
    raw_checks = _as_list(data.get("selfCheck"))
    if not raw_checks and isinstance(data.get("check"), dict):
        raw_checks = [data["check"]]
    for raw in raw_checks:
        if not isinstance(raw, dict):
            continue
        q = _as_str(raw.get("question"))
        if q:
            lesson["selfCheck"].append({
                "question": q,
                "answer": _as_str(raw.get("answer")),
                "explanation": _as_str(raw.get("explanation")),
            })
    return lesson


def _valid_source_labels(sources: list[dict[str, Any]]) -> set[str]:
    labels = {str(s.get("label") or "") for s in sources}
    labels.update("Source " + str(s.get("index")) for s in sources)
    return {x for x in labels if x}


def _citation_issues(lesson: dict[str, Any], sources: list[dict[str, Any]]) -> list[str]:
    valid = _valid_source_labels(sources)
    issues: list[str] = []
    for i, f in enumerate(lesson.get("keyFormulas") or [], 1):
        source = _as_str(f.get("source"))
        if not source:
            issues.append(f"Formula {i} has no source.")
            continue
        if not any(v in source for v in valid):
            issues.append(f"Formula {i} cites a source not present in retrieved context.")
    for source in lesson.get("groundedSources") or []:
        if source and not any(v in source for v in valid):
            issues.append("Lesson cites a source not present in retrieved context.")
    return issues


def _lesson_to_legacy_markdown(lesson: dict[str, Any]) -> tuple[str, str, dict[str, str] | None]:
    lesson_md = "\n\n".join(
        part for part in [
            "## Learning Goal\n\n" + lesson.get("learningGoal", ""),
            "## Intuition\n\n" + lesson.get("intuition", ""),
            "## Core Explanation\n\n" + lesson.get("coreExplanation", ""),
        ] if part.strip()
    )
    worked = lesson.get("workedExample") or {}
    worked_md = ""
    if worked.get("problem") or worked.get("solutionSteps"):
        steps = "\n".join(f"{i}. {s}" for i, s in enumerate(worked.get("solutionSteps") or [], 1))
        worked_md = (
            ("**Problem:** " + worked.get("problem", "") + "\n\n" if worked.get("problem") else "")
            + (steps + "\n\n" if steps else "")
            + ("**Final answer:** " + worked.get("finalAnswer", "") + "\n\n" if worked.get("finalAnswer") else "")
            + ("**Source or basis:** " + worked.get("sourceOrBasis", "") if worked.get("sourceOrBasis") else "")
        ).strip()
    checks = lesson.get("selfCheck") or []
    check = checks[0] if checks else None
    return lesson_md, worked_md, check


def _compose_structured_markdown(lesson: dict[str, Any]) -> str:
    parts = [
        f"# {lesson.get('title') or 'Deep Learn'}",
        "## Learning Goal\n\n" + lesson.get("learningGoal", ""),
        "## Intuition\n\n" + lesson.get("intuition", ""),
        "## Core Explanation\n\n" + lesson.get("coreExplanation", ""),
    ]
    formulas = lesson.get("keyFormulas") or []
    if formulas:
        fparts = []
        for f in formulas:
            fparts.append(
                "**Formula:** " + f.get("formula", "") + "\n\n"
                + "**Meaning:** " + f.get("meaning", "") + "\n\n"
                + "**Variables:** " + f.get("variables", "") + "\n\n"
                + "**Use when / conditions:** " + f.get("conditions", "") + "\n\n"
                + ("**Common mistake:** " + f.get("commonMistake", "") + "\n\n" if f.get("commonMistake") else "")
                + "**Source:** " + f.get("source", "")
            )
        parts.append("## Key Formulas\n\n" + "\n\n---\n\n".join(fparts))
    if lesson.get("stepByStepMethod"):
        parts.append("## Step-by-Step Method\n\n" + "\n".join(f"{i}. {s}" for i, s in enumerate(lesson["stepByStepMethod"], 1)))
    worked = lesson.get("workedExample") or {}
    if worked.get("problem") or worked.get("solutionSteps"):
        label = "Mini-example based on formulas above" if worked.get("isMiniExample") else "Worked Example"
        steps = "\n".join(f"{i}. {s}" for i, s in enumerate(worked.get("solutionSteps") or [], 1))
        parts.append(
            f"## {label}\n\n"
            + ("**Problem:** " + worked.get("problem", "") + "\n\n" if worked.get("problem") else "")
            + (steps + "\n\n" if steps else "")
            + ("**Final answer:** " + worked.get("finalAnswer", "") + "\n\n" if worked.get("finalAnswer") else "")
            + ("**Source or basis:** " + worked.get("sourceOrBasis", "") if worked.get("sourceOrBasis") else "")
        )
    if lesson.get("commonMistakes"):
        parts.append("## Common Mistakes\n\n" + "\n".join("- " + x for x in lesson["commonMistakes"]))
    checks = lesson.get("selfCheck") or []
    if checks:
        parts.append(
            "## Self-Check\n\n"
            + "\n\n".join(
                "**Question:** {q}\n\n**Answer:** {a}\n\n**Explanation:** {e}".format(
                    q=c.get("question", ""), a=c.get("answer", ""), e=c.get("explanation", "")
                )
                for c in checks
            )
        )
    if lesson.get("nextTopics"):
        parts.append("## Next Topics\n\n" + "\n".join("- " + x for x in lesson["nextTopics"]))
    if lesson.get("groundedSources"):
        parts.append("## Sources\n\n" + "\n".join("- " + x for x in lesson["groundedSources"]))
    return "\n\n".join(p.strip() for p in parts if p and p.strip())


def _unique_lesson_title(user_id: str, course_id: str, base_title: str) -> str:
    title = (base_title or "Deep Learn").strip()
    try:
        rows = (
            get_supabase().table("notes")
            .select("title")
            .eq("user_id", user_id)
            .eq("course_id", course_id)
            .eq("type", "deep_learn")
            .execute()
        ).data or []
    except Exception:  # noqa: BLE001
        log.exception("deep_learn duplicate-title lookup failed (non-fatal)")
        return title
    existing = {str(r.get("title") or "").strip() for r in rows}
    if title not in existing:
        return title
    version = 2
    while f"{title} — Version {version}" in existing:
        version += 1
    return f"{title} — Version {version}"


def generate_deep_learn(
    *,
    user_id: str,
    course_id: str,
    topic: str,
    document_ids: list[str] | None,
    doc_names: dict[str, str],
    save: bool = True,
) -> dict[str, Any]:
    topic = (topic or "").strip()
    if not topic:
        return {"error": "A topic is required for Deep Learn.", "topic": topic}

    buckets = _retrieve_bucketed_evidence(
        user_id=user_id,
        course_id=course_id,
        topic=topic,
        document_ids=document_ids,
    )
    if not _topic_coverage_ok(topic, buckets):
        return {
            "topic": topic,
            "title": topic,
            "lesson": "",
            "workedExample": "",
            "check": None,
            "structuredLesson": None,
            "warning": "Not enough course material found for this topic. Try uploading the relevant lecture or exercise sheet.",
            "groundedSources": [],
            "evidenceSummary": {k: len(v) for k, v in buckets.items()},
        }

    merged = _merge_evidence(buckets)
    merged_names = _backfill_doc_names(merged, dict(doc_names or {}))
    sources = _sources(merged, merged_names)
    evidence = _format_evidence_by_bucket(buckets, merged, merged_names)

    user = (
        "TOPIC TO TEACH: " + topic + "\n\n"
        "COURSE EVIDENCE. Use only these source labels for citations:\n\n"
        + evidence
    )
    try:
        res = chat_json(system=_SYSTEM, user=user, max_tokens=4200)
    except Exception as e:  # noqa: BLE001
        log.exception("deep_learn generation failed")
        return {"topic": topic, "title": topic, "error": str(e), "groundedSources": sources}

    data = res.data if isinstance(res.data, dict) else {}
    structured = _normalize_lesson(data, topic)
    citation_issues = _citation_issues(structured, sources)
    if citation_issues and not structured.get("citationWarning"):
        structured["citationWarning"] = "Some parts have weak citation coverage: " + "; ".join(citation_issues[:3])

    lesson_md, worked_md, check = _lesson_to_legacy_markdown(structured)
    note_id: str | None = None
    if save and (structured.get("learningGoal") or structured.get("coreExplanation")):
        structured["title"] = _unique_lesson_title(user_id, course_id, structured["title"])
        single_doc = document_ids[0] if document_ids and len(document_ids) == 1 else None
        note_id = save_note(
            user_id=user_id,
            course_id=course_id,
            document_id=single_doc,
            title=structured["title"],
            text=json.dumps({"structuredLesson": structured}, ensure_ascii=False),
            sources=sources,
            note_type="deep_learn",
        )

    return {
        "noteId": note_id,
        "topic": topic,
        "title": structured["title"],
        "lesson": lesson_md,
        "workedExample": worked_md,
        "check": check,
        "structuredLesson": structured,
        "groundedSources": sources,
        "citationWarning": structured.get("citationWarning") or None,
        "evidenceSummary": {k: len(v) for k, v in buckets.items()},
        "model": res.model,
        "promptTokens": res.prompt_tokens,
        "completionTokens": res.completion_tokens,
    }


__all__ = ("generate_deep_learn",)
