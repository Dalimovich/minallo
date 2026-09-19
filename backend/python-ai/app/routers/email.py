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

# Copy + feature cards mirror the "Confirm signup" template the user set up in
# Supabase (dark navy card, cyan accent, ✦ wordmark) so both emails read as one
# brand. No CTA button by design — the user is already signed in when this lands.
_COPY = {
    "en": {
        "subject": "Welcome to Minallo 🎉",
        "title": "Welcome to Minallo!",
        "body": (
            "Your account is ready. Upload your course materials and Minallo "
            "turns them into everything you need to study smarter."
        ),
        "features_label": "What you can do on Minallo",
        "features": [
            ("✨", "AI Course Explainer",
             "Ask questions and get answers based on your uploaded course materials."),
            ("🧠", "Quizzes & Flashcards",
             "Generate practice questions and memory cards from your documents."),
            ("📄", "Cheatsheets & Summaries",
             "Compress complex course topics into compact exam-ready study sheets."),
            ("📝", "PDF Workspace & Notes",
             "Read, annotate and turn lectures into clean AI notes."),
            ("⏱️", "Focus Mode & German Practice",
             "Pomodoro sessions, streaks, and vocabulary & grammar training."),
        ],
        "footer": "You received this email because an account was created on minallo.de with this address.",
    },
    "de": {
        "subject": "Willkommen bei Minallo 🎉",
        "title": "Willkommen bei Minallo!",
        "body": (
            "Dein Konto ist startklar. Lade deine Kursunterlagen hoch und "
            "Minallo macht daraus alles, was du zum smarteren Lernen brauchst."
        ),
        "features_label": "Das kannst du auf Minallo machen",
        "features": [
            ("✨", "KI-Kurs-Erklärer",
             "Stelle Fragen und erhalte Antworten auf Basis deiner hochgeladenen Kursunterlagen."),
            ("🧠", "Quizze & Karteikarten",
             "Erstelle Übungsfragen und Lernkarten aus deinen Dokumenten."),
            ("📄", "Cheatsheets & Zusammenfassungen",
             "Komprimiere komplexe Kursthemen in kompakte, klausurfertige Lernblätter."),
            ("📝", "PDF-Arbeitsbereich & Notizen",
             "Lies, markiere und verwandle Vorlesungen in saubere KI-Notizen."),
            ("⏱️", "Fokus-Modus & Deutsch-Übungen",
             "Pomodoro-Sessions, Streaks sowie Vokabel- und Grammatiktraining."),
        ],
        "footer": "Du erhältst diese E-Mail, weil mit dieser Adresse ein Konto auf minallo.de erstellt wurde.",
    },
}


class WelcomeRequest(BaseModel):
    language: str | None = None


def _feature_card_html(icon: str, title: str, desc: str) -> str:
    return f"""\
        <tr>
          <td style="padding:0 26px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#101f36;border:1px solid #274f7e;border-radius:18px;">
              <tr>
                <td width="64" align="center" valign="top" style="padding:20px 0 20px 18px;font-size:28px;line-height:32px;">
                  {icon}
                </td>
                <td valign="top" style="padding:20px 20px 20px 8px;">
                  <h3 style="margin:0;color:#ffffff;font-size:18px;line-height:24px;font-weight:800;">
                    {title}
                  </h3>
                  <p style="margin:7px 0 0;color:#aab8cc;font-size:14px;line-height:22px;">
                    {desc}
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td height="12" style="font-size:12px;line-height:12px;">&nbsp;</td>
        </tr>"""


def _build_message(to_email: str, lang: str) -> EmailMessage:
    settings = get_settings()
    copy = _COPY.get(lang, _COPY["en"])
    msg = EmailMessage()
    msg["Subject"] = copy["subject"]
    msg["From"] = formataddr((settings.smtp_from_name, settings.smtp_from_email))
    msg["To"] = to_email

    plain_features = "\n".join(f"  • {t}: {d}" for _, t, d in copy["features"])
    msg.set_content(
        f"{copy['title']}\n\n{copy['body']}\n\n{copy['features_label']}:\n"
        f"{plain_features}\n\n{_APP_URL}\n\n{copy['footer']}\n"
    )

    cards = "\n".join(_feature_card_html(i, t, d) for i, t, d in copy["features"])
    msg.add_alternative(
        f"""\
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0;padding:0;background:#07111f;">
  <tr>
    <td align="center" style="padding:28px 12px;font-family:Arial,Helvetica,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:620px;width:100%;background:#0e1a2d;border:1px solid #244166;border-radius:28px;overflow:hidden;">

        <tr>
          <td style="height:5px;background:#42d7e7;line-height:5px;font-size:5px;">&nbsp;</td>
        </tr>

        <tr>
          <td align="center" style="padding:38px 26px 10px;">
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" valign="middle" style="width:44px;height:44px;background:#132845;border:1px solid #315985;border-radius:14px;color:#42d7e7;font-size:25px;font-weight:700;line-height:44px;">
                  ✦
                </td>
                <td width="12"></td>
                <td valign="middle" style="font-size:28px;line-height:32px;font-weight:800;color:#f4f8ff;letter-spacing:-0.6px;">
                  Minallo
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td align="center" style="padding:28px 28px 0;">
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="width:70px;height:70px;background:#122743;border:1px solid #2a527e;border-radius:22px;color:#42d7e7;font-size:34px;line-height:70px;">
                  🎉
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td align="center" style="padding:24px 30px 0;">
            <h1 style="margin:0;padding:0;color:#ffffff;font-size:42px;line-height:46px;font-weight:800;letter-spacing:-1.5px;">
              {copy["title"]}
            </h1>
          </td>
        </tr>

        <tr>
          <td align="center" style="padding:18px 34px 0;">
            <p style="margin:0;color:#aab8cc;font-size:17px;line-height:28px;">
              {copy["body"]}
            </p>
          </td>
        </tr>

        <tr>
          <td align="center" style="padding:34px 26px 18px;">
            <p style="margin:0;color:#7fcef1;font-size:13px;line-height:18px;font-weight:800;letter-spacing:2px;text-transform:uppercase;">
              {copy["features_label"]}
            </p>
          </td>
        </tr>

{cards}

        <tr>
          <td style="padding:22px 26px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="height:1px;background:#244166;line-height:1px;font-size:1px;">&nbsp;</td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td align="center" style="padding:22px 28px 34px;">
            <p style="margin:0;color:#7f8ca2;font-size:14px;line-height:22px;">
              © 2026 Minallo · Built for students<br>
              <a href="{_APP_URL}" style="color:#8fc7ff;text-decoration:none;">minallo.de</a>
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
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
