# -*- coding: utf-8 -*-
"""Bank enforcement + broken-formula gate, using the exact broken strings that
reached the Technische Mechanik 2 PDF."""

from app.services.cheatsheet import (
    enforce_formula_bank,
    ensure_method_picker_targets,
    ensure_drehimpuls_section,
    localize_section_labels,
    _broken_formula_reasons,
)

DREHIMPULS = (
    "## Drehimpuls\n"
    "**Use when:** Analyzing systems with angular momentum and torque.\n"
    "**Formulas:**\n"
    "L_A = θ_Ang \\theta\n"
    "sumM_A = dL_A/dt\n"
    "**Conditions:** Reference point must be chosen.\n"
)

TRAEG = (
    "## Trägheitsmoment\n"
    "**Formulas:**\n"
    "θ = integralr²dm\n"
    "**Conditions:** Mass distribution must be defined.\n"
)

ARBEIT = (
    "## Arbeit, Energie und Leistung\n"
    "**Formulas:**\n"
    "$dW = Fdvecr$\n"
    "**Watch out:** Friction work is negative.\n"
)

CLEAN = (
    "## Kartesische Koordinaten\n"
    "**Use when:** Describing motion.\n"
    "**Formulas:**\n"
    r"$\vec r = x\,\vec e_x + y\,\vec e_y + z\,\vec e_z$" "\n"
    r"$\vec v = \dot x\,\vec e_x + \dot y\,\vec e_y + \dot z\,\vec e_z$" "\n"
    r"$\vec a = \ddot x\,\vec e_x + \ddot y\,\vec e_y + \ddot z\,\vec e_z$" "\n"
    "**Conditions:** 3D motion requires all components.\n"
)


def test_broken_detection():
    assert _broken_formula_reasons(DREHIMPULS)      # raw \theta
    assert _broken_formula_reasons(TRAEG)           # prose word "integral"
    assert not _broken_formula_reasons(CLEAN)       # all clean $...$


def test_drehimpuls_rewritten_to_bank():
    out, n = enforce_formula_bank(DREHIMPULS, ["Drehimpuls"])
    assert n == 1
    assert r"$\vec L_A = \Theta_A \vec\omega$" in out
    assert r"$\sum \vec M_A = \frac{d\vec L_A}{dt}$" in out
    # the broken lines are gone
    assert "sumM_A" not in out
    assert "integral" not in out
    assert "\\theta" not in out.split("**Conditions")[0]
    # prose preserved
    assert "**Use when:**" in out
    assert "**Conditions:**" in out


def test_traeg_and_arbeit_get_canonical():
    out, _ = enforce_formula_bank(TRAEG, ["Trägheitsmoment"])
    assert r"$\Theta = \int r^2\,dm$" in out
    assert "integralr" not in out
    out2, _ = enforce_formula_bank(ARBEIT, ["Arbeit, Energie und Leistung"])
    assert r"$dW = \vec F \cdot d\vec r$" in out2
    assert "Fdvecr" not in out2


def test_clean_section_untouched():
    out, n = enforce_formula_bank(CLEAN, ["Kartesische Koordinaten"])
    assert n == 0
    assert out == CLEAN


def test_method_picker_injects_missing_targets():
    sheet = (
        "## Method Picker\n"
        "| Given | Use |\n|---|---|\n"
        "| Known path / constraint | Tangential-normal coordinates |\n"
        "| Central force / rotation | Polar coordinates |\n\n"
        "## Drehimpuls\n**Formulas:**\n"
        r"$\vec L_A = \Theta_A \vec\omega$" "\n"
    )
    cfg = {"formulaDriven": True}
    out, n = ensure_method_picker_targets(sheet, [], cfg)
    assert n == 2
    assert "## Polarkoordinaten" in out
    assert "## Tangential- und Normalkoordinaten" in out


def test_traegheitsmoment_strict_removes_drehimpuls_leak():
    # Model folded angular-momentum + rotational-energy formulas into Trägheitsmoment.
    sheet = (
        "## Trägheitsmoment\n"
        "**Concept:** Resistance to angular acceleration.\n"
        "**Formulas:**\n"
        r"$\Theta = \int r^2\,dm$" "\n"
        r"$\theta = \frac{dL}{dt}$" "\n"          # Drehimpuls leak
        r"$\theta = \frac{1}{2}\theta_a\beta^2$" "\n"  # rotational-energy leak
        r"$\Theta = mr^2$" "\n"                    # point-mass special case
        "**Conditions:** Mass distribution known.\n"
    )
    out, n = enforce_formula_bank(sheet, ["Trägheitsmoment"])
    assert n == 1
    # Only the canonical Trägheitsmoment bank remains.
    assert r"$\Theta = \int r^2\,dm$" in out
    assert r"$\Theta_A = \Theta_S + m d^2$" in out
    assert r"$E_{rot} = \tfrac{1}{2}\Theta\omega^2$" in out
    assert "dL" not in out and "beta" not in out and "mr^2" not in out
    # Prose preserved.
    assert "**Concept:**" in out and "**Conditions:**" in out


def test_drehimpuls_injected_when_rotation_present_and_missing():
    sheet = (
        "## Trägheitsmoment\n**Formulas:**\n"
        r"$\Theta = \int r^2\,dm$" "\n"
    )
    out, n = ensure_drehimpuls_section(sheet, {"formulaDriven": True})
    assert n == 1
    assert "## Drehimpuls" in out
    assert r"$\vec L_A = \Theta_A \vec\omega$" in out


def test_drehimpuls_not_injected_when_already_present():
    sheet = (
        "## Trägheitsmoment\n**Formulas:**\n"
        r"$\Theta = \int r^2\,dm$" "\n\n"
        "## Drehimpuls\n**Formulas:**\n"
        r"$\vec L_A = \Theta_A \vec\omega$" "\n"
    )
    out, n = ensure_drehimpuls_section(sheet, {"formulaDriven": True})
    assert n == 0
    assert out.count("## Drehimpuls") == 1


def test_localize_labels_de():
    md = (
        "## Polarkoordinaten\n"
        "**Use when:** radial motion.\n"
        "**Formulas:**\n$r = r e_r$\n"
        "**Conditions:** basis vectors are time-dependent.\n"
        "**Watch out:** do not forget 2ṙφ̇.\n"
        "Important: keep the reference point fixed.\n"
    )
    out = localize_section_labels(md, "de")
    assert "**Anwenden bei:**" in out
    assert "**Formeln:**" in out
    assert "**Bedingungen:**" in out
    assert "**Achtung:**" in out
    # English emphasis markers are NOT touched (renderer keys styling off them).
    assert "Important: keep the reference point fixed." in out
    # No-op for non-German.
    assert localize_section_labels(md, "source") == md
    assert localize_section_labels(md, "en") == md


def test_method_picker_no_dupe_when_present():
    sheet = (
        "## Method Picker\n| Given | Use |\n|---|---|\n"
        "| Central force / rotation | Polar coordinates |\n\n"
        "## Polarkoordinaten\n**Formulas:**\n"
        r"$\vec r = r\,\vec e_r$" "\n"
    )
    out, n = ensure_method_picker_targets(sheet, [], {"formulaDriven": True})
    assert n == 0
    assert out.count("## Polarkoordinaten") == 1
