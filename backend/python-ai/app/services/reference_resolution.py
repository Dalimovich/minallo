"""Deterministic reference and language resolution for grounded PDF questions.

This stage runs before retrieval.  It deliberately treats structured exercise
labels differently from ordinary semantic text: a bare handwritten ``11`` is
not an alias for ``Aufgabe 13.11``.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any, Literal


ReferenceStatus = Literal["resolved", "ambiguous", "not_found"]
EvidenceAction = Literal["answer", "clarify", "report_missing_evidence"]


_EXPLICIT_LABEL_RE = re.compile(
    r"\b(?:aufgabe|übungsaufgabe|uebungsaufgabe|übung|uebung|"
    r"question|exercise|problem|task|ex)\s*"
    r"(\d+(?:[.,]\d+){0,3}(?:\s*(?:[.(]\s*)?[a-z]\s*\)?)?)(?!\w)",
    re.IGNORECASE,
)
_PRINTED_LABEL_RE = re.compile(
    r"(?im)^\s*(?:#{1,6}\s*)?(?:aufgabe|übungsaufgabe|uebungsaufgabe|"
    r"übung|uebung|question|exercise|problem|task|ex)\s+"
    r"(\d+(?:[.,]\d+){0,3}(?:\s*(?:[.(]\s*)?[a-z]\s*\)?)?)(?!\w)"
)
_MARK_RE = re.compile(
    r"\b(?:marked|selected|checked|tick(?:ed)?|markiert|angekreuzt|"
    r"ausgewählt|ausgewaehlt)\D{0,24}(-?\d+(?:[.,]\d+)?)\b",
    re.IGNORECASE,
)
_VISUAL_REFERENCE_RE = re.compile(
    r"\b(this|that|these|those|here|shown|above|below|visible|current|"
    r"marked|selected|checked|symbol|diagram|drawing|table|"
    r"dies(?:e[rsnm]?)?|hier|gezeigt|oben|unten|markiert|angekreuzt|"
    r"symbol|diagramm|zeichnung|tabelle)\b",
    re.IGNORECASE,
)
_CORRECTION_RE = re.compile(
    r"^\s*(?:no\b|not\b|wrong\b|incorrect\b|actually\b|"
    r"nein\b|nicht\b|falsch\b|doch\b|stimmt nicht\b)",
    re.IGNORECASE,
)
_LANGUAGE_REQUEST_RE = re.compile(
    r"\b(?:answer|reply|explain|write|respond|antworte|erkläre|erklaere|schreibe)"
    r"\s+(?:it\s+)?(?:in|auf)\s+"
    r"(english|german|deutsch|french|français|francais|arabic|"
    r"tunisian arabic|spanish|italian)\b",
    re.IGNORECASE,
)


def normalize_question_label(value: str | None) -> str | None:
    if not value:
        return None
    raw = value.strip().lower().replace(",", ".")
    raw = re.sub(
        r"^(?:aufgabe|übungsaufgabe|uebungsaufgabe|übung|uebung|"
        r"question|exercise|problem|task|ex)\s*",
        "",
        raw,
        flags=re.IGNORECASE,
    )
    raw = re.sub(r"[\s:.)\]]+$", "", raw)
    raw = re.sub(r"(?<=\d)[.(]\s*([a-z])$", r"\1", raw)
    raw = re.sub(r"\s+", "", raw)
    if re.fullmatch(r"\d+[il]", raw):
        return None
    match = re.fullmatch(r"(\d+(?:\.\d+){0,3})([a-z]?)", raw)
    if match:
        numeric = ".".join(str(int(part)) for part in match.group(1).split("."))
        raw = numeric + match.group(2)
    return raw if re.fullmatch(r"\d+(?:\.\d+){0,3}[a-z]?", raw) else None


def exact_question_label_match(requested: str, candidate: str) -> bool:
    left = normalize_question_label(requested)
    right = normalize_question_label(candidate)
    return bool(left and right and left == right)


@dataclass(frozen=True)
class ReferenceEvidence:
    kind: str
    value: str
    page_number: int | None = None


@dataclass
class QuestionReference:
    course_id: str | None
    document_id: str | None
    document_name: str | None
    document_type: str = "unknown"
    page_number: int | None = None
    visible_page_number: int | None = None
    selected_text: str | None = None
    selected_region_id: str | None = None
    user_requested_label: str | None = None
    resolved_question_number: str | None = None
    parent_question_number: str | None = None
    question_text: str | None = None
    confidence: float = 0.0
    evidence: list[ReferenceEvidence] = field(default_factory=list)
    status: ReferenceStatus = "not_found"
    candidate_labels: list[str] = field(default_factory=list)
    mark_value: str | None = None

    def to_api(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class EvidenceDecision:
    can_answer: bool
    exact_question_resolved: bool
    evidence_complete: bool
    missing_information: list[str] = field(default_factory=list)
    conflicting_sources: list[str] = field(default_factory=list)
    confidence: float = 0.0
    action: EvidenceAction = "clarify"
    recovery_code: str | None = None

    def to_api(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class LanguageContext:
    user_message_language: str
    requested_response_language: str
    conversation_language: str
    document_languages: list[str]
    code_switching_detected: bool

    def to_api(self) -> dict[str, Any]:
        return asdict(self)


def _language_from_text(text: str) -> str | None:
    q = (text or "").casefold()
    en = len(re.findall(r"\b(the|this|that|what|why|how|please|answer|explain|marked|professor|not)\b", q))
    de = len(re.findall(r"\b(der|die|das|was|warum|wie|bitte|antwort|erkläre|professor|nicht|aufgabe)\b", q))
    if en > de:
        return "en"
    if de > en:
        return "de"
    return None


def resolve_language_context(
    message: str,
    *,
    explicit_response_language: str | None = None,
    previous_turns: list[dict[str, str]] | None = None,
    document_languages: list[str] | None = None,
) -> LanguageContext:
    explicit_match = _LANGUAGE_REQUEST_RE.search(message or "")
    explicit = (explicit_response_language or (explicit_match.group(1) if explicit_match else "")).casefold()
    aliases = {
        "english": "en", "en": "en",
        "german": "de", "deutsch": "de", "de": "de",
        "french": "fr", "français": "fr", "francais": "fr", "fr": "fr",
        "arabic": "ar", "tunisian arabic": "ar", "ar": "ar",
        "spanish": "es", "es": "es",
        "italian": "it", "it": "it",
    }
    requested = aliases.get(explicit)
    latest = _language_from_text(message)
    conversation = None
    sticky = None
    for turn in reversed(previous_turns or []):
        if (turn.get("role") or "").lower() == "user":
            prior_request = _LANGUAGE_REQUEST_RE.search(turn.get("text") or "")
            if prior_request and sticky is None:
                sticky = aliases.get(prior_request.group(1).casefold())
        if conversation is None:
            conversation = _language_from_text(turn.get("text") or "")
    conversation = conversation or latest or "en"
    requested = requested or sticky or latest or conversation
    q = (message or "").casefold()
    code_switching = bool(
        re.search(r"\b(aufgabe|standzeit|schnittgeschwindigkeit|lösung|loesung)\b", q)
        and re.search(r"\b(explain|solve|calculate|what|why|how)\b", q)
    )
    return LanguageContext(
        user_message_language=latest or conversation,
        requested_response_language=requested,
        conversation_language=conversation,
        document_languages=list(document_languages or []),
        code_switching_detected=code_switching,
    )


def resolve_question_reference(
    *,
    question: str,
    course_id: str | None,
    active_document_id: str | None,
    active_document_name: str | None,
    visible_page: int | None,
    selected_text: str | None,
    selected_region_id: str | None,
    visible_text: str | None,
    has_visible_image: bool,
) -> QuestionReference:
    selected = (selected_text or "").strip()
    page_text = selected or (visible_text or "").strip()
    explicit = _EXPLICIT_LABEL_RE.search(question or "")
    requested = normalize_question_label(explicit.group(1)) if explicit else None
    mark = _MARK_RE.search(question or "")
    mark_value = mark.group(1).replace(",", ".") if mark else None
    candidates = list(dict.fromkeys(
        normalize_question_label(m.group(1)) or "" for m in _PRINTED_LABEL_RE.finditer(page_text)
    ))
    candidates = [c for c in candidates if c]

    ref = QuestionReference(
        course_id=course_id or None,
        document_id=active_document_id or None,
        document_name=active_document_name or None,
        page_number=visible_page,
        visible_page_number=visible_page,
        selected_text=selected or None,
        selected_region_id=selected_region_id or None,
        user_requested_label=requested,
        candidate_labels=candidates,
        mark_value=mark_value,
    )
    if active_document_id:
        ref.evidence.append(ReferenceEvidence("active_document", active_document_id, visible_page))
    if visible_page:
        ref.evidence.append(ReferenceEvidence("visible_page", str(visible_page), visible_page))
    if selected:
        ref.evidence.append(ReferenceEvidence("selected_text", selected[:240], visible_page))
    elif page_text:
        ref.evidence.append(ReferenceEvidence("visible_text", page_text[:240], visible_page))
    if has_visible_image:
        ref.evidence.append(ReferenceEvidence("visible_image", "attached", visible_page))
    if mark_value:
        ref.evidence.append(ReferenceEvidence("user_described_mark", mark_value, visible_page))

    if requested:
        exact = [c for c in candidates if exact_question_label_match(requested, c)]
        if len(exact) == 1:
            ref.resolved_question_number = exact[0]
            ref.question_text = page_text or None
            ref.status = "resolved"
            ref.confidence = 0.98 if selected else 0.9
        elif len(exact) > 1:
            ref.status = "ambiguous"
            ref.confidence = 0.45
        elif active_document_id and visible_page and (page_text or has_visible_image):
            ref.status = "not_found"
            ref.confidence = 0.25
        else:
            # An explicit exact label may be resolved later by exact metadata
            # lookup; never substitute a partial semantic match here.
            ref.status = "not_found"
            ref.confidence = 0.2
    elif active_document_id and visible_page and (selected or page_text or has_visible_image):
        ref.question_text = page_text or None
        ref.status = "resolved"
        ref.confidence = 0.95 if selected else (0.82 if page_text and has_visible_image else 0.7)
    elif _VISUAL_REFERENCE_RE.search(question or "") or _CORRECTION_RE.search(question or ""):
        ref.status = "not_found"
        ref.confidence = 0.0
    return ref


def decide_evidence(
    reference: QuestionReference,
    *,
    question: str,
    has_history: bool,
) -> EvidenceDecision:
    visual_or_correction = bool(
        _VISUAL_REFERENCE_RE.search(question or "") or _CORRECTION_RE.search(question or "")
    )
    if reference.status == "ambiguous":
        return EvidenceDecision(
            False, False, False, ["exact question reference"], [],
            reference.confidence, "clarify", "ambiguous_reference",
        )
    if visual_or_correction and reference.status != "resolved":
        return EvidenceDecision(
            False, False, False, ["active document and visible page evidence"], [],
            reference.confidence, "clarify", "exact_question_not_resolved",
        )
    if reference.user_requested_label and reference.status != "resolved":
        # Explicit labels without a visible match are allowed to proceed only
        # when there is no visual/current-page claim; Stage-A exact metadata
        # retrieval can resolve them later without substring matching.
        if not visual_or_correction:
            return EvidenceDecision(
                True, False, False, ["exact question text"], [],
                0.35, "answer", "exact_lookup_required",
            )
    if reference.status == "resolved":
        return EvidenceDecision(
            True,
            bool(reference.resolved_question_number or reference.question_text or reference.evidence),
            bool(reference.question_text or any(e.kind == "visible_image" for e in reference.evidence)),
            [],
            [],
            reference.confidence,
            "answer",
            None,
        )
    if has_history and _CORRECTION_RE.search(question or ""):
        return EvidenceDecision(
            False, False, False, ["visible page evidence"], [],
            0.15, "clarify", "exact_question_not_resolved",
        )
    return EvidenceDecision(True, False, False, [], [], 0.3, "answer", None)


def recovery_message(code: str | None, language: str) -> str:
    region_failures = {
        "critical_token_mismatch",
        "critical_token_disagreement",
        "selection_text_mismatch",
        "region_unreadable",
        "renderer_unavailable",
        "render_failed",
        "crop_failed",
        "region_too_small",
        "invalid_region",
        "invalid_selection",
        "document_replaced",
        "document_unavailable",
        "page_not_found",
        "invalid_pdf_geometry",
        "region_ocr_disabled",
        "region_ocr_in_progress",
        "region_ocr_failed",
        "region_ocr_ambiguous",
        "region_ocr_cache_invalid",
        "region_ocr_budget_exhausted",
    }
    if code in region_failures:
        return {
            "de": (
                "Ich konnte die markierte PDF-Stelle nicht sicher mit der gespeicherten "
                "Dokumentversion abgleichen. Bitte markiere den Wert und seine Einheit "
                "erneut etwas großzügiger."
            ),
            "fr": (
                "Je n’ai pas pu vérifier avec certitude la zone sélectionnée dans la "
                "version PDF enregistrée. Sélectionnez à nouveau la valeur et son unité "
                "dans une zone légèrement plus large."
            ),
            "es": (
                "No pude verificar con seguridad la zona seleccionada en la versión "
                "guardada del PDF. Vuelve a seleccionar el valor y su unidad usando "
                "un área un poco más amplia."
            ),
            "it": (
                "Non ho potuto verificare con certezza l’area selezionata nella versione "
                "PDF salvata. Seleziona di nuovo il valore e l’unità usando un’area "
                "leggermente più ampia."
            ),
            "ar": (
                "تعذر التحقق بثقة من المنطقة المحددة في نسخة PDF المحفوظة. حدّد القيمة "
                "ووحدتها مرة أخرى ضمن منطقة أوسع قليلًا."
            ),
        }.get(
            language,
            "I could not safely verify the selected region against the stored PDF "
            "revision. Please select the value and its unit again with a slightly "
            "larger area.",
        )
    generic = {
        "fr": "Je ne peux pas vérifier cette réponse avec les preuves actuelles. Sélectionnez à nouveau la zone actuelle du PDF ou confirmez la valeur ambiguë.",
        "es": "No puedo verificar esta respuesta con la evidencia actual. Vuelve a seleccionar el área actual del PDF o confirma el valor ambiguo.",
        "it": "Non posso verificare questa risposta con le prove attuali. Seleziona di nuovo l'area corrente del PDF o conferma il valore ambiguo.",
        "ar": "لا أستطيع التحقق من هذه الإجابة بالأدلة الحالية. حدّد منطقة PDF الحالية من جديد أو أكّد القيمة الملتبسة.",
    }
    if language in generic:
        return generic[language]
    if code == "stale_selection":
        return (
            "Diese PDF-Auswahl stammt von einer alten Seite oder Dokumentversion. Bitte markiere den aktuellen Bereich erneut."
            if language == "de" else
            "That PDF selection is from an older page or document revision. Please select the current area again."
        )
    de = language == "de"
    if code == "critical_numerical_mismatch":
        return (
            "Ich habe einen Zahlen-, Vorzeichen- oder Einheitenkonflikt zwischen dem Entwurf und der Aufgabenquelle erkannt. Ich zeige die ungeprüfte Lösung nicht an. Bitte bestätige den unklaren Wert oder markiere ihn im PDF."
            if de else
            "I detected a value, sign, exponent, or unit conflict between the draft and the source question. I will not show the unverified solution. Please confirm the unclear value or select it in the PDF."
        )
    if code == "ambiguous_reference":
        return (
            "Ich habe mehr als eine mögliche Aufgabenreferenz gefunden. Bitte markiere den Aufgabenbereich oder nenne die PDF-Seite."
            if de else
            "I found more than one possible question reference. Please select the question area or tell me the PDF page."
        )
    return (
        "Ich kann die markierte Aufgabe auf der aktuellen Seite nicht zuverlässig identifizieren. Bitte öffne die Seite oder markiere den Aufgabenbereich."
        if de else
        "I cannot reliably identify the marked question from the current page. Please open that page or select the question area."
    )
