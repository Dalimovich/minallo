"""The onboarding/Profile structure preview is generated from the profile files and may never drift.

Regenerate the data block with:  UPDATE_EXAM_PREVIEW=1 pytest tests/test_german_exam_structure_preview.py
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from app.services.german_exams import GERMAN_EXAM_PROFILES, build_manifest

PATH = Path(__file__).resolve().parents[3] / "frontend/js/features/german-exam/exam-structure-preview.ts"
BLOCK = re.compile(r"(/\* GENERATED:BEGIN \*/\n)(.*?)(\n/\* GENERATED:END \*/)", re.S)


def _expected() -> dict:
    out = {}
    for pid, profile in GERMAN_EXAM_PROFILES.items():
        if not profile.legacy_level_values:  # no level-based selection resolves to it (e.g. Digital TestDaF)
            continue
        m = build_manifest(profile)
        out[pid] = {
            "profileId": pid,
            "displayName": m["displayName"],
            "family": m["family"],
            "levels": list(profile.legacy_level_values),
            "disclaimer": (m.get("presentation") or {}).get("disclaimer"),
            "modules": [{"id": x["id"], "code": x.get("code"), "label": x["label"], "partCount": len(x["parts"])} for x in m["modules"]],
        }
    return out


def _render(data: dict) -> str:
    return "export const EXAM_STRUCTURE_PREVIEW: Record<string, ExamStructurePreview> = " + json.dumps(data, indent=2, ensure_ascii=False) + ";"


def test_preview_data_matches_the_profiles() -> None:
    src = PATH.read_text(encoding="utf8")
    if os.environ.get("UPDATE_EXAM_PREVIEW") == "1":
        src = BLOCK.sub(lambda m: m.group(1) + _render(_expected()) + m.group(3), src)
        PATH.write_text(src, encoding="utf8")
    body = BLOCK.search(src).group(2)
    assert body == _render(_expected()), "exam-structure-preview.ts drifted from the profile files; regenerate it"


def test_dsh_preview_has_the_dsh_structure_and_no_sprachbausteine() -> None:
    dsh = _expected()["dsh"]
    assert [(m["code"], m["label"]) for m in dsh["modules"]] == [
        ("HV", "Hörverstehen"), ("LV", "Leseverstehen"), ("WS", "Wissenschaftssprachliche Strukturen"), ("TP", "Textproduktion"), (None, "Mündliche Prüfung")]
    assert dsh["levels"] == ["DSH-1", "DSH-2", "DSH-3"]
    assert "sprachbaustein" not in json.dumps(dsh).lower()
