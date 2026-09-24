"""Read-only diagnostic: for a given email, show how many files the user
uploaded and a per-feature/model breakdown of their metered AI usage + cost.

Usage:  python scripts/lookup_user_usage.py <email>

Cost is derived from token counts with the same per-model prices the admin
dashboard uses (backend/lib/admin-stats.ts MODEL_PRICES_CENTS_PER_M).
Purely SELECTs — never writes.
"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from app.supabase_client import get_supabase  # noqa: E402

# cents per 1M tokens — mirror of admin-stats.ts (prefix-matched, longest first)
PRICES = [
    ("gpt-4o-mini", (15, 7.5, 60)),
    ("gpt-4o", (250, 125, 1000)),
    ("gpt-4.1-mini", (40, 10, 160)),
    ("gpt-4.1-nano", (10, 2.5, 40)),
    ("gpt-4.1", (200, 50, 800)),
    ("o4-mini", (110, 27.5, 440)),
    ("o3-mini", (110, 55, 440)),
    ("text-embedding-3-small", (2, 2, 0)),
    ("text-embedding-3-large", (13, 13, 0)),
]


def price(model: str):
    m = (model or "").lower()
    for prefix, p in PRICES:
        if m.startswith(prefix):
            return p
    return (200, 50, 800)  # fallback ~gpt-4.1


def cost_eur(model, prompt, cached, out):
    pin, pcached, pout = price(model)
    cached = min(cached or 0, prompt or 0)
    cents = ((prompt - cached) * pin + cached * pcached + (out or 0) * pout) / 1_000_000
    return cents / 100


def resolve_user_id(sb, email: str) -> str | None:
    page = 1
    while page <= 100:
        resp = sb.auth.admin.list_users(page=page, per_page=200)
        users = resp.users if hasattr(resp, "users") else resp
        if not users:
            break
        for u in users:
            if (u.email or "").lower() == email.lower():
                return u.id
        page += 1
    return None


def main() -> None:
    email = sys.argv[1] if len(sys.argv) > 1 else "saklyfedi3@gmail.com"
    sb = get_supabase()

    uid = resolve_user_id(sb, email)
    if not uid:
        print(f"No user found for {email}")
        return
    print(f"User: {email}\nuser_id: {uid}\n")

    # ── Files uploaded ────────────────────────────────────────────────────
    docs = (sb.table("documents")
            .select("id, file_name, course_id, created_at")
            .eq("user_id", uid).order("created_at").execute().data) or []
    print(f"FILES UPLOADED: {len(docs)}")
    for d in docs:
        # page count per doc (best-effort)
        try:
            pc = (sb.table("document_pages").select("id", count="exact")
                  .eq("document_id", d["id"]).execute().count)
        except Exception:
            pc = "?"
        print(f"  - {d.get('file_name','?')}  [{pc} pages]  course={d.get('course_id','?')}  {d.get('created_at','')[:19]}")
    print()

    # ── Metered AI usage ──────────────────────────────────────────────────
    rows = (sb.table("usage_events")
            .select("feature, model, prompt_tokens, completion_tokens, cached_tokens")
            .eq("user_id", uid).limit(500000).execute().data) or []
    agg: dict[tuple, list] = {}
    for r in rows:
        k = (r.get("feature", "?"), r.get("model", "?"))
        a = agg.setdefault(k, [0, 0, 0, 0, 0.0])  # calls, in, cached, out, eur
        a[0] += 1
        a[1] += r.get("prompt_tokens") or 0
        a[2] += r.get("cached_tokens") or 0
        a[3] += r.get("completion_tokens") or 0
        a[4] += cost_eur(r.get("model", ""), r.get("prompt_tokens") or 0,
                         r.get("cached_tokens") or 0, r.get("completion_tokens") or 0)

    print(f"METERED AI EVENTS: {len(rows)}")
    print(f"{'FEATURE':22}{'MODEL':18}{'CALLS':>6}{'IN':>9}{'CACHED':>8}{'OUT':>8}{'COST€':>9}")
    total = 0.0
    for k, a in sorted(agg.items(), key=lambda kv: kv[1][4], reverse=True):
        total += a[4]
        print(f"{k[0]:22}{k[1]:18}{a[0]:>6}{a[1]:>9}{a[2]:>8}{a[3]:>8}{a[4]:>9.4f}")
    print(f"{'TOTAL':22}{'':18}{'':>6}{'':>9}{'':>8}{'':>8}{total:>9.4f}")


if __name__ == "__main__":
    main()
