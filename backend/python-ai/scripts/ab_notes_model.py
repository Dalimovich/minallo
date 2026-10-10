"""A/B the exam-grade notes summary on o4-mini vs gpt-4o-mini.

Uses the REAL notes pipeline pieces (_fetch_chunks, _build_context,
_summary_prompt) so the only variable is the model. Picks the most
content-rich indexed document automatically (or pass a document_id arg).

Writes nothing to the DB; saves both outputs to scripts/ab_out_*.md and
prints token counts + derived cost. Costs a few cents in OpenAI calls.
"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from app.supabase_client import get_supabase
from app.services.openai_client import get_openai_client
from app.routers.notes_full import _fetch_chunks, _build_context, _summary_prompt

PRICES = {  # cents per 1M (in, out)
    "o4-mini": (110, 440),
    "gpt-4o-mini": (15, 60),
}


def pick_document(sb, doc_id_arg: str | None):
    if doc_id_arg:
        d = sb.table("documents").select("id, file_name, user_id, course_id").eq("id", doc_id_arg).single().execute().data
        return d
    docs = sb.table("documents").select("id, file_name, user_id, course_id").limit(100).execute().data or []
    best, best_n = None, -1
    for d in docs:
        n = sb.table("document_chunks").select("id", count="exact").eq("document_id", d["id"]).execute().count or 0
        if n > best_n:
            best, best_n = d, n
    print(f"Picked most content-rich doc: {best.get('file_name')} ({best_n} chunks)\n")
    return best


def run_model(client, model: str, system: str, user: str) -> tuple[str, int, int]:
    if model.startswith(("o4", "o3")):
        resp = client.chat.completions.create(
            model=model, reasoning_effort="low", max_completion_tokens=8000,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        )
    else:
        resp = client.chat.completions.create(
            model=model, temperature=0.3, max_tokens=8000,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        )
    text = resp.choices[0].message.content or ""
    u = resp.usage
    return text, u.prompt_tokens, u.completion_tokens


def cost_eur(model, pin, pout):
    cin, cout = PRICES[model]
    return (pin * cin + pout * cout) / 1_000_000 / 100


def main() -> None:
    sb = get_supabase()
    doc = pick_document(sb, sys.argv[1] if len(sys.argv) > 1 else None)
    ps = int(sys.argv[2]) if len(sys.argv) > 2 else None
    pe = int(sys.argv[3]) if len(sys.argv) > 3 else None
    chunks = _fetch_chunks(doc["user_id"], doc["course_id"], doc["id"], ps, pe)
    context, _ = _build_context(chunks, doc.get("file_name"))
    if len(context) < 500:
        print("Not enough indexed content to summarize. Try another doc.")
        return

    # Detect language crudely for the prompt; instruction text is German in the
    # real handler regardless, and both models get identical input either way.
    lang = "de" if sum(context.lower().count(w) for w in (" der ", " und ", " die ", " mit ")) > 5 else "en"
    system = _summary_prompt(lang, "exam")
    instr = (
        "Erstelle eine vollständige Prüfungszusammenfassung aus dem obigen Text. "
        "Gehe JEDE Seite systematisch durch. Erfasse ALLE Definitionen, DIN-Klassifikationen, "
        "Formeln, Verfahren, Werkstoffeigenschaften, Diagramme und Vergleiche. "
        "Überspringe KEINE Seite und KEIN Konzept."
    )
    user = f"PDF-INHALT:\n\n{context}\n\n{instr}"
    print(f"context chars={len(context)}  chunks={len(chunks)}  lang={lang}\n")

    client = get_openai_client()
    out_dir = Path(__file__).resolve().parent
    for model in ("o4-mini", "gpt-4o-mini"):
        print(f"--- generating with {model} ---")
        text, pin, pout = run_model(client, model, system, user)
        (out_dir / f"ab_out_{model}.md").write_text(text, encoding="utf-8")
        words = len(text.split())
        headings = text.count("\n#")
        print(f"  in={pin} out={pout} cost={cost_eur(model, pin, pout):.4f} EUR  "
              f"words={words} headings={headings} chars={len(text)}")
        print(f"  -> saved scripts/ab_out_{model}.md\n")


if __name__ == "__main__":
    main()
