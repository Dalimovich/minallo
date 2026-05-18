"""POST /notes-generate — full port of backend/functions/notes-generate.js.

Handles all four modes the frontend uses:
  - mode='analyze'  → group pages into sections (currently returns an
                     empty list so the frontend falls back to its fixed
                     page-window splits — preserves the existing UX).
  - mode='section'  → notes/summary for one explicit page range,
                     returned as raw markdown (caller merges later).
  - mode='merge'    → merge a list of section markdowns into one note
                     and persist it.
  - mode='generate' → full-document notes/summary in one shot.

Each branch returns the exact JSON shape the frontend (notes-panel.js)
already expects, so the JS handler can be a thin auth+forward shell.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from openai import OpenAI
from pydantic import BaseModel

from ..auth import require_internal_token
from ..config import get_settings
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

router = APIRouter(prefix="", tags=["notes"], dependencies=[Depends(require_internal_token)])

_MAX_CONTEXT_CHARS = 28_000
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_METADATA_NOISE = (
    "institut für", "technische universität", "prof.", "dr.-ing.", "wintersemester",
    "sommersemester", "lehrstuhl", "fachgebiet", "vorlesung", "folien", "slides",
    "copyright", "©", "all rights reserved",
)


# ── Prompt builders ──────────────────────────────────────────────────────────


def _lang_instr(lang: str) -> str:
    if lang == "de":
        return "Schreibe die Antwort auf Deutsch."
    if lang == "en":
        return "Write the answer in English."
    if lang == "bilingual":
        return "Schreibe die Antwort zweisprachig (Deutsch und Englisch)."
    return "Match the language of the source material."


def _notes_prompt(lang: str) -> str:
    return f"""You are generating detailed, exam-ready study notes from university lecture PDF slides.

{_lang_instr(lang)}

IGNORE completely: author names, institute names, semester labels, university logos, slide numbers, copyright lines, and any administrative text that is not course content.

CRITICAL RULES:
- Use ONLY the provided PDF text. Do NOT invent facts.
- Be exhaustive — exam-ready, not a high-level summary.
- Every method/process named in the source → ### subsection (what it is, materials, advantages, disadvantages, applications).
- Every definition → quote near-verbatim with a page ref *(S. X)*.
- Every list → reproduce in full.
- Every formula → KaTeX ($...$ or $$...$$), explain every variable + units.

STRUCTURE:
# [Main topic]
## Definitionen / Definitions
## Einteilungen und Normen / Classifications and Standards
## Verfahren / Methods and Processes
## Formeln / Formulas
## Vergleiche / Comparisons
## Prüfungsrelevanz / Exam Focus

Cite page numbers throughout. No filler sentences."""


def _summary_prompt(lang: str, detail_level: str) -> str:
    detail_map = {
        "brief":    "Be concise — keep the summary tight, ~400–700 words.",
        "balanced": "Be thorough but readable, ~700–1400 words.",
        "detailed": "Be detailed, ~1400–2400 words — cover every named method and concept.",
        "exam":     "Be exam-focused — every paragraph must add testable information; ~1600–2600 words.",
    }
    detail = detail_map.get(detail_level, detail_map["balanced"])
    return f"""You are writing a structured study summary from university lecture PDF material.

{_lang_instr(lang)}
{detail}

Rules:
- Use ONLY material from the provided PDF text. Do NOT invent.
- Cite page numbers: *(S. X)*.
- Use ## headings: Overview, Definitionen, Verfahren / Methods, Formeln, Vergleiche, Prüfungsrelevanz, Summary.
- Math in KaTeX. Tables with markdown for comparisons."""


def _section_prompt(lang: str, page_start: int | None, page_end: int | None, tool: str) -> str:
    if page_start is not None:
        page_ref = f"Seite {page_start}" if page_start == page_end else f"Seiten {page_start}–{page_end}"
    else:
        page_ref = "diesem Abschnitt"
    if tool == "summary":
        return f"""You are generating a study summary for ONE specific page group from a university lecture PDF.

{_lang_instr(lang)}

Cover what is on {page_ref} only. Do NOT introduce surrounding chapter context.
- Quote definitions near-verbatim with *(S. X)*.
- Reproduce every list in full.
- KaTeX for formulas.
- No filler. Every bullet must add information."""
    return f"""You are generating detailed study notes for ONE specific page group from a university lecture PDF.

{_lang_instr(lang)}

Extract everything worth studying from {page_ref}. For each named method create a ### subsection with what/advantages/disadvantages/applications. Quote definitions verbatim. KaTeX formulas. Cite *(S. X)* throughout."""


def _merge_prompt(lang: str, tool: str) -> str:
    if tool == "summary":
        return f"""You are merging multiple section summaries into one final study summary.

{_lang_instr(lang)}

Rules:
- Preserve ALL content. Remove only exact duplicates.
- Keep every page reference (S. X).
- Group related content under ## headings.
- End with a ## Prüfungsrelevanz section with the 5–10 most exam-relevant points.
- Do NOT invent new information."""
    return f"""You are merging multiple section notes into one final structured study note.

{_lang_instr(lang)}

Rules:
- Preserve ALL content from ALL sections — do not aggressively shorten.
- Remove exact duplicates only.
- Keep every page reference *(S. X)*.
- Group by topic under ## headings.
- Every method/process keeps its own ### subsection.
- End with ## Prüfungsrelevanz."""


# ── DB helpers ───────────────────────────────────────────────────────────────


def _is_metadata_chunk(text: str | None) -> bool:
    if not text or len(text) > 400:
        return False
    lower = text.lower()
    hits = sum(1 for t in _METADATA_NOISE if t in lower)
    return hits >= 2


def _verify_document_owner(user_id: str, course_id: str, document_id: str | None) -> None:
    if not document_id:
        return
    if not _UUID_RE.match(document_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="documentId must be a UUID")
    if not _UUID_RE.match(user_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="userId must be a UUID")
    sb = get_supabase()
    result = (
        sb.table("documents")
        .select("id, user_id, course_id")
        .eq("id", document_id)
        .eq("user_id", user_id)
        .eq("course_id", course_id)
        .limit(1)
        .execute()
    )
    if not (result.data or []):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")


def _fetch_chunks(
    user_id: str, course_id: str, document_id: str,
    page_start: int | None, page_end: int | None,
) -> list[dict[str, Any]]:
    sb = get_supabase()
    q = (
        sb.table("document_chunks")
        .select("chunk_text, page_start, page_end, section_title, source_type")
        .eq("user_id", user_id)
        .eq("course_id", course_id)
        .eq("document_id", document_id)
        .order("page_start")
        .order("id")
        .limit(150 if (page_start is None and page_end is None) else 80)
    )
    if page_end is not None:
        q = q.lte("page_start", page_end)
    if page_start is not None:
        q = q.gte("page_end", page_start)
    rows = (q.execute().data) or []
    return [r for r in rows if not _is_metadata_chunk(r.get("chunk_text"))]


def _build_context(chunks: list[dict[str, Any]], file_name: str | None) -> tuple[str, list[dict[str, Any]]]:
    if not chunks:
        return "", []
    ctx = f"QUELLE: {file_name or 'PDF'}\n\n"
    chars = 0
    sources: list[dict[str, Any]] = []
    for c in chunks:
        ps, pe = c.get("page_start"), c.get("page_end")
        page_ref = ""
        if ps is not None:
            page_ref = f"[S. {ps}{('–' + str(pe)) if pe and pe != ps else ''}]"
        section = f"[{c['section_title']}] " if c.get("section_title") else ""
        line = f"{section}{page_ref}\n{c.get('chunk_text', '')}\n\n"
        if chars + len(line) > _MAX_CONTEXT_CHARS:
            break
        ctx += line
        chars += len(line)
        sources.append({"page_start": ps, "page_end": pe})
    return ctx, sources


def _call_openai(system_prompt: str, user_message: str, max_tokens: int = 4000) -> str:
    settings = get_settings()
    client = OpenAI(api_key=settings.openai_api_key)
    resp = client.chat.completions.create(
        model=settings.openai_generate_model_strong,
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_message},
        ],
    )
    text = (resp.choices[0].message.content if resp.choices and resp.choices[0].message else "") or ""
    return text.strip()


_TITLE_RE = re.compile(r"^#\s+(.+)", re.MULTILINE)


def _extract_title(markdown: str, fallback: str) -> str:
    m = _TITLE_RE.search(markdown or "")
    if not m:
        return fallback
    return re.sub(r"[*_`]", "", m.group(1)).strip() or fallback


def _save_note(
    user_id: str, course_id: str, document_id: str | None, title: str, type_: str,
    markdown: str, sources: list[dict[str, Any]],
    filter_start: int | None, filter_end: int | None,
) -> str | None:
    if not (markdown or "").strip():
        return None
    sb = get_supabase()
    try:
        row = sb.table("notes").insert({
            "user_id":           user_id,
            "course_id":         course_id,
            "document_id":       document_id,
            "title":             title[:180] or "Untitled",
            "type":              type_,
            "content_markdown":  markdown,
            "source_page_start": filter_start,
            "source_page_end":   filter_end,
            "updated_at":        datetime.now(timezone.utc).isoformat(),
        }).execute()
        note_id = row.data[0]["id"] if row.data else None
        if note_id and document_id and sources:
            src_rows = [
                {
                    "note_id":     note_id,
                    "document_id": document_id,
                    "page_start":  s.get("page_start"),
                    "page_end":    s.get("page_end"),
                }
                for s in sources if s.get("page_start") is not None
            ]
            if src_rows:
                try:
                    sb.table("note_sources").insert(src_rows).execute()
                except Exception:
                    log.exception("note_sources insert failed (non-fatal)")
        return note_id
    except Exception:
        log.exception("save_note failed")
        return None


# ── Request schema ───────────────────────────────────────────────────────────


class NotesGenerateRequest(BaseModel):
    userId: str
    courseId: str
    documentId: str | None = None
    tool: str  # 'notes' | 'summary'
    mode: str = "generate"  # 'generate' | 'section' | 'merge' | 'analyze'
    scope: str = "document"  # 'page' | 'section' | 'range' | 'document'
    fileName: str | None = None
    pdfText: str | None = None
    language: str = "same_as_source"
    detailLevel: str = "balanced"
    currentPage: int | None = None
    pageRange: dict[str, Any] | None = None
    topicTitle: str | None = None
    sections: list[dict[str, Any]] | None = None
    effectivePages: int | None = None
    title: str | None = None


# ── Endpoint ─────────────────────────────────────────────────────────────────


@router.post("/notes-generate")
async def notes_generate(payload: NotesGenerateRequest) -> dict[str, Any]:
    if payload.tool not in ("notes", "summary"):
        raise HTTPException(status_code=400, detail="tool must be notes or summary")
    if payload.mode not in ("generate", "section", "merge", "analyze"):
        raise HTTPException(status_code=400, detail="mode is invalid")
    if payload.scope not in ("document", "page", "section", "range"):
        raise HTTPException(status_code=400, detail="scope is invalid")
    _verify_document_owner(payload.userId, payload.courseId, payload.documentId)

    # ── ANALYZE: short-circuit so the frontend uses its fixed-page splits ───
    if payload.mode == "analyze":
        return {"groups": [], "effectivePages": None}

    # ── MERGE ───────────────────────────────────────────────────────────────
    if payload.mode == "merge":
        sections = payload.sections or []
        if not sections:
            raise HTTPException(status_code=400, detail="sections required for merge mode")
        combined_parts = []
        for i, s in enumerate(sections):
            hdr = (
                f"=== SECTION {i+1}: Seiten {s.get('pageStart')}–{s.get('pageEnd')} ==="
                if s.get("pageStart") is not None else f"=== SECTION {i+1} ==="
            )
            if s.get("title"):
                hdr += f" — {s['title']}"
            combined_parts.append(hdr + "\n\n" + (s.get("markdown") or ""))
        combined = "\n\n".join(combined_parts)[:_MAX_CONTEXT_CHARS]
        instruction = (
            "Merge these section summaries into one final structured study summary:\n\n"
            if payload.tool == "summary"
            else "Merge these section notes into one final study note:\n\n"
        )
        try:
            merged = _call_openai(_merge_prompt(payload.language, payload.tool), instruction + combined, max_tokens=5000)
        except Exception as e:  # noqa: BLE001
            log.exception("merge LLM failed")
            return {"error": f"Merge failed: {e}"}
        fallback_title = (payload.fileName or "Notizen") + " — " + ("Zusammenfassung" if payload.tool == "summary" else "Notizen")
        title = _extract_title(merged, fallback_title)
        merge_sources: list[dict[str, Any]] = []
        for s in sections:
            if s.get("pageStart") is not None:
                merge_sources.append({"page_start": s.get("pageStart"), "page_end": s.get("pageEnd")})
        filter_start = sections[0].get("pageStart") if sections else None
        filter_end = sections[-1].get("pageEnd") if sections else None
        note_id = _save_note(
            payload.userId, payload.courseId, payload.documentId, title, payload.tool,
            merged, merge_sources, filter_start, filter_end,
        )
        return {"note": {"id": note_id, "title": title, "type": payload.tool, "content_markdown": merged, "sources": merge_sources}}

    # ── SECTION ─────────────────────────────────────────────────────────────
    if payload.mode == "section":
        sec_start = int(payload.pageRange["start"]) if payload.pageRange and payload.pageRange.get("start") is not None else None
        sec_end   = int(payload.pageRange["end"])   if payload.pageRange and payload.pageRange.get("end")   is not None else None
        chunks: list[dict[str, Any]] = []
        if payload.documentId:
            try:
                chunks = _fetch_chunks(payload.userId, payload.courseId, payload.documentId, sec_start, sec_end)
            except Exception:
                log.exception("section fetch_chunks failed")
        if chunks:
            context, _src = _build_context(chunks, payload.fileName)
        elif payload.pdfText and len(payload.pdfText.strip()) > 50:
            context = f"QUELLE: {payload.fileName or 'PDF'}\n\n" + payload.pdfText[:_MAX_CONTEXT_CHARS]
        else:
            return {"markdown": "", "pageStart": sec_start, "pageEnd": sec_end, "empty": True}
        instr = (
            f"Erstelle eine Zusammenfassung NUR für diesen Abschnitt (S. {sec_start}–{sec_end})."
            if payload.tool == "summary"
            else "Erstelle detaillierte Lernnotizen NUR für diesen Abschnitt."
        )
        sys_p = _section_prompt(payload.language, sec_start, sec_end, payload.tool)
        try:
            md = _call_openai(sys_p, f"PDF-INHALT (Seiten {sec_start}–{sec_end}):\n\n{context}\n\n{instr}", max_tokens=2500)
        except Exception as e:  # noqa: BLE001
            log.exception("section LLM failed")
            return {"error": f"Section generation failed: {e}"}
        return {"markdown": md, "pageStart": sec_start, "pageEnd": sec_end}

    # ── GENERATE (default) ──────────────────────────────────────────────────
    filter_start: int | None = None
    filter_end:   int | None = None
    if payload.scope != "document":
        cp = payload.currentPage
        if payload.scope == "page" and cp is not None:
            filter_start = cp
            filter_end = cp
        elif payload.scope == "section" and cp is not None:
            filter_start = max(1, cp - 1)
            filter_end = cp + 1
        elif payload.scope == "range" and payload.pageRange:
            filter_start = int(payload.pageRange["start"]) if payload.pageRange.get("start") is not None else None
            filter_end   = int(payload.pageRange["end"])   if payload.pageRange.get("end")   is not None else None

    chunks: list[dict[str, Any]] = []
    context = ""
    sources: list[dict[str, Any]] = []

    if payload.documentId:
        try:
            chunks = _fetch_chunks(payload.userId, payload.courseId, payload.documentId, filter_start, filter_end)
        except Exception:
            log.exception("generate fetch_chunks failed")
        if chunks:
            context, sources = _build_context(chunks, payload.fileName)

    if not context:
        if payload.pdfText and len(payload.pdfText.strip()) > 100:
            context = f"QUELLE: {payload.fileName or 'PDF'}\n\n" + payload.pdfText[:_MAX_CONTEXT_CHARS]
        else:
            return {
                "error": (
                    "Diese Datei wird noch indiziert. Bitte warte kurz und versuche es erneut."
                    if payload.documentId else "Kein Inhalt verfügbar. Öffne zuerst ein PDF."
                ),
                "indexing": bool(payload.documentId),
            }

    system_prompt = (
        _summary_prompt(payload.language, payload.detailLevel)
        if payload.tool == "summary"
        else _notes_prompt(payload.language)
    )
    page_hint = ""
    if filter_start is not None:
        page_hint = "\n\nFOKUS: " + (
            f"Seite {filter_start}" if filter_start == filter_end else f"Seiten {filter_start}–{filter_end}"
        ) + " des PDFs. Verwende NUR Inhalte aus diesem Seitenbereich."
    instr = (
        "Erstelle eine studentengerechte Zusammenfassung aus dem obigen Text. "
        "Halte dich strikt an den Seitenbereich. Erfasse alle wichtigen Definitionen, Formeln, Listen, Prozesse und Vergleiche."
        if payload.tool == "summary"
        else "Erstelle detaillierte Lernnotizen aus dem obigen Text. Erfasse ALLE Definitionen, Listen, Formeln und Prozessschritte."
    )
    user_message = f"PDF-INHALT:\n\n{context}{page_hint}\n\n{instr}"

    try:
        markdown = _call_openai(system_prompt, user_message, max_tokens=6000)
    except Exception as e:  # noqa: BLE001
        log.exception("notes LLM failed")
        return {"error": f"KI-Generierung fehlgeschlagen: {e}"}

    page_label = ""
    if filter_start is not None:
        page_label = f" — S. {filter_start}" + (f"–{filter_end}" if filter_end and filter_end != filter_start else "")
    fallback_title = (
        (payload.fileName or "Notizen").replace(".pdf", "") + page_label
        + " — " + ("Zusammenfassung" if payload.tool == "summary" else "Notizen")
    )
    title = _extract_title(markdown, fallback_title)
    note_id = _save_note(
        payload.userId, payload.courseId, payload.documentId, title, payload.tool,
        markdown, sources, filter_start, filter_end,
    )
    return {"note": {"id": note_id, "title": title, "type": payload.tool, "content_markdown": markdown, "sources": sources}}
