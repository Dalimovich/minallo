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
    "Deep Learn must work for any course, not only STEM. Your FIRST task is to detect the "
    "KNOWLEDGE TYPE of the topic from the evidence, then choose teaching blocks that fit.\n\n"
    "STEP 1 — Detect knowledge type. Set contentType to one of:\n"
    "- \"calculation\" — physics, math, engineering mechanics, statistics (needs formulas + worked examples)\n"
    "- \"process-classification\" — broad classification/overview topics in manufacturing etc. "
    "(e.g. \"Einteilung der Fertigungsverfahren\", \"Fertigungshauptgruppen nach DIN 8580\", "
    "\"Urformen vs. Umformen\"). Needs: full group listing, comparison tables, classification exercises.\n"
    "- \"process-detail\" — a SPECIFIC process or technique within manufacturing, chemistry, etc. "
    "(e.g. \"Löten\", \"Schweißen\", \"Sintern\", \"MIG-Schweißen\", \"Walzen\"). "
    "Needs: mechanism/principle, conditions, variants, comparison with alternatives, applications. "
    "Do NOT use process-classification for a single specific process.\n"
    "- \"conceptual\" — law, business, economics, political science "
    "(needs definitions, frameworks, case reasoning, decision criteria)\n"
    "- \"narrative\" — history, literature, social science "
    "(needs timelines, causes/consequences, key actors, interpretations)\n"
    "- \"language\" — grammar, vocabulary, translation "
    "(needs rules, examples, common mistakes, practice sentences)\n"
    "- \"descriptive-science\" — biology, medicine, anatomy "
    "(needs process explanations, structure/function, cause-effect, comparison tables)\n\n"
    "STEP 2 — Choose blocks based on knowledge type:\n\n"
    "For \"calculation\" topics:\n"
    "- Use keyFormulas (only if directly relevant and source-supported)\n"
    "- Use workedExamples with full numeric/symbolic solutions\n"
    "- stepByStepMethod = topic-specific calculation method\n\n"
    "For \"process-classification\" topics (e.g. Fertigungstechnik: Urformen, Umformen, "
    "Trennen, Fügen, Beschichten, Stoffeigenschaften ändern, and their sub-processes):\n"
    "- keyFormulas = [] (empty! do NOT include formulas)\n"
    "- Classification completeness: When teaching a classification topic (e.g. Einteilung der "
    "Fertigungsverfahren), always include ALL main groups from the standard (DIN 8580 has 6: "
    "Urformen, Umformen, Trennen, Fügen, Beschichten, Stoffeigenschaften ändern). Do not omit "
    "groups just because evidence is thin — list all groups and mark unsupported ones as "
    "\"not covered in the available sources\".\n"
    "- Example accuracy: Only list specific procedures (e.g. Gießen, Walzen, Spanen) under a "
    "manufacturing group if the course source CLEARLY classifies them there. If confidence is "
    "low, prefix with \"Beispiele aus den Quellen: ...\" instead of presenting as universal fact.\n"
    "- Source preference: For overview/classification topics, prefer source pages about DIN 8580, "
    "Fertigungshauptgruppen, or Übersicht Fertigungsverfahren over specialized chapter sources.\n"
    "- Use adaptiveBlocks with these types:\n"
    "  * \"Definition\" — what the process group is, DIN classification\n"
    "  * \"Classification\" — subgroups, material states, process variants. For each group, "
    "state: name, what happens to the material/Stoffzusammenhalt, and source-supported examples.\n"
    "  * \"Comparison Table\" — STRUCTURED table with columns: Hauptgruppe/Verfahren, Grundidee, "
    "Stoffzusammenhalt, Beispiele, typische Prüfungsfrage. Use the \"body\" field with a "
    "markdown table. This is the most exam-valuable block for classification topics.\n"
    "  * \"Process Map\" — steps of a specific procedure\n"
    "  * \"Key Statements\" — exam-relevant core facts (title: \"Prüfungsrelevante Kernaussagen\" "
    "or \"Exam-Relevant Key Statements\")\n"
    "  * \"Selection Criteria\" — how to choose the right process for a given part\n"
    "- methodGuide format: use \"useWhen\" for exam question types this method answers, "
    "and \"avoidWhen\" for question types that need a different approach. Example:\n"
    "  useWhen: \"Prüfungsfragen zur Einteilung und zum Vergleich von Fertigungsverfahren\"\n"
    "  avoidWhen: \"Konkrete Verfahrensauswahl für ein Bauteil — dafür Werkstoff, Geometrie, "
    "Stückzahl, Kosten und Genauigkeit zusätzlich prüfen\"\n"
    "- stepByStepMethod for process classification:\n"
    "  1. Define the manufacturing group (Fertigungshauptgruppe)\n"
    "  2. Explain what happens to the material/substance cohesion (Stoffzusammenhalt)\n"
    "  3. Name typical procedures (only source-supported)\n"
    "  4. Classify procedures by key characteristics\n"
    "  5. Compare advantages, disadvantages, applications\n"
    "  6. Justify the best procedure for a concrete case\n"
    "- stepByStepMethod for process selection:\n"
    "  1. Determine material, part geometry, and production volume\n"
    "  2. Check requirements: accuracy, surface, strength, cost\n"
    "  3. Select candidate procedures\n"
    "  4. Compare by technical and economic criteria\n"
    "  5. Justify the best choice for an exam answer\n"
    "- stepByStepMethod for process comparison (e.g. welding vs. brazing vs. adhesive bonding):\n"
    "  1. Define all procedures\n"
    "  2. Compare mechanism, temperature, materials, strength, application range\n"
    "  3. State advantages and limitations of each\n"
    "  4. Give typical applications\n"
    "  5. Formulate an exam-ready mnemonic or summary\n\n"
    "For \"process-detail\" topics (a specific process like Löten, Schweißen, Walzen, Sintern, "
    "MIG-Schweißen, Spanen, etc.):\n"
    "- keyFormulas = [] (empty unless the process has central equations)\n"
    "- Use adaptiveBlocks with these types:\n"
    "  * \"Definition\" — what the process is, where it belongs (Hauptgruppe)\n"
    "  * \"Mechanism\" — working principle, what happens physically/chemically\n"
    "  * \"Variants\" — subtypes of this process (e.g. Weichlöten, Hartlöten, "
    "Diffusionslöten, MIG-Löten)\n"
    "  * \"Conditions\" — prerequisites, parameters (temperature, materials, surface prep, "
    "flux, gap size, wetting, etc.)\n"
    "  * \"Comparison Table\" — compare this process with its alternatives. For joining: "
    "compare with other Fügeverfahren (e.g. Löten vs. Schweißen vs. Kleben). Columns: "
    "Verfahren, Grundwerkstoff schmilzt?, Zusatzwerkstoff, Verbindungsart, Vorteile, "
    "Nachteile, typische Anwendung.\n"
    "  * \"Key Statements\" — exam-relevant core facts\n"
    "  * \"Applications\" — where this process is used in practice\n"
    "- stepByStepMethod must be PROCESS-SPECIFIC. Example for Löten:\n"
    "  1. Identify the base materials to be joined\n"
    "  2. Confirm the base material must NOT melt (→ Löten, not Schweißen)\n"
    "  3. Choose a filler (Lot) with melting temp below the solidus of the base material\n"
    "  4. Check wetting, solder gap, surface preparation, and flux requirements\n"
    "  5. Select the suitable soldering method (Weich-/Hart-/Diffusions-/MIG-Löten)\n"
    "  6. Explain why the connection is stoffschlüssig\n"
    "  7. Compare with Schweißen and Kleben for the exam\n\n"
    "Source relevance for process-detail topics:\n"
    "- Only cite sources that directly discuss this specific process. Do NOT cite chapter files "
    "about unrelated processes (e.g. do not cite Umformtechnik or Zeitspanungsvolumen sources "
    "for a lesson about Löten). Only include a source in groundedSources if the lesson actually "
    "references information from it.\n\n"
    "For \"conceptual\" topics (law, business, economics):\n"
    "- keyFormulas = [] (empty)\n"
    "- Use adaptiveBlocks: \"Definition\", \"Framework\", \"Case Reasoning\", "
    "\"Comparison Table\", \"Decision Criteria\", \"Key Statements\"\n"
    "- stepByStepMethod: identify the rule/norm, check conditions, apply to case, state consequence\n\n"
    "For \"narrative\" topics (history, literature):\n"
    "- keyFormulas = [] (empty)\n"
    "- Use adaptiveBlocks: \"Timeline\", \"Causes\", \"Consequences\", \"Key Actors\", "
    "\"Interpretations\", \"Key Statements\"\n"
    "- stepByStepMethod: place in context, identify causes, trace consequences, compare interpretations\n\n"
    "For \"language\" topics:\n"
    "- keyFormulas = [] (empty)\n"
    "- Use adaptiveBlocks: \"Grammar Pattern\", \"Vocabulary\", \"Examples\", \"Common Mistakes\"\n"
    "- stepByStepMethod: identify the grammar rule, see examples, practice exceptions\n\n"
    "For \"descriptive-science\" topics (biology, medicine):\n"
    "- keyFormulas = [] unless equations are genuinely central\n"
    "- Use adaptiveBlocks: \"Process Map\", \"Structure-Function\", \"Cause-Effect\", "
    "\"Comparison Table\", \"Key Statements\"\n"
    "- stepByStepMethod: describe structure, explain function, trace cause-effect chain\n\n"
    "CRITICAL RULE: If a topic does not need formulas, do NOT include keyFormulas and do NOT "
    "return any text like \"No formula was strongly supported\". Simply return keyFormulas as "
    "an empty array and fill adaptiveBlocks with the right subject-specific blocks instead. "
    "The student should never feel that something is missing.\n\n"
    "Exam preparation rules (all knowledge types):\n"
    "- Write like a tutor coaching the student for the exam, not like an encyclopedia. "
    "After explaining a concept, connect it to the exam: add inline notes like "
    "\"Merksatz für die Prüfung: ...\" or \"Prüfungsfalle: ...\" inside the coreExplanation "
    "and keyDetails text. This makes the lesson feel like real exam coaching.\n"
    "- For exam mode, add an adaptiveBlock with type \"Exam Questions\" (title in lesson "
    "language, e.g. \"Typische Prüfungsfragen\"). Each item should be a question followed "
    "by a model answer (Musterantwort). This teaches students how to formulate exam answers, "
    "not just what the answer is. Include 3-5 questions.\n"
    "- Add a workedExample as a mini case study (\"Mini-Fallbeispiel\") with a realistic "
    "exam-style scenario, not just a calculation. For process topics: describe a situation "
    "(e.g. \"Two thin metal parts must be joined without melting the base material\") and "
    "walk through the reasoning to the correct process choice.\n"
    "- For classification topics, add a practiceTask that asks students to assign procedures "
    "to the correct groups (e.g. \"Ordnen Sie zu: Gießen, Biegen, Fräsen, Schweißen, "
    "Lackieren, Härten\").\n"
    "- selfCheck should include 2-3 questions, not just one. At least one should be applied "
    "(e.g. classify a procedure, calculate a value, apply a rule to a case), not just "
    "definitional. Include hint, answer, explanation, and stepByStep for each.\n"
    "- The stepByStepMethod should be framed as \"how to answer this in the exam\", not "
    "a generic method. Example for Löten: \"1. Einordnen: Fügen. 2. Verbindung erklären: "
    "stoffschlüssig. 3. Temperaturbedingung: Lot schmilzt, Grundwerkstoff nicht. "
    "4. Benetzung erklären. 5. Flussmittel erwähnen. 6. Abgrenzen: vs. Schweißen, Kleben. "
    "7. Anwendung begründen.\"\n\n"
    "Content type and lesson mode labels:\n"
    "- Write contentType in the lesson language. German: \"Prozessklassifikation\", "
    "\"Berechnung\", \"Konzept\", \"Beschreibende Wissenschaft\". English: keep as-is.\n"
    "- Write lessonMode in the lesson language. German: \"Prüfungsvorbereitung\", "
    "\"Einfache Erklärung\", \"Professorstil\", \"Praktische Anwendung\", "
    "\"Schnelle Wiederholung\". English: keep as-is.\n\n"
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
    ct = (content_type or "").lower().replace(" ", "-")
    if ct in ("process-detail",):
        if language == "en":
            return [
                "Define the process and its place in the manufacturing classification.",
                "Explain the working principle (what happens physically/chemically).",
                "Identify the key conditions and parameters.",
                "Name the variants of this process.",
                "Compare with alternative processes for the same purpose.",
                "State advantages, disadvantages, and typical applications.",
            ]
        return [
            "Definiere das Verfahren und ordne es in die Fertigungsklassifikation ein.",
            "Erkläre das Wirkprinzip (was passiert physikalisch/chemisch).",
            "Identifiziere die wichtigsten Bedingungen und Parameter.",
            "Nenne die Varianten dieses Verfahrens.",
            "Vergleiche mit alternativen Verfahren für denselben Zweck.",
            "Nenne Vorteile, Nachteile und typische Anwendungen.",
        ]
    if ct in ("process-classification",):
        if language == "en":
            return [
                "Define the manufacturing group and its DIN classification.",
                "Explain what happens to the material or substance cohesion.",
                "Name typical procedures in this group.",
                "Compare procedures by material suitability, cost, accuracy, and application.",
                "Justify which procedure fits a given part or scenario.",
            ]
        return [
            "Definiere die Fertigungshauptgruppe und ihre DIN-Einordnung.",
            "Erkläre, was mit dem Werkstoff oder Stoffzusammenhalt passiert.",
            "Nenne typische Verfahren dieser Gruppe.",
            "Vergleiche Verfahren nach Werkstoffeignung, Kosten, Genauigkeit und Anwendung.",
            "Begründe, welches Verfahren für ein konkretes Bauteil oder Szenario passt.",
        ]
    if ct in ("conceptual",):
        if language == "en":
            return [
                "Identify the core definition or principle.",
                "State the conditions under which it applies.",
                "Apply the principle to a concrete case or scenario.",
                "Identify exceptions or edge cases.",
                "Formulate an exam-ready summary.",
            ]
        return [
            "Identifiziere die zentrale Definition oder das Prinzip.",
            "Nenne die Bedingungen, unter denen es gilt.",
            "Wende das Prinzip auf einen konkreten Fall an.",
            "Identifiziere Ausnahmen oder Sonderfälle.",
            "Formuliere eine prüfungstaugliche Zusammenfassung.",
        ]
    if ct in ("narrative",):
        if language == "en":
            return [
                "Place the topic in its historical or thematic context.",
                "Identify causes and contributing factors.",
                "Trace the key consequences or developments.",
                "Compare different perspectives or interpretations.",
                "Summarize the significance for the course.",
            ]
        return [
            "Ordne das Thema in seinen historischen oder thematischen Kontext ein.",
            "Identifiziere Ursachen und Einflussfaktoren.",
            "Verfolge die wichtigsten Folgen oder Entwicklungen.",
            "Vergleiche verschiedene Perspektiven oder Interpretationen.",
            "Fasse die Bedeutung für den Kurs zusammen.",
        ]
    if ct in ("descriptive-science",):
        if language == "en":
            return [
                "Describe the structure or components involved.",
                "Explain the function or mechanism.",
                "Trace the cause-effect chain.",
                "Compare with related structures or processes.",
                "Identify clinically or exam-relevant details.",
            ]
        return [
            "Beschreibe die beteiligten Strukturen oder Komponenten.",
            "Erkläre die Funktion oder den Mechanismus.",
            "Verfolge die Ursache-Wirkungs-Kette.",
            "Vergleiche mit verwandten Strukturen oder Prozessen.",
            "Identifiziere klinisch oder prüfungsrelevante Details.",
        ]
    if ct in ("language",):
        if language == "en":
            return [
                "Identify the grammar rule or pattern.",
                "Study the examples from the course material.",
                "Note the exceptions and common mistakes.",
                "Practice with example sentences.",
                "Check your understanding with a self-test.",
            ]
        return [
            "Identifiziere die Grammatikregel oder das Muster.",
            "Studiere die Beispiele aus dem Kursmaterial.",
            "Notiere Ausnahmen und häufige Fehler.",
            "Übe mit Beispielsätzen.",
            "Prüfe dein Verständnis mit einem Selbsttest.",
        ]
    if language == "en":
        return [
            "Identify the core concept and its definition from the sources.",
            "Understand the conditions or context where it applies.",
            "Work through an example or application step by step.",
            "Check for common mistakes or edge cases.",
            "Verify your understanding against the original " + topic + " question.",
        ]
    return [
        "Identifiziere das Kernkonzept und seine Definition aus den Quellen.",
        "Verstehe die Bedingungen oder den Kontext, in dem es gilt.",
        "Arbeite ein Beispiel oder eine Anwendung Schritt für Schritt durch.",
        "Prüfe auf häufige Fehler oder Sonderfälle.",
        "Überprüfe dein Verständnis anhand der ursprünglichen Fragestellung zu " + topic + ".",
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

    user = (
        "TOPIC TO TEACH: " + topic + "\n\n"
        + _mode_prompt(mode) + "\n\n"
        + _language_prompt(language) + "\n\n"
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
        "model": res.model,
        "promptTokens": res.prompt_tokens,
        "completionTokens": res.completion_tokens,
    }


__all__ = ("generate_deep_learn",)
