"""The Caddy access log must never contain credentials (the internal token once leaked there)."""

from __future__ import annotations

import re
from pathlib import Path

CADDYFILE = (Path(__file__).resolve().parents[1] / "deploy" / "Caddyfile").read_text(encoding="utf-8")


def _log_block() -> str:
    m = re.search(r"\blog\s*\{(.*)\n\t\}", CADDYFILE, re.S)
    assert m, "site log block not found"
    return m.group(1)


def test_log_uses_the_filter_encoder_wrapping_json():
    block = _log_block()
    assert re.search(r"format\s+filter\s*\{", block)
    assert re.search(r"wrap\s+json", block)
    assert not re.search(r"format\s+json\b", block), "plain json encoder would log every header"


def test_credential_headers_are_deleted_from_the_log():
    block = _log_block()
    for header in ("X-Internal-Token", "Authorization", "Cookie"):
        assert re.search(rf"request>headers>{header}\s+delete", block), header
    assert re.search(r"resp_headers>Set-Cookie\s+delete", block)


def test_caddyfile_does_not_embed_a_secret_value():
    assert not re.search(r"X-Internal-Token\s+[\"'A-Za-z0-9_-]{20,}", CADDYFILE.replace("delete", ""))
