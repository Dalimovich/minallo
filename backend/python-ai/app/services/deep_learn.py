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

_EXTRACT_SYSTEM = (
    "You are a fact-extraction engine for university course material. "
    "Given a set of source chunks from a student's uploaded course documents, "
    "extract the structured facts from EACH source. Do not invent information. "
    "Only extract what the source text explicitly states.\n\n"
    "For each source, extract whichever of these fields are present:\n"
    "- topic: the main topic or heading of this chunk\n"
    "- mainClaim: the central statement or thesis\n"
    "- definitions: array of {term, definition} objects\n"
    "- bulletGroups: array of {heading, items[]} — grouped bullet points\n"
    "- comparisonCategories: array of category names if the source compares things\n"
    "- values: array of {name, value, unit, context} — important numbers, ratios, thresholds\n"
    "- formulas: array of {formula, meaning, variables, conditions} — only if clearly stated\n"
    "- processSteps: array of ordered steps if the source describes a procedure\n"
    "- examples: array of {description, context} — examples or case studies mentioned\n"
    "- warnings: array of strings — exceptions, traps, common mistakes, caveats\n"
    "- examRelevance: string — why this matters for an exam, if hinted in the source\n\n"
    "Omit any field that has no content in the source. Keep extracted text close to "
    "the original wording — do not paraphrase heavily. Preserve technical terms, "
    "numbers, units, and names exactly as they appear.\n\n"
    "Return JSON: {\"facts\": [{\"source\": \"<source label>\", ...extracted fields...}]}"
)


_VALID_LESSON_MODES = {
    "simple",
    "exam",
    "professor",
    "application",
    "revision",
}

_MODE_LABELS = {
    "simple": "Simple Explanation",
    "exam": "Exam Preparation",
    "professor": "Professor-style",
    "application": "Practical Application",
    "revision": "Fast Revision",
}

_VALID_LESSON_LANGUAGES = {"same", "de", "en"}

_SYSTEM = (
    "You are Minallo Deep Learn, an adaptive guided tutor for university students.\n"
    "Use ONLY the provided COURSE EVIDENCE. Do not use outside knowledge. Do not invent "
    "professor examples. If an example, case, calculation, code sample, grammar pattern, "
    "timeline, or framework comes from evidence, say which source supports it. If evidence "
    "is thin, stay honest and use a helpful source note rather than sounding weak.\n\n"
    "SOURCE FACT USAGE: When STRUCTURED SOURCE FACTS are provided, you MUST use them as "
    "the primary building blocks for the lesson. These facts were extracted from the "
    "student's actual course material. Use the exact definitions, values, process steps, "
    "formulas, examples, warnings, and comparison categories from the facts — do not "
    "paraphrase them into generic explanations. The lesson should feel like it was built "
    "from the student's specific course material, not from general AI knowledge. "
    "The RAW COURSE EVIDENCE is provided for source labels and additional context.\n\n"
    "Deep Learn has four lesson engines. Your FIRST task is to detect which engine fits "
    "the topic, then follow that engine's structure exactly.\n\n"
    "STEP 1 — Detect lesson engine. Set contentType to one of:\n"
    "- \"math-heavy\" — the main goal is solving problems with formulas, proofs, calculations, "
    "or derivations. Examples: mathematics, physics calculations, mechanics, statistics, "
    "electrical circuits, thermodynamics, control theory.\n"
    "- \"concept-light-math\" — mostly conceptual, but small calculations, tables, values, "
    "ratios, or technical parameters may appear. Examples: Fertigungstechnik, materials science, "
    "manufacturing processes, chemistry theory, economics concepts, business analytics basics, "
    "biology with occasional equations.\n"
    "- \"no-math\" — purely conceptual, no formulas. Student needs to understand, remember, "
    "compare, argue, or explain. Examples: history, law, political science, literature, ethics, "
    "philosophy, language learning, sociology, management theory, marketing.\n"
    "- \"balanced\" — both conceptual theory AND formulas/calculations are central. "
    "Examples: physics theory + calculations, economics, chemistry, engineering science, "
    "computer science theory, data science, finance, materials testing.\n\n"
    "STEP 2 — Follow the engine's block structure:\n\n"
    "═══ ENGINE 1: math-heavy ═══\n"
    "Use keyFormulas with full formula cards (only source-supported and directly relevant). "
    "Use methodGuide to help students pick the right formula/theorem for each situation. "
    "Use workedExamples with complete numeric/symbolic solutions — at least one basic and "
    "one exam-style. Verify every calculation step before returning (CRITICAL: a wrong "
    "example destroys trust). stepByStepMethod must be topic-specific: identify givens, "
    "identify unknowns, choose formula, check assumptions, substitute, solve, check units "
    "and plausibility. Use adaptiveBlocks only if needed. selfCheck should include a mini "
    "calculation. practiceTasks at easy/medium/exam levels.\n\n"
    "═══ ENGINE 2: concept-light-math ═══\n"
    "keyFormulas = [] unless formulas are genuinely central to the topic. Focus on:\n"
    "- adaptiveBlocks with: \"Definition\", \"Classification\", \"Comparison Table\" "
    "(use body field with markdown table — columns like Type|Principle|Application|"
    "Advantage|Disadvantage|Exam clue), \"Selection Criteria\", \"Key Statements\" "
    "(title: \"Prüfungsrelevante Kernaussagen\" or equivalent in lesson language), "
    "\"Process Map\", \"Mechanism\", \"Variants\", \"Conditions\", \"Applications\".\n"
    "- Classification completeness: for classification topics (e.g. DIN 8580), include ALL "
    "groups — do not omit groups because evidence is thin.\n"
    "- Only list specific examples under a group if the source clearly supports it.\n"
    "- Prefer overview sources for classification topics.\n"
    "- Comparison tables are the most exam-valuable block — always include one.\n"
    "- Optional formula/parameter cards only if numeric criteria are truly central.\n"
    "- workedExamples should be application cases (\"Mini-Fallbeispiel\"), not calculations.\n"
    "- stepByStepMethod framed as exam method: define → classify → explain principle → "
    "compare with alternatives → state advantages/disadvantages → justify for the given case.\n"
    "- selfCheck: concept question + classification question + application question.\n\n"
    "═══ ENGINE 3: no-math ═══\n"
    "keyFormulas = [] (always empty). Focus on:\n"
    "- adaptiveBlocks with: \"Key Terms\" (term + definition pairs), \"Context\" "
    "(historical/legal/social/theoretical background), a structure map chosen from: "
    "\"Timeline\", \"Argument Map\", \"Cause-Effect\", \"Rule-Exception\", "
    "\"Concept Hierarchy\", \"Theory Comparison\", \"Process Explanation\". "
    "Also: \"Main Ideas\" (3-6 most important ideas), \"Comparison\" (related concepts, "
    "theories, authors, rules, cases), \"Key Statements\".\n"
    "- Add an adaptiveBlock \"Exam Answer Structure\" showing how to write an exam answer: "
    "1. Define key term, 2. Give context, 3. Explain main idea, 4. Add example/evidence, "
    "5. Compare or evaluate, 6. Conclude clearly.\n"
    "- workedExamples should be short written-answer tasks with model structure.\n"
    "- stepByStepMethod = how to structure a written exam answer for this topic.\n"
    "- selfCheck: definition + comparison + application/argument question.\n\n"
    "═══ ENGINE 4: balanced ═══\n"
    "Combine concept explanation AND formula cards. Focus on:\n"
    "- adaptiveBlocks with: \"Concept Map\" (show how ideas connect, e.g. Concept A → "
    "measured by Formula B → used when Condition C), \"Core Theory\" (definitions, "
    "principles, conditions, assumptions), \"Key Statements\".\n"
    "- keyFormulas: include central formulas with full cards.\n"
    "- methodGuide: when to use concept explanation vs formula calculation vs comparison.\n"
    "- workedExamples: one conceptual, one calculation, one mixed (explain + calculate + "
    "interpret). All exam-style.\n"
    "- stepByStepMethod: 1. Identify question type (explanation/comparison/calculation), "
    "2. If conceptual: define, explain, compare, apply. 3. If calculation: choose formula, "
    "check assumptions, solve. 4. If mixed: explain concept first, then calculate. "
    "5. End with interpretation of result.\n"
    "- selfCheck: concept + formula choice + calculation + interpretation.\n"
    "- practiceTasks: one conceptual, one calculation, one mixed.\n\n"
    "═══ RULES FOR ALL ENGINES ═══\n"
    "CRITICAL: If a topic does not need formulas, do NOT include keyFormulas and do NOT "
    "return text like \"No formula was strongly supported\". Return keyFormulas as [] and "
    "fill adaptiveBlocks with the right subject-specific blocks instead.\n\n"
    "Write like a tutor coaching the student for the exam, not like an encyclopedia. "
    "After explaining a concept, connect it to the exam with inline notes like "
    "\"Merksatz für die Prüfung: ...\" or \"Prüfungsfalle: ...\" in coreExplanation "
    "and keyDetails. This makes the lesson feel like real exam coaching.\n\n"
    "Add an adaptiveBlock \"Exam Questions\" (title in lesson language, e.g. \"Typische "
    "Prüfungsfragen\") with 3-5 professor-style questions, each followed by a model "
    "answer (Musterantwort).\n\n"
    "selfCheck: 2-3 questions with hint, answer, explanation, stepByStep. At least one "
    "applied question (classify, calculate, argue, apply — not just definitional).\n\n"
    "stepByStepMethod must ALWAYS be topic-specific. NEVER return generic steps like "
    "\"Identify the system\", \"Choose the right theorem\", \"List assumptions\".\n\n"
    "Source relevance: only cite sources that directly support the lesson content. Do NOT "
    "cite chapter files about unrelated topics. Only include a source in groundedSources "
    "if the lesson actually references information from it.\n\n"
    "Content type label: write in lesson language. German: \"Formeln & Rechnung\", "
    "\"Konzept & leichte Formeln\", \"Rein konzeptuell\", \"Konzept & Rechnung\". "
    "English: \"Math-heavy\", \"Concept + light math\", \"Conceptual\", \"Balanced\".\n"
    "Lesson mode label: write in lesson language. German: \"Prüfungsvorbereitung\", "
    "\"Einfache Erklärung\", \"Professorstil\", \"Praktische Anwendung\", "
    "\"Schnelle Wiederholung\".\n\n"
    "Formula card rules (calculation topics only):\n"
    "Before returning a formula card, check that the formula is copied correctly, the "
    "meaning explains the formula correctly, the source page supports it, and the formula "
    "is DIRECTLY AND CENTRALLY relevant to the selected topic — not merely from the same "
    "chapter or general area. A formula about rotational dynamics does not belong in a "
    "lesson on linear point-mass dynamics unless labelled as \"related\" with a clear "
    "explanation of the connection. If the formula is nearby but not central, "
    "set relevance to \"related\" and explain the relation briefly in conditions. If it is "
    "uncertain, malformed, or only weakly connected, omit it. A wrong formula is worse than "
    "no formula.\n\n"
    "Citation rules:\n"
    "- Every formula/adaptive block must include a source string copied from one of the source labels.\n"
    "- Every important claim should be grounded in a source label where possible.\n"
    "- Never cite a source label that is not in COURSE EVIDENCE.\n"
    "- If citation coverage is weak, include a helpful citationWarning IN THE LESSON LANGUAGE. "
    "German example: \"Diese Lektion basiert auf den verfügbaren Kursquellen. Falls bestimmte "
    "Beispiele, Übungen oder Details fehlen, lade zusätzliche Materialien hoch, "
    "um die Erklärung genauer zu machen.\" "
    "English example: \"This lesson is based on the available course sources. If specific "
    "examples, exercises, or details are missing, upload additional materials to make the "
    "explanation more precise.\"\n\n"
    "Quality rules:\n"
    "- Keep the ENTIRE lesson in the requested lesson language — including all text, "
    "explanations, labels in meaning/variables/conditions fields, commonMistake text, "
    "and self-check questions. Never mix languages except for original technical terms.\n"
    "- Do not write dead sections like \"No strong course evidence for this section\". "
    "If evidence is incomplete, provide a cautious method inferred from examples and say so.\n"
    "- stepByStepMethod must be TOPIC-SPECIFIC. The subject adaptation section above already "
    "gives detailed step-by-step templates per knowledge type. Follow those. "
    "NEVER return generic steps like \"Identify the system\", \"Choose the right theorem\", "
    "\"List the relevant assumptions\", or \"Substitute values\". These are useless to students.\n\n"
    "Worked example rules (CRITICAL — a wrong example destroys student trust):\n"
    "- Before returning a worked example, RECALCULATE every step yourself. Verify that each "
    "equation follows from the previous one, that force decompositions use the correct "
    "trig functions (sin vs cos), and that the final numeric answer is correct.\n"
    "- For physics: check sign conventions, verify which component is sin vs cos for the "
    "given angle definition, and confirm that initial conditions are correctly applied.\n"
    "- If you cannot verify the calculation with confidence, return it as a practiceTask "
    "instead of a workedExample.\n"
    "- Worked examples must end with a real numeric or symbolic final answer. If the sources "
    "do not support a complete worked example, return it as a practiceTask instead.\n"
    "- Stay focused on the selected topic. Related concepts are allowed only when labelled "
    "as related and when their relation is explained.\n\n"
    "Return ONLY JSON with exactly this shape:\n"
    "{"
    '"title":"","subjectArea":"","contentType":"","lessonMode":"","learningGoal":"",'
    '"bigPicture":"","simpleExplanation":"","coreExplanation":"","keyDetails":[""],'
    '"keyFormulas":[{"formula":"","meaning":"","variables":"","conditions":"","source":"","commonMistake":"","relevance":"","confidence":""}],'
    '"methodGuide":[{"method":"","useWhen":"","avoidWhen":"","source":""}],'
    '"adaptiveBlocks":[{"type":"","title":"","body":"","items":[""],"source":""}],'
    '"workedExamples":[{"title":"","problem":"","solutionSteps":[""],"finalAnswer":"","sourceOrBasis":"","difficulty":"","isMiniExample":false}],'
    '"commonMistakes":[""],"examTraps":[""],'
    '"selfCheck":[{"question":"","hint":"","answer":"","explanation":"","stepByStep":[""]}],'
    '"practiceTasks":[{"prompt":"","goal":"","source":""}],'
    '"nextStep":"","nextTopics":[""],'
    '"groundedSources":[""],'
    '"citationWarning":""'
    "}"
)


def _lesson_mode(value: str | None) -> str:
    mode = (value or "exam").strip().lower()
    return mode if mode in _VALID_LESSON_MODES else "exam"


def _lesson_language(value: str | None) -> str:
    lang = (value or "same").strip().lower()
    if lang in {"german", "deutsch"}:
        return "de"
    if lang in {"english", "englisch"}:
        return "en"
    return lang if lang in _VALID_LESSON_LANGUAGES else "same"


def _language_prompt(language: str) -> str:
    return {
        "de": "LESSON LANGUAGE: German. Write all headings, explanations, examples, and self-checks in German.",
        "en": "LESSON LANGUAGE: English. Write all headings, explanations, examples, and self-checks in English.",
        "same": (
            "LESSON LANGUAGE: Same as the course evidence. If most course evidence is German, "
            "write the lesson in German; if most evidence is English, write it in English. "
            "Do not mix languages except for original technical terms from sources."
        ),
    }.get(language, "")


def _infer_language_from_evidence(topic: str, chunks: list[dict[str, Any]]) -> str:
    sample = (topic + " " + " ".join(_as_str(c.get("text"))[:600] for c in chunks[:8])).lower()
    german_markers = (
        " der ", " die ", " das ", " und ", " nicht ", " kraft", " kraefte", " koerper",
        " punktmasse", " arbeitssatz", " geschwindigkeit", " beschleunigung", " aufgabe",
        " loesung", " gegeben", " gesucht", " ueber", " fuer",
    )
    english_markers = (
        " the ", " and ", " of ", " force", " velocity", " acceleration", " problem",
        " solution", " given", " find", " theorem", " definition",
    )
    de_score = sum(sample.count(x) for x in german_markers) + len(re.findall(r"[äöüß]", sample))
    en_score = sum(sample.count(x) for x in english_markers)
    return "de" if de_score >= en_score else "en"


def _effective_language(language: str, topic: str, chunks: list[dict[str, Any]]) -> str:
    return _infer_language_from_evidence(topic, chunks) if language == "same" else language


def _mode_prompt(mode: str) -> str:
    return {
        "simple": (
            "LESSON MODE: Simple Explanation. Prioritize intuition, plain language, "
            "short examples, and beginner-friendly self-checks."
        ),
        "exam": (
            "LESSON MODE: Exam Preparation. Prioritize exam relevance, common traps, "
            "method selection, active self-checks, and source-grounded practice."
        ),
        "professor": (
            "LESSON MODE: Professor-style. Use precise university language, conditions, "
            "edge cases, and a deeper application or case when the evidence supports it."
        ),
        "application": (
            "LESSON MODE: Practical Application. Prioritize real use cases, procedures, "
            "decision logic, examples, and transfer tasks."
        ),
        "revision": (
            "LESSON MODE: Fast Revision. Be compact, high-signal, checklist-like, and "
            "focus on what to remember before a quiz or exam."
        ),
    }.get(mode, "")


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


def _extract_source_facts(
    topic: str,
    evidence_text: str,
) -> list[dict[str, Any]]:
    """Run a lightweight LLM pass to extract structured facts from evidence."""
    user = (
        "TOPIC: " + topic + "\n\n"
        "SOURCE CHUNKS:\n\n" + evidence_text
    )
    try:
        res = chat_json(system=_EXTRACT_SYSTEM, user=user, max_tokens=3000)
        data = res.data if isinstance(res.data, dict) else {}
        facts = data.get("facts", [])
        if isinstance(facts, list):
            return [f for f in facts if isinstance(f, dict)]
    except Exception:  # noqa: BLE001
        log.exception("source fact extraction failed for topic=%s", topic)
    return []


def _format_extracted_facts(facts: list[dict[str, Any]]) -> str:
    """Serialize extracted facts into a structured text block for the lesson prompt."""
    if not facts:
        return ""
    parts: list[str] = []
    for f in facts:
        source = f.get("source", "unknown")
        lines = [f"### [{source}]"]
        if f.get("topic"):
            lines.append(f"Topic: {f['topic']}")
        if f.get("mainClaim"):
            lines.append(f"Main claim: {f['mainClaim']}")
        for d in f.get("definitions") or []:
            if isinstance(d, dict):
                lines.append(f"Definition: {d.get('term', '')} — {d.get('definition', '')}")
        for bg in f.get("bulletGroups") or []:
            if isinstance(bg, dict):
                heading = bg.get("heading", "")
                items = bg.get("items", [])
                if heading:
                    lines.append(f"Group: {heading}")
                for item in (items if isinstance(items, list) else []):
                    lines.append(f"  • {item}")
        if f.get("comparisonCategories"):
            lines.append("Comparison categories: " + ", ".join(str(c) for c in f["comparisonCategories"]))
        for v in f.get("values") or []:
            if isinstance(v, dict):
                val_str = f"{v.get('name', '')}: {v.get('value', '')} {v.get('unit', '')}"
                if v.get("context"):
                    val_str += f" ({v['context']})"
                lines.append(f"Value: {val_str}")
        for fm in f.get("formulas") or []:
            if isinstance(fm, dict):
                lines.append(f"Formula: {fm.get('formula', '')} — {fm.get('meaning', '')}")
                if fm.get("variables"):
                    lines.append(f"  Variables: {fm['variables']}")
                if fm.get("conditions"):
                    lines.append(f"  Conditions: {fm['conditions']}")
        if f.get("processSteps"):
            lines.append("Process steps:")
            for i, step in enumerate(f["processSteps"], 1):
                lines.append(f"  {i}. {step}")
        for ex in f.get("examples") or []:
            if isinstance(ex, dict):
                lines.append(f"Example: {ex.get('description', '')} ({ex.get('context', '')})")
            elif isinstance(ex, str):
                lines.append(f"Example: {ex}")
        for w in f.get("warnings") or []:
            lines.append(f"Warning: {w}")
        if f.get("examRelevance"):
            lines.append(f"Exam relevance: {f['examRelevance']}")
        parts.append("\n".join(lines))
    return "\n\n".join(parts)


def _as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if value in (None, ""):
        return []
    return [value]


def _as_str(value: Any) -> str:
    return str(value or "").strip()


def _normalize_lesson(data: dict[str, Any], topic: str, lesson_mode: str = "exam") -> dict[str, Any]:
    worked_raw = data.get("workedExample") if isinstance(data.get("workedExample"), dict) else {}
    legacy_worked = data.get("workedExample") if isinstance(data.get("workedExample"), str) else ""
    worked_examples_raw = _as_list(data.get("workedExamples"))
    if not worked_examples_raw and (worked_raw or legacy_worked):
        worked_examples_raw = [worked_raw or {"problem": legacy_worked}]
    lesson = {
        "title": _as_str(data.get("title")) or topic,
        "subjectArea": _as_str(data.get("subjectArea")),
        "contentType": _as_str(data.get("contentType")),
        "lessonMode": _as_str(data.get("lessonMode")) or _MODE_LABELS.get(lesson_mode, "Exam Preparation"),
        "learningGoal": _as_str(data.get("learningGoal")),
        "bigPicture": _as_str(data.get("bigPicture")),
        "simpleExplanation": _as_str(data.get("simpleExplanation")),
        "intuition": _as_str(data.get("intuition")) or _as_str(data.get("simpleExplanation")),
        "coreExplanation": _as_str(data.get("coreExplanation")) or _as_str(data.get("lesson")),
        "keyDetails": [_as_str(x) for x in _as_list(data.get("keyDetails")) if _as_str(x)],
        "keyFormulas": [],
        "methodGuide": [],
        "adaptiveBlocks": [],
        "stepByStepMethod": [_as_str(x) for x in _as_list(data.get("stepByStepMethod")) if _as_str(x)],
        "workedExamples": [],
        "workedExample": {
            "problem": _as_str(worked_raw.get("problem")) or legacy_worked,
            "solutionSteps": [_as_str(x) for x in _as_list(worked_raw.get("solutionSteps")) if _as_str(x)],
            "finalAnswer": _as_str(worked_raw.get("finalAnswer")),
            "sourceOrBasis": _as_str(worked_raw.get("sourceOrBasis")),
            "isMiniExample": bool(worked_raw.get("isMiniExample")),
        },
        "commonMistakes": [_as_str(x) for x in _as_list(data.get("commonMistakes")) if _as_str(x)],
        "examTraps": [_as_str(x) for x in _as_list(data.get("examTraps")) if _as_str(x)],
        "selfCheck": [],
        "practiceTasks": [],
        "nextStep": _as_str(data.get("nextStep")),
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
            "relevance": _as_str(raw.get("relevance")),
            "confidence": _as_str(raw.get("confidence")),
        })
    for raw in _as_list(data.get("methodGuide")):
        if not isinstance(raw, dict):
            continue
        method = _as_str(raw.get("method"))
        if method:
            lesson["methodGuide"].append({
                "method": method,
                "useWhen": _as_str(raw.get("useWhen")),
                "avoidWhen": _as_str(raw.get("avoidWhen")),
                "source": _as_str(raw.get("source")),
            })
    for raw in _as_list(data.get("adaptiveBlocks")):
        if not isinstance(raw, dict):
            continue
        title = _as_str(raw.get("title"))
        body = _as_str(raw.get("body"))
        items = [_as_str(x) for x in _as_list(raw.get("items")) if _as_str(x)]
        if title or body or items:
            lesson["adaptiveBlocks"].append({
                "type": _as_str(raw.get("type")),
                "title": title or _as_str(raw.get("type")) or "Learning block",
                "body": body,
                "items": items,
                "source": _as_str(raw.get("source")),
            })
    for raw in worked_examples_raw:
        if not isinstance(raw, dict):
            continue
        problem = _as_str(raw.get("problem"))
        steps = [_as_str(x) for x in _as_list(raw.get("solutionSteps")) if _as_str(x)]
        if problem or steps:
            lesson["workedExamples"].append({
                "title": _as_str(raw.get("title")) or ("Mini-example" if raw.get("isMiniExample") else "Example"),
                "problem": problem,
                "solutionSteps": steps,
                "finalAnswer": _as_str(raw.get("finalAnswer")),
                "sourceOrBasis": _as_str(raw.get("sourceOrBasis")),
                "difficulty": _as_str(raw.get("difficulty")),
                "isMiniExample": bool(raw.get("isMiniExample")),
            })
    if lesson["workedExamples"] and not (lesson["workedExample"]["problem"] or lesson["workedExample"]["solutionSteps"]):
        first = lesson["workedExamples"][0]
        lesson["workedExample"] = {
            "problem": first.get("problem", ""),
            "solutionSteps": first.get("solutionSteps", []),
            "finalAnswer": first.get("finalAnswer", ""),
            "sourceOrBasis": first.get("sourceOrBasis", ""),
            "isMiniExample": bool(first.get("isMiniExample")),
        }
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
                "hint": _as_str(raw.get("hint")),
                "answer": _as_str(raw.get("answer")),
                "explanation": _as_str(raw.get("explanation")),
                "stepByStep": [_as_str(x) for x in _as_list(raw.get("stepByStep")) if _as_str(x)],
            })
    for raw in _as_list(data.get("practiceTasks")):
        if not isinstance(raw, dict):
            continue
        prompt = _as_str(raw.get("prompt"))
        if prompt:
            lesson["practiceTasks"].append({
                "prompt": prompt,
                "goal": _as_str(raw.get("goal")),
                "source": _as_str(raw.get("source")),
            })
    return lesson


def _topic_words(topic: str) -> set[str]:
    words = {
        w.lower()
        for w in re.findall(r"[A-Za-zÀ-ÖØ-öø-ÿ0-9]{3,}", topic or "")
        if w.lower() not in {"der", "die", "das", "und", "von", "mit", "for", "the", "and", "aus"}
    }
    stems: set[str] = set()
    for w in words:
        stems.add(w)
        if len(w) > 5:
            stems.add(w[:5])
    return stems


def _source_text_by_label(chunks: list[dict[str, Any]], doc_names: dict[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for i, c in enumerate(chunks, 1):
        label = _source_label(i, c, doc_names)
        text = _as_str(c.get("text"))
        out[label] = text
        out["Source " + str(i)] = text
    return out


def _source_text_for(source: str, source_texts: dict[str, str]) -> str:
    source = _as_str(source)
    for label, text in source_texts.items():
        if label and label in source:
            return text
    return ""


def _formula_symbols(formula: str) -> set[str]:
    return {
        token.lower()
        for token in re.findall(r"[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ0-9_]*", formula or "")
        if len(token) <= 12
    }


def _looks_malformed_formula(formula: str) -> bool:
    f = _as_str(formula)
    if not f or "=" not in f:
        return True
    if re.search(r"=\s*[A-Za-zÀ-ÖØ-öø-ÿ]\w*\s+[A-Za-zÀ-ÖØ-öø-ÿ]\w*\s*$", f):
        return True
    if re.search(r"\b[A-Za-z]\s+[A-Za-z]\b", f) and not re.search(r"(sin|cos|tan|log|ln|min|max)\s+[A-Za-z]", f, re.I):
        return True
    return False


def _source_supports_formula(formula: str, source_text: str) -> bool:
    if not source_text:
        return False
    normalized_formula = re.sub(r"\s+", "", formula.lower())
    normalized_source = re.sub(r"\s+", "", source_text.lower())
    if normalized_formula and normalized_formula in normalized_source:
        return True
    symbols = {s for s in _formula_symbols(formula) if len(s) > 1 or s in {"t", "v", "a", "f", "m", "w", "e"}}
    if not symbols:
        return False
    source_lower = source_text.lower()
    hits = sum(1 for sym in symbols if sym in source_lower)
    return hits >= max(1, min(3, len(symbols)))


def _text_has_topic_overlap(text: str, topic_words: set[str]) -> bool:
    if not topic_words:
        return True
    lower = (text or "").lower()
    return any(w in lower for w in topic_words)


def _is_dead_evidence_text(text: str) -> bool:
    lower = _as_str(text).lower()
    return (
        not lower
        or "no strong course evidence" in lower
        or "no strong evidence" in lower
        or "not enough course material" in lower
        or "keine ausreich" in lower
    )


def _is_incomplete_final_answer(text: str) -> bool:
    lower = _as_str(text).lower().strip()
    if not lower:
        return True
    return any(
        phrase in lower
        for phrase in (
            "calculate the",
            "find the",
            "solve for",
            "to be calculated",
            "determine the",
            "berechne",
            "zu berechnen",
            "bestimme",
        )
    )


def _fallback_method(topic: str, language: str, content_type: str = "") -> list[str]:
    ct = (content_type or "").lower().replace(" ", "-").replace("&", "").replace("+", "")
    is_de = language != "en"
    if "math-heavy" in ct or "formeln" in ct:
        if is_de:
            return [
                "Identifiziere die gegebenen Größen und die gesuchte Unbekannte.",
                "Wähle die passende Formel oder den richtigen Satz.",
                "Prüfe die Voraussetzungen und Annahmen.",
                "Setze die Werte ein und löse Schritt für Schritt.",
                "Prüfe Einheiten und Plausibilität des Ergebnisses.",
            ]
        return [
            "Identify the given quantities and the unknown to solve for.",
            "Choose the correct formula or theorem.",
            "Check the assumptions and prerequisites.",
            "Substitute the values and solve step by step.",
            "Check units and plausibility of the result.",
        ]
    if "concept-light-math" in ct or "konzept  leichte" in ct or "concept  light" in ct:
        if is_de:
            return [
                "Definiere den Begriff und ordne ihn in die Klassifikation ein.",
                "Erkläre das Grundprinzip oder den Mechanismus.",
                "Vergleiche mit verwandten Verfahren oder Konzepten.",
                "Nenne Vorteile, Nachteile und typische Anwendungen.",
                "Begründe die Wahl für ein konkretes Szenario (Prüfungsantwort).",
            ]
        return [
            "Define the term and classify it within its system.",
            "Explain the underlying principle or mechanism.",
            "Compare with related processes or concepts.",
            "State advantages, disadvantages, and typical applications.",
            "Justify the choice for a concrete scenario (exam answer).",
        ]
    if "no-math" in ct or "rein konzept" in ct or "conceptual" in ct:
        if is_de:
            return [
                "Definiere den Schlüsselbegriff.",
                "Gib den Kontext (historisch, rechtlich, theoretisch).",
                "Erkläre die Hauptidee oder das zentrale Argument.",
                "Belege mit einem Beispiel oder einer Quelle.",
                "Vergleiche oder bewerte und formuliere ein Fazit.",
            ]
        return [
            "Define the key term.",
            "Give the context (historical, legal, theoretical).",
            "Explain the main idea or central argument.",
            "Support with an example or source.",
            "Compare or evaluate and formulate a conclusion.",
        ]
    if "balanced" in ct or "konzept  rechnung" in ct:
        if is_de:
            return [
                "Bestimme den Fragetyp: Erklärung, Vergleich oder Berechnung.",
                "Falls konzeptuell: definiere, erkläre, vergleiche, wende an.",
                "Falls Berechnung: wähle Formel, prüfe Annahmen, löse.",
                "Falls gemischt: erkläre das Konzept, dann rechne.",
                "Interpretiere das Ergebnis im Kontext der Aufgabe.",
            ]
        return [
            "Determine the question type: explanation, comparison, or calculation.",
            "If conceptual: define, explain, compare, apply.",
            "If calculation: choose formula, check assumptions, solve.",
            "If mixed: explain the concept first, then calculate.",
            "Interpret the result in the context of the task.",
        ]
    if is_de:
        return [
            "Identifiziere das Kernkonzept und seine Definition aus den Quellen.",
            "Verstehe die Bedingungen oder den Kontext, in dem es gilt.",
            "Arbeite ein Beispiel oder eine Anwendung Schritt für Schritt durch.",
            "Prüfe auf häufige Fehler oder Sonderfälle.",
            "Überprüfe dein Verständnis anhand der ursprünglichen Fragestellung zu " + topic + ".",
        ]
    return [
        "Identify the core concept and its definition from the sources.",
        "Understand the conditions or context where it applies.",
        "Work through an example or application step by step.",
        "Check for common mistakes or edge cases.",
        "Verify your understanding against the original " + topic + " question.",
    ]


def _filter_cited_sources(lesson: dict[str, Any], sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    lesson_text = json.dumps(lesson, ensure_ascii=False).lower()
    cited: list[dict[str, Any]] = []
    for s in sources:
        label = str(s.get("label") or "")
        short = "source " + str(s.get("index", ""))
        if label.lower() in lesson_text or short.lower() in lesson_text:
            cited.append(s)
    return cited if cited else sources[:6]


def _citation_warning(language: str) -> str:
    if language == "en":
        return (
            "This lesson is based on the available course sources. If specific examples, "
            "exercises, or details are missing, upload additional materials to make the "
            "explanation more precise."
        )
    return (
        "Diese Lektion basiert auf den verfügbaren Kursquellen. Falls bestimmte "
        "Beispiele, Übungen oder Details fehlen, lade zusätzliche Materialien hoch, "
        "um die Erklärung genauer zu machen."
    )


def _formula_warning(language: str) -> str:
    if language == "en":
        return (
            "Some formula cards were hidden because the available sources did not support "
            "their exact notation, meaning, or direct relevance strongly enough."
        )
    return (
        "Einige Formelkarten wurden ausgeblendet, weil Schreibweise, Bedeutung oder direkte "
        "Relevanz durch die verfügbaren Quellen nicht sicher genug gestützt waren."
    )


def _validate_lesson_content(
    lesson: dict[str, Any],
    *,
    topic: str,
    sources: list[dict[str, Any]],
    source_texts: dict[str, str],
    language: str,
) -> None:
    valid_sources = _valid_source_labels(sources)
    topic_words = _topic_words(topic)
    hidden_formula_count = 0
    formulas: list[dict[str, Any]] = []

    for formula in lesson.get("keyFormulas") or []:
        raw_formula = _as_str(formula.get("formula"))
        source = _as_str(formula.get("source"))
        if (
            _looks_malformed_formula(raw_formula)
            or not source
            or not any(v in source for v in valid_sources)
            or not _source_supports_formula(raw_formula, _source_text_for(source, source_texts))
        ):
            hidden_formula_count += 1
            continue
        relevance_text = " ".join([
            raw_formula,
            _as_str(formula.get("meaning")),
            _as_str(formula.get("conditions")),
            _source_text_for(source, source_texts),
        ])
        if _text_has_topic_overlap(relevance_text, topic_words):
            formula["relevance"] = formula.get("relevance") or "core"
        else:
            formula["relevance"] = "related"
            if language == "en":
                note = "Related concept; use only if the source explicitly connects it to this topic."
            else:
                note = "Verwandtes Konzept; nur verwenden, wenn die Quelle es ausdrücklich mit diesem Thema verbindet."
            formula["conditions"] = (_as_str(formula.get("conditions")) + (" " if formula.get("conditions") else "") + note).strip()
        formula["confidence"] = formula.get("confidence") or "checked"
        formulas.append(formula)
    lesson["keyFormulas"] = formulas

    if hidden_formula_count:
        warning = _formula_warning(language)
        if lesson.get("citationWarning"):
            if warning not in lesson["citationWarning"]:
                lesson["citationWarning"] += " " + warning
        else:
            lesson["citationWarning"] = warning

    lesson["stepByStepMethod"] = [
        step for step in (lesson.get("stepByStepMethod") or [])
        if not _is_dead_evidence_text(step)
    ]
    if not lesson["stepByStepMethod"]:
        lesson["stepByStepMethod"] = _fallback_method(topic, language, lesson.get("contentType", ""))

    complete_examples: list[dict[str, Any]] = []
    for ex in lesson.get("workedExamples") or []:
        if _is_incomplete_final_answer(ex.get("finalAnswer", "")):
            prompt = _as_str(ex.get("problem")) or _as_str(ex.get("title")) or topic
            if prompt:
                lesson["practiceTasks"].append({
                    "prompt": prompt,
                    "goal": "Complete the symbolic or numeric final answer." if language == "en" else "Ergänze das symbolische oder numerische Endergebnis.",
                    "source": _as_str(ex.get("sourceOrBasis")),
                })
            continue
        complete_examples.append(ex)
    lesson["workedExamples"] = complete_examples
    first = complete_examples[0] if complete_examples else None
    lesson["workedExample"] = {
        "problem": first.get("problem", "") if first else "",
        "solutionSteps": first.get("solutionSteps", []) if first else [],
        "finalAnswer": first.get("finalAnswer", "") if first else "",
        "sourceOrBasis": first.get("sourceOrBasis", "") if first else "",
        "isMiniExample": bool(first.get("isMiniExample")) if first else False,
    }


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
    for i, block in enumerate(lesson.get("adaptiveBlocks") or [], 1):
        source = _as_str(block.get("source"))
        if source and not any(v in source for v in valid):
            issues.append(f"Adaptive block {i} cites a source not present in retrieved context.")
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
        "## Big Picture\n\n" + lesson.get("bigPicture", ""),
        "## Simple Explanation\n\n" + lesson.get("simpleExplanation", ""),
        "## Intuition\n\n" + lesson.get("intuition", ""),
        "## Core Explanation\n\n" + lesson.get("coreExplanation", ""),
    ]
    if lesson.get("keyDetails"):
        parts.append("## Key Details from Your Sources\n\n" + "\n".join("- " + x for x in lesson["keyDetails"]))
    formulas = lesson.get("keyFormulas") or []
    if formulas:
        fparts = []
        for f in formulas:
            fparts.append(
                "**Formula:** " + f.get("formula", "") + "\n\n"
                + "**Meaning:** " + f.get("meaning", "") + "\n\n"
                + "**Variables:** " + f.get("variables", "") + "\n\n"
                + "**Use when / conditions:** " + f.get("conditions", "") + "\n\n"
                + ("**Relevance:** " + f.get("relevance", "") + "\n\n" if f.get("relevance") else "")
                + ("**Confidence:** " + f.get("confidence", "") + "\n\n" if f.get("confidence") else "")
                + ("**Common mistake:** " + f.get("commonMistake", "") + "\n\n" if f.get("commonMistake") else "")
                + "**Source:** " + f.get("source", "")
            )
        parts.append("## Key Formulas\n\n" + "\n\n---\n\n".join(fparts))
    if lesson.get("methodGuide"):
        rows = []
        for m in lesson["methodGuide"]:
            rows.append(
                "**" + m.get("method", "") + "**\n\n"
                + ("Use when: " + m.get("useWhen", "") + "\n\n" if m.get("useWhen") else "")
                + ("Avoid when: " + m.get("avoidWhen", "") + "\n\n" if m.get("avoidWhen") else "")
                + ("Source: " + m.get("source", "") if m.get("source") else "")
            )
        parts.append("## Which Method Should I Use?\n\n" + "\n\n---\n\n".join(rows))
    for block in lesson.get("adaptiveBlocks") or []:
        body = block.get("body", "")
        items = block.get("items") or []
        content = body
        if items:
            content += ("\n\n" if content else "") + "\n".join("- " + x for x in items)
        if block.get("source"):
            content += ("\n\n" if content else "") + "**Source:** " + block.get("source", "")
        if content.strip():
            parts.append("## " + (block.get("title") or "Learning Block") + "\n\n" + content)
    if lesson.get("stepByStepMethod"):
        parts.append("## Step-by-Step Method\n\n" + "\n".join(f"{i}. {s}" for i, s in enumerate(lesson["stepByStepMethod"], 1)))
    for worked in (lesson.get("workedExamples") or ([lesson.get("workedExample") or {}])):
        if not (worked.get("problem") or worked.get("solutionSteps")):
            continue
        label = worked.get("title") or ("Mini-example" if worked.get("isMiniExample") else "Worked Example")
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
    if lesson.get("examTraps"):
        parts.append("## Exam Traps\n\n" + "\n".join("- " + x for x in lesson["examTraps"]))
    checks = lesson.get("selfCheck") or []
    if checks:
        parts.append(
            "## Self-Check\n\n"
            + "\n\n".join(
                "**Question:** {q}\n\n**Hint:** {h}\n\n**Answer:** {a}\n\n**Explanation:** {e}".format(
                    q=c.get("question", ""), h=c.get("hint", ""), a=c.get("answer", ""), e=c.get("explanation", "")
                )
                for c in checks
            )
        )
    if lesson.get("practiceTasks"):
        parts.append(
            "## Practice Tasks\n\n"
            + "\n\n".join(
                "**Task:** {p}\n\n{g}{s}".format(
                    p=t.get("prompt", ""),
                    g=("Goal: " + t.get("goal", "") + "\n\n" if t.get("goal") else ""),
                    s=("Source: " + t.get("source", "") if t.get("source") else ""),
                )
                for t in lesson["practiceTasks"]
            )
        )
    if lesson.get("nextStep"):
        parts.append("## Next Step\n\n" + lesson["nextStep"])
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
    lesson_mode: str | None = None,
    lesson_language: str | None = None,
    save: bool = True,
) -> dict[str, Any]:
    topic = (topic or "").strip()
    if not topic:
        return {"error": "A topic is required for Deep Learn.", "topic": topic}
    mode = _lesson_mode(lesson_mode)
    language = _lesson_language(lesson_language)

    buckets = _retrieve_bucketed_evidence(
        user_id=user_id,
        course_id=course_id,
        topic=topic,
        document_ids=document_ids,
    )
    all_chunks = [c for chunks in buckets.values() for c in chunks]
    effective_language = _effective_language(language, topic, all_chunks)

    if not _topic_coverage_ok(topic, buckets):
        return {
            "topic": topic,
            "title": topic,
            "lesson": "",
            "workedExample": "",
            "check": None,
            "structuredLesson": None,
            "warning": _citation_warning(effective_language),
            "groundedSources": [],
            "evidenceSummary": {k: len(v) for k, v in buckets.items()},
        }

    merged = _merge_evidence(buckets)
    merged_names = _backfill_doc_names(merged, dict(doc_names or {}))
    sources = _sources(merged, merged_names)
    evidence = _format_evidence_by_bucket(buckets, merged, merged_names)

    extracted_facts = _extract_source_facts(topic, evidence)
    facts_text = _format_extracted_facts(extracted_facts)

    user = (
        "TOPIC TO TEACH: " + topic + "\n\n"
        + _mode_prompt(mode) + "\n\n"
        + _language_prompt(language) + "\n\n"
    )
    if facts_text:
        user += (
            "STRUCTURED SOURCE FACTS (extracted from the student's course material — "
            "use these specific details, definitions, values, steps, and comparisons "
            "to build the lesson):\n\n"
            + facts_text + "\n\n"
            "RAW COURSE EVIDENCE (for source labels and additional context):\n\n"
            + evidence
        )
    else:
        user += (
            "COURSE EVIDENCE. Use only these source labels for citations:\n\n"
            + evidence
        )
    try:
        res = chat_json(system=_SYSTEM, user=user, max_tokens=4200)
    except Exception as e:  # noqa: BLE001
        log.exception("deep_learn generation failed")
        return {"topic": topic, "title": topic, "error": str(e), "groundedSources": sources}

    data = res.data if isinstance(res.data, dict) else {}
    structured = _normalize_lesson(data, topic, mode)
    structured["lessonLanguage"] = effective_language
    _validate_lesson_content(
        structured,
        topic=topic,
        sources=sources,
        source_texts=_source_text_by_label(merged, merged_names),
        language=effective_language,
    )
    citation_issues = _citation_issues(structured, sources)
    if citation_issues and not structured.get("citationWarning"):
        structured["citationWarning"] = _citation_warning(effective_language)

    sources = _filter_cited_sources(structured, sources)
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
        "factsExtracted": len(extracted_facts),
        "model": res.model,
        "promptTokens": res.prompt_tokens,
        "completionTokens": res.completion_tokens,
    }


__all__ = ("generate_deep_learn",)
