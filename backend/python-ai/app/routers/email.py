"""Welcome email on first successful login.

The browser calls POST /welcome-email directly (like /ask-stream) with the
user's Supabase JWT after a successful sign-in. Sent-once semantics live in
the auth user's app_metadata (welcome_email_sent_at) — no schema migration,
and the flag is visible to the frontend on every token verify, so repeat
calls are cheap no-ops. Email goes out over the same Zoho SMTP account the
Supabase auth mailer uses (app password in SMTP_PASSWORD).
"""

from __future__ import annotations

import logging
import smtplib
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from ..config import get_settings
from ..jwt_auth import verify_supabase_jwt

log = logging.getLogger(__name__)

router = APIRouter(prefix="", tags=["email"])

_APP_URL = "https://minallo.de"

_COPY = {
    "en": {
        "subject": "Welcome to Minallo 🎉",
        "title": "Welcome to Minallo!",
        "body": (
            "Your account is ready. Upload your lecture PDFs and Minallo turns "
            "them into summaries, cheatsheets, flashcards and quizzes — with an "
            "AI tutor that answers from your own course material."
        ),
        "cta": "Start studying",
        "footer": "You received this email because an account was created on minallo.de with this address.",
    },
    "de": {
        "subject": "Willkommen bei Minallo 🎉",
        "title": "Willkommen bei Minallo!",
        "body": (
            "Dein Konto ist startklar. Lade deine Vorlesungs-PDFs hoch und "
            "Minallo macht daraus Zusammenfassungen, Cheatsheets, Karteikarten "
            "und Quizze — mit einem KI-Tutor, der aus deinen eigenen Unterlagen "
            "antwortet."
        ),
        "cta": "Jetzt lernen",
        "footer": "Du erhältst diese E-Mail, weil mit dieser Adresse ein Konto auf minallo.de erstellt wurde.",
    },
}


class WelcomeRequest(BaseModel):
    language: str | None = None


def _build_message(to_email: str, lang: str) -> EmailMessage:
    settings = get_settings()
    copy = _COPY.get(lang, _COPY["en"])
    msg = EmailMessage()
    msg["Subject"] = copy["subject"]
    msg["From"] = formataddr((settings.smtp_from_name, settings.smtp_from_email))
    msg["To"] = to_email
    msg.set_content(f"{copy['title']}\n\n{copy['body']}\n\n{copy['cta']}: {_APP_URL}\n\n{copy['footer']}\n")
    msg.add_alternative(
        f"""\
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Helvetica,Arial,sans-serif;">
    <div style="max-width:560px;margin:0 auto;padding:32px 16px;">
      <div style="background:linear-gradient(135deg,#1d4ed8,#0ea5e9);border-radius:14px 14px 0 0;padding:28px 32px;">
        <div style="color:#ffffff;font-size:22px;font-weight:700;">🦉 Minallo</div>
      </div>
      <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:32px;color:#0f172a;">
        <h1 style="margin:0 0 12px;font-size:20px;">{copy["title"]}</h1>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#334155;">{copy["body"]}</p>
        <a href="{_APP_URL}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 28px;border-radius:10px;">{copy["cta"]} →</a>
      </div>
      <p style="margin:18px 8px 0;font-size:12px;color:#94a3b8;text-align:center;">{copy["footer"]}</p>
    </div>
  </body>
</html>
""",
        subtype="html",
    )
    return msg


def _send_smtp(msg: EmailMessage) -> None:
    settings = get_settings()
    with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=20) as smtp:
        smtp.login(settings.smtp_username or "", settings.smtp_password or "")
        smtp.send_message(msg)


async def _mark_welcome_sent(user_id: str) -> None:
    """Stamp app_metadata.welcome_email_sent_at via the GoTrue admin API.

    GoTrue merges metadata maps key-wise, so this never clobbers other
    app_metadata (provider info etc.).
    """
    settings = get_settings()
    url = settings.supabase_url.rstrip("/") + f"/auth/v1/admin/users/{user_id}"
    headers = {
        "apikey": settings.supabase_service_role_key,
        "Authorization": f"Bearer {settings.supabase_service_role_key}",
        "Content-Type": "application/json",
    }
    payload = {"app_metadata": {"welcome_email_sent_at": datetime.now(timezone.utc).isoformat()}}
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.put(url, headers=headers, json=payload)
    if r.status_code >= 300:
        # Non-fatal: the email went out; worst case a later call is a repeat
        # attempt that the localStorage guard on the client usually prevents.
        log.warning("welcome-email: could not stamp app_metadata (%s)", r.status_code)


@router.post("/welcome-email")
async def welcome_email(
    payload: WelcomeRequest,
    user: dict[str, Any] = Depends(verify_supabase_jwt),
) -> dict[str, Any]:
    settings = get_settings()
    if not settings.welcome_email_enabled:
        return {"sent": False, "reason": "disabled"}
    if not settings.smtp_username or not settings.smtp_password:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SMTP is not configured",
        )

    email = (user.get("email") or "").strip()
    if not email:
        return {"sent": False, "reason": "no_email"}
    # Only confirmed accounts get the welcome (signup confirmation comes first).
    if not user.get("email_confirmed_at") and not user.get("confirmed_at"):
        return {"sent": False, "reason": "unconfirmed"}
    if (user.get("app_metadata") or {}).get("welcome_email_sent_at"):
        return {"sent": False, "reason": "already_sent"}

    lang = (payload.language or "en").lower()
    lang = "de" if lang.startswith("de") else "en"
    msg = _build_message(email, lang)
    try:
        await run_in_threadpool(_send_smtp, msg)
    except Exception as e:  # noqa: BLE001 — surface as 502, log the cause
        log.error("welcome-email: SMTP send failed: %s", e)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Email send failed")
    await _mark_welcome_sent(str(user["id"]))
    log.info("welcome-email: sent to user %s", user["id"])
    return {"sent": True}
