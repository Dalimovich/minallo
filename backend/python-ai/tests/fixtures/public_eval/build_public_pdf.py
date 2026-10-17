"""Build Minallo's anonymized, redistributable PDF evaluation corpus.

The PDFs contain only synthetic engineering exercises authored for this
repository.  Generating them deterministically keeps binary fixtures reviewable
while tests still exercise real PDF parsing and rendering.
"""

from __future__ import annotations

from pathlib import Path


def build_pdf(lines: list[tuple[int, int, int, str]]) -> bytes:
    """Return a one-page PDF with Helvetica text at explicit PDF coordinates."""
    commands = ["BT"]
    for x, y, size, text in lines:
        escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        commands.extend((f"/F1 {size} Tf", f"1 0 0 1 {x} {y} Tm", f"({escaped}) Tj"))
    commands.append("ET")
    stream = "\n".join(commands).encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"
        ),
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n"
        + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode("ascii"))
        output.extend(obj)
        output.extend(b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref}\n%%EOF\n"
        ).encode("ascii")
    )
    return bytes(output)


def build_multipage_pdf(
    pages: list[list[tuple[int, int, int, str]]],
) -> bytes:
    """Return a deterministic multi-page PDF used by ranking evaluations."""
    page_count = len(pages)
    page_object_ids = list(range(3, 3 + page_count))
    content_object_ids = list(range(3 + page_count, 3 + page_count * 2))
    font_object_id = 3 + page_count * 2
    kids = " ".join(f"{object_id} 0 R" for object_id in page_object_ids)
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {page_count} >>".encode("ascii"),
    ]
    for content_id in content_object_ids:
        objects.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                f"/Resources << /Font << /F1 {font_object_id} 0 R >> >> "
                f"/Contents {content_id} 0 R >>"
            ).encode("ascii")
        )
    for lines in pages:
        commands = ["BT"]
        for x, y, size, text in lines:
            escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            commands.extend((f"/F1 {size} Tf", f"1 0 0 1 {x} {y} Tm", f"({escaped}) Tj"))
        commands.append("ET")
        stream = "\n".join(commands).encode("ascii")
        objects.append(
            b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n"
            + stream + b"\nendstream"
        )
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode("ascii"))
        output.extend(obj)
        output.extend(b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref}\n%%EOF\n"
        ).encode("ascii")
    )
    return bytes(output)


def write_corpus(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "numerical_selection_580.pdf").write_bytes(build_pdf([
        (72, 742, 13, "Synthetic evaluation document - CC0"),
        (72, 700, 16, "Exercise 13.11"),
        (72, 670, 16, "Cutting speed vc = 580 m/min"),
        (72, 640, 14, "Diameter D = 40 mm"),
    ]))
    (root / "symbols_and_units.pdf").write_bytes(build_pdf([
        (72, 720, 16, "Exercise 2.4b"),
        (72, 680, 16, "sigma = -12.5 MPa"),
        (72, 645, 16, "Diameter = 80 mm; exponent n = 2"),
    ]))
    ranking_pages: list[list[tuple[int, int, int, str]]] = []
    for page in range(1, 27):
        if page <= 6:
            label = (
                "Table of contents and course overview"
                if page == 2
                else "Welcome and learning objectives"
            )
        else:
            label = (
                f"Exercise {page - 6}.1 - calculate F = {page * 10} N "
                f"and diameter D = {page + 20} mm"
            )
        ranking_pages.append([(72, 700, 15, label)])
    (root / "ocr_priority_26_pages.pdf").write_bytes(
        build_multipage_pdf(ranking_pages)
    )


if __name__ == "__main__":
    write_corpus(Path(__file__).resolve().parent)
