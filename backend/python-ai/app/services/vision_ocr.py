"""Phase 12 — OCR / vision fallback for image-only PDF pages.

Pipeline:

    PDF page → rendered image → vision-capable LLM → Markdown text

Only runs when:
  * ``settings.vision_ocr_enabled`` is True (env: ``MINALLO_VISION_OCR_ENABLED``)
  * the Phase 11 detector flagged ``ocr_recommended``
  * the rendering library (``pypdfium2``) is importable

Otherwise the function returns an empty mapping and the indexer keeps
the original (possibly empty) pdfminer text. The whole module degrades
gracefully when:
  * pypdfium2 is not installed (no dep is forced on the deploy)
  * OpenAI vision returns an error
  * a single page render fails

Page indices in/out are 0-based to match ``extract_pages_text``'s slot
ordering.
"""

from __future__ import annotations

import base64
import io
import logging
import re
import time
from dataclasses import dataclass
from typing import Iterable

from ..config import get_settings
from .llm_json import _token_limit_param

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class OcrPageResult:
    """Structured OCR output for one PDF page.

    ``text`` remains the indexed Markdown. The metadata lets the indexer store
    whether a page was handled by the handwriting path and whether a student
    should review/correct it later.
    """

    text: str
    provider: str
    mode: str
    confidence: float
    needs_review: bool
    unclear_count: int


# Rendering and OpenAI are imported lazily so the module is still
# importable in deploys that haven't installed the optional deps.
def _try_import_pypdfium2():
    try:
        import pypdfium2 as pdfium  # type: ignore[import-not-found]
        return pdfium
    except Exception:  # noqa: BLE001
        return None


def _try_import_openai():
    try:
        from openai import OpenAI  # type: ignore[import-not-found]
        return OpenAI
    except Exception:  # noqa: BLE001
        return None


_VISION_SYSTEM_PROMPT = (
    "You are an OCR + structure extraction system. The user will send a "
    "single page image from a course PDF (university engineering / "
    "physics / math). Extract every readable line of text, math, and "
    "diagram labels into clean Markdown.\n"
    "\n"
    "RULES (read every one):\n"
    "1. Use ATX headings (#, ##) for visually-large headings. The page "
    "   banner (department / institution name) is NOT a heading — only "
    "   the actual content section title is.\n"
    "2. Wrap every formula in $$ ... $$ display math fences. Use proper "
    "   LaTeX: `\\frac{a}{b}` for fractions (NEVER write a fraction as "
    "   `a/b` if the source shows a horizontal fraction bar). Subscripts "
    "   use `_`: `A_S`, `E_M`, `\\delta_K`. Superscripts use `^`: `d^2`. "
    "   Greek letters use TeX commands: `\\tau`, `\\sigma`, `\\delta`, "
    "   `\\mu`, `\\pi` (NOT raw Unicode τ σ δ μ π).\n"
    "3. For two-column FORMULA-LABEL tables (typical of German Formelzettel), "
    "   emit each row as the formula on one line, immediately followed by "
    "   its German/English label on the next. Example:\n"
    "\n"
    "       $$ \\delta_K = \\frac{l'_K}{E_S \\cdot A_N} $$\n"
    "       Nachgiebigkeit des Schraubenkopfes / resilience of the bolt head\n"
    "\n"
    "       $$ \\delta_G = \\frac{0.5 \\cdot d}{E_S \\cdot A_3} $$\n"
    "       Nachgiebigkeit des eingeschraubten Gewindeteils / resilience of the engaged thread\n"
    "\n"
    "4. For decomposition / sum formulas — the sum sign and ALL its "
    "   named terms must appear on the same line:\n"
    "\n"
    "       $$ \\delta_S = \\delta_K + \\sum_{i=1}^{n} \\delta_i + \\delta_G + \\delta_M $$\n"
    "\n"
    "   Never substitute a sub-term's value into the sum (e.g. do NOT "
    "   write `\\delta_S = G \\cdot d / E_S + ...` — `\\delta_K` is a "
    "   symbol, not its definition).\n"
    "5. For case-based formulas (A_ers etc., where the formula depends "
    "   on which inequality is satisfied), render each case as its own "
    "   formula block with the condition above it:\n"
    "\n"
    "       Case: $D_A \\leq d_W$\n"
    "       $$ A_{ers} = \\frac{\\pi}{4}(D_A^2 - d_h^2) $$\n"
    "\n"
    "6. Preserve bullet lists with `-`. Preserve numerical given values "
    "   exactly: `12,5 kN` (keep the comma decimal separator if shown).\n"
    "7. If a region is genuinely unreadable (handwriting, scan artifact, "
    "   stamp obscuring text), write `[unclear]` for THAT region — do NOT "
    "   invent content. Better to skip than to hallucinate.\n"
    "8. Return Markdown only — no commentary, no JSON wrapper, no ``` "
    "   fences around the whole output.\n"
    "9. The Greek-letter rule (#2) applies ONLY when the source actually "
    "   shows a Greek glyph. An italic lowercase Latin letter (a, b, c, "
    "   d, ...) is NOT a Greek letter — it stays as itself. Do NOT promote "
    "   `a` → `\\alpha`, `b` → `\\beta`, `u` → `\\mu`, etc. Context check: "
    "   if the surrounding text uses the symbol as a regular variable name "
    "   (e.g. `a_A` 'Anziehfaktor'), keep it Latin.\n"
    "10. Keep a space between a LaTeX command and a following letter that "
    "    isn't part of the command: write `20 \\mu m`, NOT `20 \\mum`. "
    "    `\\mu` is the Greek letter μ; the trailing `m` is the unit metre, "
    "    a separate token. Same rule for `\\Omega \\cdot m`, `\\pi r`, etc.\n"
    "11. CODE on a slide / page (monospace blocks, listings, function "
    "    signatures, terminal output) → triple-backtick fenced code block "
    "    with a language tag when you can identify it. Example:\n"
    "\n"
    "        ```python\n"
    "        def bfs(graph, start):\n"
    "            visited = set()\n"
    "        ```\n"
    "\n"
    "    Preserve indentation EXACTLY — code semantics depend on it. Never "
    "    wrap code in `$...$` math fences. Inline identifiers in running "
    "    prose (e.g. \"the variable `count` holds…\") use single backticks. "
    "    Language tags to use when recognizable: python, java, c, cpp, "
    "    csharp, javascript, typescript, sql, bash, html, css, rust, go, "
    "    matlab, r. If the language is unclear, omit the tag but still use "
    "    the triple-backtick fence."
)


_HANDWRITING_SYSTEM_PROMPT = (
    "You are a careful handwriting transcription system for university course "
    "notes, worked engineering exercises, formulas, and diagrams. Extract all "
    "readable handwritten and printed content from the single page image into "
    "clean Markdown.\n"
    "\n"
    "RULES:\n"
    "1. Preserve the visual order of the page. Keep short handwritten lines as "
    "separate Markdown lines when line breaks matter.\n"
    "2. Transcribe numbers, units, signs, decimal separators, subscripts, and "
    "formula symbols exactly. Wrap formulas in $$ ... $$ display math fences "
    "when they are standalone.\n"
    "3. Do not clean up a student's math into a different formula. If a crossed "
    "out or overwritten value is visible, transcribe only the final intended "
    "value when clear.\n"
    "4. If a word, value, or symbol is not readable, write [unclear] at that "
    "location. Do not guess.\n"
    "5. Include diagram labels, axis labels, annotations, and arrows as short "
    "lines. If spatial context matters, use brief labels like Diagram label: ...\n"
    "6. Return Markdown only. No commentary, JSON, or outer code fence."
)


def _render_page_to_png(pdfium, pdf_bytes: bytes, page_index: int, dpi: int) -> bytes | None:
    """Render one 0-based page index to PNG bytes. None on failure."""
    try:
        pdf = pdfium.PdfDocument(pdf_bytes)
        try:
            if page_index < 0 or page_index >= len(pdf):
                return None
            page = pdf[page_index]
            # pypdfium2 uses scale (points/inch). 72 pts = 1 inch.
            scale = dpi / 72.0
            bitmap = page.render(scale=scale)
            pil = bitmap.to_pil()
            buf = io.BytesIO()
            pil.save(buf, format="PNG")
            return buf.getvalue()
        finally:
            pdf.close()
    except Exception:  # noqa: BLE001
        log.exception("pypdfium2 render failed for page %s", page_index)
        return None


def _preprocess_handwriting_image(image_bytes: bytes) -> bytes:
    """Improve contrast/edges before sending likely handwritten pages.

    This is intentionally conservative: no aggressive thresholding, because
    pale pencil strokes and light grid paper can disappear if binarised.
    """
    try:
        from PIL import Image, ImageFilter, ImageOps

        with Image.open(io.BytesIO(image_bytes)) as im:
            grey = im.convert("L")
            grey = ImageOps.autocontrast(grey, cutoff=1)
            grey = grey.filter(
                ImageFilter.UnsharpMask(radius=1.1, percent=140, threshold=3)
            )
            rgb = ImageOps.grayscale(grey).convert("RGB")
            buf = io.BytesIO()
            rgb.save(buf, format="PNG", optimize=True)
            return buf.getvalue()
    except Exception:  # noqa: BLE001
        log.exception("handwriting OCR preprocessing failed; using original render")
        return image_bytes


def _vision_extract(client, model: str, image_bytes: bytes, *, mode: str = "standard") -> str:
    """One vision-model call. Returns extracted Markdown or "" on failure."""
    try:
        b64 = base64.b64encode(image_bytes).decode("ascii")
        system_prompt = (
            _HANDWRITING_SYSTEM_PROMPT if mode == "handwriting" else _VISION_SYSTEM_PROMPT
        )
        user_prompt = (
            "Transcribe the handwritten page as Markdown."
            if mode == "handwriting"
            else "Extract the page content as Markdown."
        )
        response = client.chat.completions.create(
            model=model,
            # OCR is a transcription task — temperature 0 for faithful, stable
            # output. The SDK default of 1.0 invites paraphrase / hallucination.
            temperature=0,
            # A dense formula page rendered to LaTeX-heavy Markdown can run
            # long; 2000 truncated the bottom of such pages (and could leave a
            # ``$$`` unclosed, breaking formula detection). 4096 is well within
            # the model's output limit.
            **_token_limit_param(model, 4096),
            messages=[
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_prompt},
                        {
                            "type": "image_url",
                            # ``detail: high`` keeps the full resolution so small
                            # subscripts, fraction bars and diagram labels survive
                            # — the whole reason we OCR these pages.
                            "image_url": {
                                "url": f"data:image/png;base64,{b64}",
                                "detail": "high",
                            },
                        },
                    ],
                },
            ],
        )
        from .usage_meter import record_usage, usage_from_response  # noqa: WPS433
        record_usage(feature="vision_ocr", model=model, **usage_from_response(response))
        choice = response.choices[0] if response.choices else None
        msg = choice.message if choice else None
        raw = (msg.content if msg else "") or ""
        if choice is not None and getattr(choice, "finish_reason", None) == "length":
            log.warning(
                "vision OCR output hit the max_tokens cap — page may be truncated"
            )
        return _post_process_latin_alpha(_strip_outer_code_fence(raw))
    except Exception:  # noqa: BLE001
        log.exception("vision OCR call failed")
        return ""


_UNCLEAR_RE = re.compile(r"\[unclear\]", re.IGNORECASE)
_WORD_RE = re.compile(r"[A-Za-zÄÖÜäöüß]{3,}")
_MATH_SIGNAL_RE = re.compile(r"\$\$|\\frac|\\sum|\\int|[=+\-*/≤≥≈∑∫]")


def _estimate_ocr_confidence(text: str, *, mode: str) -> tuple[float, bool, int]:
    """Cheap page-level confidence signal for review UX.

    Vision OCR does not return token confidences, so this measures whether the
    result contains enough readable structure and how much of it is explicitly
    uncertain. Handwriting starts slightly lower because the risk profile is
    worse than printed OCR.
    """
    if not text or not text.strip():
        return 0.0, True, 0

    unclear = len(_UNCLEAR_RE.findall(text))
    words = len(_WORD_RE.findall(text))
    math = len(_MATH_SIGNAL_RE.findall(text))
    chars = len(text.strip())

    base = 0.78 if mode == "handwriting" else 0.9
    if words >= 20 or chars >= 300:
        base += 0.08
    elif words < 5 and math < 2:
        base -= 0.22
    if math >= 4:
        base += 0.04

    penalty = min(0.55, unclear * (0.12 if mode == "handwriting" else 0.08))
    confidence = max(0.05, min(0.99, base - penalty))
    needs_review = mode == "handwriting" or unclear > 0 or confidence < 0.72
    return round(confidence, 2), needs_review, unclear


# Vision models reliably wrap their answer in a markdown code fence even
# though the prompt explicitly asks for Markdown content (the fence is
# how the chat model "shows" markdown). Without stripping, downstream
# parsing sees ```markdown ## b) $$ F_A=... ``` as one flat code-block
# line and never recognises the heading or the $$ math inside.
_CODE_FENCE_RE = re.compile(
    r"^\s*```(?:markdown|md)?\s*\n(.*?)\n\s*```\s*$",
    re.DOTALL | re.IGNORECASE,
)


# Vision models reliably misread italic lowercase Latin "a" as Greek α in
# engineering fonts (the glyph shapes are nearly identical). Prompt rule
# #9 catches most cases but the visual perception is too strong for some
# variables (`a_A` Anziehfaktor / tightening factor reproducibly comes
# back as `\alpha_A` or `\alpha_a`). This regex narrowly rewrites
# `\alpha_X = <plain dimensionless number>` → `a_X = ...` where:
#   * the assignment is to a unitless decimal (no trailing unit letters / "/")
#   * no other Greek-math signal nearby
# A real `\alpha` assigned to a dimensionless angle would still be wrong
# but those don't appear in our corpus. If a false positive surfaces in
# the eval, narrow the lookahead further.
_LATIN_ALPHA_RE = re.compile(
    r"\\alpha(_[A-Za-z])\s*=\s*([0-9]+(?:[,.][0-9]+)?)"
    r"(?!\s*[A-Za-z/])"  # negative lookahead: no unit / Greek letter after
)


def _post_process_latin_alpha(text: str) -> str:
    """Rewrite `\\alpha_X = <plain number>` to Latin `a_X` when the value
    has no unit. Targets the well-known OCR misread of italic lowercase
    Latin 'a' as Greek alpha (see comment above)."""
    return _LATIN_ALPHA_RE.sub(r"a\1 = \2", text)


def _strip_outer_code_fence(text: str) -> str:
    """If the vision response is wrapped in an outer ```markdown ... ```
    code fence, return the inner content. No-op for already-bare Markdown."""
    if not text:
        return text
    m = _CODE_FENCE_RE.match(text)
    if m:
        return m.group(1).strip()
    return text


_MATHPIX_ENDPOINT = "https://api.mathpix.com/v3/text"
# Mathpix is a raw httpx call, so (unlike the OpenAI SDK, which retries 429/
# 5xx/timeouts itself) we have to retry transient failures ourselves —
# otherwise a single rate-limit blip silently drops that page's formulas.
_MATHPIX_MAX_ATTEMPTS = 3
_MATHPIX_RETRY_STATUS = frozenset({429, 500, 502, 503, 504})


def _mathpix_extract(app_id: str, app_key: str, image_bytes: bytes) -> str:
    """One Mathpix /v3/text page extraction. Returns Markdown or "" on failure.

    Mathpix is purpose-built for math OCR and returns LaTeX directly. We
    request the ``text`` format with ``$$ ... $$`` display fences so the
    output is shape-compatible with the OpenAI vision path.

    Retries up to ``_MATHPIX_MAX_ATTEMPTS`` on transient errors (HTTP 429 /
    5xx and network timeouts) with exponential backoff. Permanent errors
    (4xx other than 429 — bad image, bad credentials) fail fast.
    """
    try:
        import httpx
    except Exception:  # noqa: BLE001
        log.warning("Mathpix OCR requested but httpx is not installed")
        return ""

    b64 = base64.b64encode(image_bytes).decode("ascii")
    payload = {
        "src": f"data:image/png;base64,{b64}",
        "formats": ["text"],
        "math_inline_delimiters": ["$", "$"],
        "math_display_delimiters": ["$$", "$$"],
        "rm_spaces": True,
    }
    headers = {"app_id": app_id, "app_key": app_key}

    last_err: str | None = None
    for attempt in range(1, _MATHPIX_MAX_ATTEMPTS + 1):
        try:
            with httpx.Client(timeout=60.0) as client:
                response = client.post(_MATHPIX_ENDPOINT, headers=headers, json=payload)
            if response.status_code in _MATHPIX_RETRY_STATUS:
                last_err = f"HTTP {response.status_code}"
            else:
                response.raise_for_status()
                return (response.json().get("text") or "").strip()
        except httpx.HTTPStatusError as exc:
            # Non-retryable status (4xx other than 429) — fail fast.
            log.exception("Mathpix OCR call failed (non-retryable): %s", exc)
            return ""
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            last_err = repr(exc)
        except Exception:  # noqa: BLE001
            log.exception("Mathpix OCR call failed")
            return ""

        if attempt < _MATHPIX_MAX_ATTEMPTS:
            time.sleep(min(0.5 * 2 ** (attempt - 1), 4.0))

    log.warning(
        "Mathpix OCR gave up after %d attempts (%s)", _MATHPIX_MAX_ATTEMPTS, last_err
    )
    return ""


def pages_via_vision_results(
    pdf_bytes: bytes,
    page_indices: Iterable[int],
    provider: str = "openai",
) -> dict[int, OcrPageResult]:
    """Run vision OCR on the given 0-based page indices.

    ``provider`` selects the backend:
      * ``"openai"`` — gpt-4o (or whatever ``MINALLO_VISION_OCR_MODEL`` is)
      * ``"mathpix"`` — Mathpix /v3/text, purpose-built for math/formula pages

    Returns ``{page_index: markdown}`` only for pages that succeeded. The
    indexer should ``original_pages[idx] = result[idx]`` for each key in
    the dict and leave the rest alone.

    Silently returns ``{}`` when the feature flag is off, dependencies
    are missing, or the chosen provider has no credentials.
    """
    settings = get_settings()
    if not settings.vision_ocr_enabled:
        log.debug("vision OCR disabled by flag — skipping")
        return {}

    pdfium = _try_import_pypdfium2()
    if pdfium is None:
        log.warning("vision OCR requested but pypdfium2 is not installed")
        return {}

    mode = "handwriting" if provider == "openai_handwriting" else "standard"

    if provider == "mathpix":
        if not (settings.mathpix_app_id and settings.mathpix_app_key):
            log.warning("Mathpix OCR requested but MATHPIX_APP_ID/KEY not set")
            return {}
        extract = lambda png: _mathpix_extract(  # noqa: E731
            settings.mathpix_app_id, settings.mathpix_app_key, png
        )
    elif provider in ("openai", "openai_handwriting"):
        if provider == "openai_handwriting" and not getattr(
            settings, "handwriting_ocr_enabled", True
        ):
            log.debug("handwriting OCR mode disabled by flag; using standard OpenAI OCR")
            provider = "openai"
            mode = "standard"
        if _try_import_openai() is None:
            log.warning("vision OCR requested but openai SDK is not installed")
            return {}
        from .openai_client import get_openai_client
        openai_client = get_openai_client()
        extract = lambda png: _vision_extract(  # noqa: E731
            openai_client, settings.vision_ocr_model, png, mode=mode
        )
    else:
        log.warning("unknown OCR provider %r — skipping", provider)
        return {}

    indices = list(page_indices)
    if not indices:
        return {}
    if len(indices) > settings.vision_ocr_max_pages:
        log.warning(
            "vision OCR capped at %d pages (asked for %d)",
            settings.vision_ocr_max_pages, len(indices),
        )
        indices = indices[: settings.vision_ocr_max_pages]

    # Formula pages go to Mathpix at a higher DPI so small subscripts and
    # fraction bars survive rasterisation; the OpenAI path keeps the cheaper
    # default. ``getattr`` keeps this safe against older Settings stand-ins.
    render_dpi = (
        getattr(settings, "vision_ocr_mathpix_dpi", settings.vision_ocr_render_dpi)
        if provider == "mathpix"
        else getattr(
            settings, "vision_ocr_handwriting_dpi", settings.vision_ocr_render_dpi
        )
        if provider == "openai_handwriting"
        else settings.vision_ocr_render_dpi
    )

    out: dict[int, OcrPageResult] = {}
    for idx in indices:
        png = _render_page_to_png(pdfium, pdf_bytes, idx, render_dpi)
        if not png:
            continue
        if mode == "handwriting":
            png = _preprocess_handwriting_image(png)
        text = extract(png)
        if text and text.strip():
            stripped = text.strip()
            confidence, needs_review, unclear_count = _estimate_ocr_confidence(
                stripped, mode=mode
            )
            out[idx] = OcrPageResult(
                text=stripped,
                provider=provider,
                mode=mode,
                confidence=confidence,
                needs_review=needs_review,
                unclear_count=unclear_count,
            )
    return out


def pages_via_vision(
    pdf_bytes: bytes,
    page_indices: Iterable[int],
    provider: str = "openai",
) -> dict[int, str]:
    """Backward-compatible wrapper returning only Markdown text."""
    return {
        idx: result.text
        for idx, result in pages_via_vision_results(
            pdf_bytes, page_indices, provider=provider
        ).items()
    }


def _looks_structurally_garbled(text: str) -> bool:
    """A page that has plenty of characters but no usable structure.

    Symptom: pdfminer pulled tokens out of reading order from a multi-column
    table or boxed-formula layout. Letter count passes the main ``letters
    < 80`` bar, but the result is gibberish from the model's perspective —
    fractions collapsed, formula→label pairs separated, short identifier
    fragments interleaved.

    Concrete case the heuristic was tuned against (Formelzettel page 8):

        ``δK = ′ lK ES ⋅ AN ′ = 0,5 ⋅ d lK δi = li ES ⋅ Ai δG = 0,5 ⋅ d ES ⋅ A3 …``

    pdfminer's text count says "1474 chars, looks fine", but no model can
    parse that back into the proper ``δ_K = l'_K / (E_S · A_N)`` form
    because the fraction operators are gone and the label column got
    appended to the end of the page.

    The four signals together — formula-heavy (`=`), fraction-starved
    (few `/`), math-flavoured (Greek/operators), and short-token-dense
    (formula fragments) — make false positives unlikely:

      * A prose page with one ``F = ma`` has too few ``=`` (< 4).
      * A list of numerical results (``Wert 1 = 5 mm``) lacks Greek /
        math-operator characters → ``has_math_signal`` False.
      * A clean formula sheet has roughly one ``/`` per ``=`` →
        ``fraction_starved`` False.
    """
    if not text or len(text) < 200:
        return False

    eq_count = text.count("=")
    if eq_count < 4:
        return False  # not a formula-heavy page

    # Look at WHAT comes right after each `=`. On a clean formula sheet
    # almost every `=` is followed within ~15 chars by a fraction marker
    # — `/`, `(`, or `\frac` — because formulas resolve to a bracketed
    # or divided expression. On a column-collapsed extraction the
    # fraction operators are gone, so the RHS is just identifier soup.
    #
    # NB: we deliberately do NOT just count `/` globally — German PDFs
    # have many `/` characters as German/English label separators
    # (e.g. "Vorspannkraftverlust / loss of preload"), which would
    # otherwise hide a genuinely garbled formula run from the heuristic.
    clean_rhs_count = 0
    for m in re.finditer(r"=", text):
        window = text[m.end(): m.end() + 15]
        if "/" in window or "(" in window or "\\frac" in window:
            clean_rhs_count += 1
    # Garbled when fewer than a third of `=` have a fraction-shaped RHS.
    if clean_rhs_count * 3 >= eq_count:
        return False

    # Require some formula DNA — Greek letters or math-typesetting
    # operators (⋅ ± ≤ ≥ ≈ ∑ ∫). Without this, ``Wert 1 = 5 mm`` style
    # numeric lists get false-positive flagged.
    has_math_signal = bool(re.search(r"[α-ωΑ-Ω]|⋅|±|≤|≥|≈|∑|∫", text))
    if not has_math_signal:
        return False

    # Short-token density. Formula sheets that LOST structure dissolve
    # into a soup of 1-3-char identifiers (δK, lK, ES, AN, …). A coherent
    # prose paragraph has plenty of multi-char German/English words.
    tokens = re.findall(r"\w+", text)
    if not tokens:
        return False
    short_tokens = sum(1 for t in tokens if 1 <= len(t) <= 3)
    short_ratio = short_tokens / len(tokens)
    return short_ratio > 0.45


# Image-aware OCR selection tunables. A page in the "sparse text" band
# (>= _OCR_MIN_LETTERS but < _OCR_SPARSE_LETTERS) is a diagram page when the
# rendered page is ink-dense: pdfminer pulled only a caption / a few axis
# labels while the figure that carries the actual problem is invisible to the
# text layer. Engineering exercise sheets are full of these — the old
# letter-count-only rule (flag below _OCR_MIN_LETTERS) let them through and the
# vision model never saw the figure. Measured ink coverage separates a real
# (but short) text page from a figure page; a clean dense-text page never
# enters the band at all so it's never rendered.
_OCR_MIN_LETTERS = 80         # below this: scanned / near-empty → always OCR
_OCR_SPARSE_LETTERS = 300     # 80..300 letters → candidate, decided by ink
_OCR_INK_DENSE_PCT = 2.5      # rendered dark-pixel % above which it's a figure
_OCR_INK_DPI = 72             # cheap render just for the ink measurement


def _page_ink_coverage(pdf_bytes: bytes, page_indices: list[int]) -> dict[int, float]:
    """Render the given 0-based pages at a low DPI and return ``{idx: pct}``
    where pct is the percentage of dark (< 200/255) pixels — a cheap proxy for
    "how much of the page is figure/ink". Empty mapping when rendering deps are
    missing or a render fails; the caller treats a missing entry as 0%."""
    pdfium = _try_import_pypdfium2()
    if pdfium is None:
        return {}
    try:
        from PIL import Image  # noqa: F401  (pypdfium2.to_pil needs it)
    except Exception:  # noqa: BLE001
        return {}
    out: dict[int, float] = {}
    try:
        pdf = pdfium.PdfDocument(pdf_bytes)
    except Exception:  # noqa: BLE001
        log.exception("ink-coverage: failed to open PDF")
        return {}
    try:
        scale = _OCR_INK_DPI / 72.0
        for idx in page_indices:
            try:
                if idx < 0 or idx >= len(pdf):
                    continue
                grey = pdf[idx].render(scale=scale).to_pil().convert("L")
                hist = grey.histogram()
                total = sum(hist) or 1
                dark = sum(hist[:200])
                out[idx] = dark / total * 100.0
            except Exception:  # noqa: BLE001
                log.exception("ink-coverage render failed for page %s", idx)
    finally:
        pdf.close()
    return out


def select_pages_needing_ocr(
    pages: list[str], pdf_bytes: bytes | None = None
) -> list[int]:
    """Helper for the indexer: returns the 0-based indices of pages that
    look bad enough to retry with vision OCR.

    Failure modes covered:
      * Image-heavy / scanned page → pdfminer extracts < 80 letters. Always
        flagged (no render needed).
      * Diagram page with a thin caption → 80..300 letters but the rendered
        page is ink-dense (a figure). Only detectable by looking at the page
        image, so this branch needs ``pdf_bytes``. This is the case that made
        the AI "not see" picture-based exercise sheets.

    When ``pdf_bytes`` is omitted (legacy/text-only callers, unit tests) the
    function falls back to the previous text-only behaviour: < 80 letters OR
    the lexical ``_looks_structurally_garbled`` heuristic. That heuristic is
    NOT used on the image-aware path because it false-positives on clean
    English solution sheets (and would route them to paid OCR); ink coverage
    separates those cases reliably.
    """
    bad: list[int] = []
    sparse_candidates: list[int] = []
    for i, text in enumerate(pages):
        letters = sum(1 for c in (text or "") if c.isalpha())
        if letters < _OCR_MIN_LETTERS:
            bad.append(i)
            continue
        if pdf_bytes is None:
            # Legacy text-only path: keep the old garble heuristic.
            if _looks_structurally_garbled(text):
                bad.append(i)
        elif letters < _OCR_SPARSE_LETTERS:
            # Image-aware path: a short page might be a figure — decide by ink.
            sparse_candidates.append(i)

    if pdf_bytes is not None and sparse_candidates:
        ink = _page_ink_coverage(pdf_bytes, sparse_candidates)
        for i in sparse_candidates:
            if ink.get(i, 0.0) > _OCR_INK_DENSE_PCT:
                bad.append(i)

    return sorted(bad)


_HANDWRITING_NAME_HINTS = (
    "handwritten",
    "handwriting",
    "handschrift",
    "handschriftlich",
    "mitschrift",
    "notizen",
    "notes",
    "scan",
    "scanned",
)


def select_handwriting_candidates(
    file_name: str,
    pages: list[str],
    bad_idx: Iterable[int],
    pdf_bytes: bytes | None = None,
) -> list[int]:
    """Pick OCR pages that should use the handwriting prompt/preprocess path.

    This is conservative and only considers pages already selected for OCR.
    Filename hints win. Without a filename hint, we pick sparse or empty pages
    with visible ink and little equation density; dense formula pages are left
    for the normal OpenAI/Mathpix path.
    """
    indices = [i for i in bad_idx if 0 <= i < len(pages)]
    if not indices:
        return []

    name = (file_name or "").lower()
    if any(hint in name for hint in _HANDWRITING_NAME_HINTS):
        return sorted(indices)

    candidates: list[int] = []
    for idx in indices:
        text = pages[idx] or ""
        letters = sum(1 for c in text if c.isalpha())
        if letters < _OCR_SPARSE_LETTERS and text.count("=") < 4:
            candidates.append(idx)

    if not candidates:
        return []
    if pdf_bytes is None:
        return sorted(candidates)

    ink = _page_ink_coverage(pdf_bytes, candidates)
    return sorted(i for i in candidates if ink.get(i, 0.0) > _OCR_INK_DENSE_PCT)


# Filename markers for the German/English "formula sheet" genre. A doc whose
# name matches is routed to Mathpix under ``formulasheet_only`` even when its
# pdfminer text is empty (scanned) — the filename is the only signal we get
# for an image-only formula sheet.
_FORMULA_NAME_HINTS = (
    "formel",        # Formel, Formelzettel, Formelsammlung
    "formula",
    "cheatsheet",
    "cheat-sheet",
    "cheat_sheet",
    "spickzettel",
)

# Minimum number of `=` across the pages we're about to OCR before the
# content heuristic calls a document a formula sheet. Tuned low because a
# real formula sheet page carries many equations; a prose lecture page with
# one ``F = ma`` stays well under it.
_FORMULA_EQ_THRESHOLD = 8


def _is_formula_sheet(file_name: str, pages: list[str], bad_idx: list[int]) -> bool:
    """True when the document looks like a formula sheet — by filename or by
    the equation density of the pages flagged for OCR."""
    name = (file_name or "").lower()
    if any(hint in name for hint in _FORMULA_NAME_HINTS):
        return True
    # Content signal: measure `=` density on the bad pages specifically (the
    # ones heading to OCR). Fall back to all pages when the bad pages are
    # empty — a scanned formula sheet has no extractable `=` to count, so the
    # filename branch above is its only route to Mathpix.
    sample = [pages[i] for i in bad_idx if 0 <= i < len(pages) and pages[i]]
    if not sample:
        return False
    eq_total = sum(p.count("=") for p in sample)
    return eq_total >= _FORMULA_EQ_THRESHOLD


def choose_ocr_provider(file_name: str, pages: list[str], bad_idx: list[int]) -> str:
    """Pick the OCR backend for this document's bad pages.

    Honours ``settings.mathpix_routing``:
      * ``"off"``               → always OpenAI vision
      * ``"always"``            → Mathpix (when credentials present)
      * ``"formulasheet_only"`` → Mathpix only when the doc looks like a
                                  formula sheet (filename hint or equation
                                  density), else OpenAI

    Falls back to ``"openai"`` whenever Mathpix is requested but its
    credentials are missing, or the routing value is unrecognised — so the
    indexer never silently does nothing.
    """
    settings = get_settings()
    routing = (settings.mathpix_routing or "off").lower()

    if routing == "off":
        return "openai"

    # Mathpix needs both credentials regardless of mode. Without them, the
    # only safe choice is the OpenAI path.
    if not (settings.mathpix_app_id and settings.mathpix_app_key):
        log.info("mathpix_routing=%s but MATHPIX_APP_ID/KEY unset — using OpenAI vision", routing)
        return "openai"

    if routing == "always":
        return "mathpix"

    if routing == "formulasheet_only":
        if _is_formula_sheet(file_name, pages, bad_idx):
            return "mathpix"
        return "openai"

    log.warning("unknown MINALLO_MATHPIX_ROUTING=%r — defaulting to OpenAI vision", routing)
    return "openai"


__all__ = (
    "OcrPageResult",
    "choose_ocr_provider",
    "pages_via_vision",
    "pages_via_vision_results",
    "select_handwriting_candidates",
    "select_pages_needing_ocr",
)
