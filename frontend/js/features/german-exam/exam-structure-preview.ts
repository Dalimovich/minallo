// Exam structure preview (onboarding + Profile) and the small exam-structure stylesheet.
//
// Before a learner has SAVED an exam there is no manifest to fetch (the server resolves the profile from the
// saved selection), so onboarding shows a preview built from the same profile files instead. The data block
// below is GENERATED from the Python profiles/manifest (never hand-edited) and a Python test fails on drift:
//   UPDATE_EXAM_PREVIEW=1 pytest tests/test_german_exam_structure_preview.py
// Nothing here is exam-specific code: the modules, codes, labels and disclaimer all come from the data.

import { resolveGermanExamProfileIdClient } from '../auth/german-profile.js';

export interface ExamStructurePreviewModule {
  id: string;
  code: string | null;
  label: string;
  partCount: number;
}
export interface ExamStructurePreview {
  profileId: string;
  displayName: string;
  family: string;
  levels: string[];
  disclaimer: string | null;
  modules: ExamStructurePreviewModule[];
}

/* GENERATED:BEGIN */
export const EXAM_STRUCTURE_PREVIEW: Record<string, ExamStructurePreview> = {
  "telc_c1_hochschule": {
    "profileId": "telc_c1_hochschule",
    "displayName": "telc Deutsch C1 Hochschule",
    "family": "telc",
    "levels": [
      "C1 Hochschule"
    ],
    "disclaimer": null,
    "modules": [
      {
        "id": "reading",
        "code": null,
        "label": "Lesen",
        "partCount": 3
      },
      {
        "id": "listening",
        "code": null,
        "label": "Hören",
        "partCount": 3
      },
      {
        "id": "language_elements",
        "code": null,
        "label": "Sprachbausteine",
        "partCount": 1
      },
      {
        "id": "writing",
        "code": null,
        "label": "Schreiben",
        "partCount": 1
      },
      {
        "id": "speaking",
        "code": null,
        "label": "Sprechen",
        "partCount": 2
      }
    ]
  },
  "goethe_c1": {
    "profileId": "goethe_c1",
    "displayName": "Goethe-Zertifikat C1",
    "family": "Goethe",
    "levels": [
      "C1"
    ],
    "disclaimer": null,
    "modules": [
      {
        "id": "reading",
        "code": null,
        "label": "Lesen",
        "partCount": 4
      },
      {
        "id": "listening",
        "code": null,
        "label": "Hören",
        "partCount": 4
      },
      {
        "id": "writing",
        "code": null,
        "label": "Schreiben",
        "partCount": 2
      },
      {
        "id": "speaking",
        "code": null,
        "label": "Sprechen",
        "partCount": 2
      }
    ]
  },
  "dsh": {
    "profileId": "dsh",
    "displayName": "DSH",
    "family": "DSH",
    "levels": [
      "DSH-1",
      "DSH-2",
      "DSH-3"
    ],
    "disclaimer": "DSH practice based on the HRK framework; individual universities may have registered local regulations.",
    "modules": [
      {
        "id": "listening",
        "code": "HV",
        "label": "Hörverstehen",
        "partCount": 1
      },
      {
        "id": "reading",
        "code": "LV",
        "label": "Leseverstehen",
        "partCount": 1
      },
      {
        "id": "scientific_structures",
        "code": "WS",
        "label": "Wissenschaftssprachliche Strukturen",
        "partCount": 1
      },
      {
        "id": "writing",
        "code": "TP",
        "label": "Textproduktion",
        "partCount": 1
      },
      {
        "id": "speaking",
        "code": null,
        "label": "Mündliche Prüfung",
        "partCount": 1
      }
    ]
  }
};
/* GENERATED:END */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The preview for a (test family, target level) selection, or null when no exam structure is registered. */
export function previewForSelection(test: string | undefined, level: string | undefined): ExamStructurePreview | null {
  const id = resolveGermanExamProfileIdClient(test, level);
  return (id && EXAM_STRUCTURE_PREVIEW[id]) || null;
}

export function renderExamPreviewHtml(preview: ExamStructurePreview): string {
  const rows = preview.modules
    .map(
      (m) =>
        `<li data-exam-module="${esc(m.id)}"${m.code ? ` data-exam-module-code="${esc(m.code)}"` : ''}>` +
        (m.code ? `<span class="gl-exam-code">${esc(m.code)}</span>` : '') +
        `<span class="gl-exam-preview-name">${esc(m.label)}</span></li>`
    )
    .join('');
  const disclaimer = preview.disclaimer ? `<p class="gl-exam-disclaimer">${esc(preview.disclaimer)}</p>` : '';
  return (
    `<div class="gl-exam-preview" data-exam-preview="${esc(preview.profileId)}">` +
    `<p class="gl-exam-preview-title">${esc(preview.displayName)} — what you will practise</p>` +
    `<ul class="gl-exam-preview-modules">${rows}</ul>${disclaimer}</div>`
  );
}

/** Render (or clear) the preview for the current selection into `host`. Always replaces previous content. */
export function renderExamPreviewInto(host: HTMLElement, test: string | undefined, level: string | undefined): void {
  const preview = previewForSelection(test, level);
  ensureExamStructureStyles();
  host.innerHTML = preview ? renderExamPreviewHtml(preview) : '';
  host.hidden = !preview;
}

const STYLE_ID = 'gl-exam-structure-styles';
const CSS = `
.gl-exam-code{align-self:flex-start;display:inline-block;min-width:2.2em;margin-right:.5em;padding:.05em .45em;border-radius:6px;text-align:center;font-weight:700;font-size:.78em;letter-spacing:.04em;background:var(--gl-exam-code-bg,rgba(99,102,241,.14));color:var(--gl-exam-code-fg,#4f46e5)}
.gl-exam-module-note{display:block;margin-top:.15em;font-size:.82em;opacity:.75}
.gl-exam-modules--manifest{grid-template-columns:repeat(auto-fit,minmax(190px,1fr))}
.gl-exam-modules--manifest .gl-exam-module-name{overflow-wrap:anywhere;hyphens:auto}
.gl-exam-disclaimer{margin:.9em 0 .6em;font-size:.8em;opacity:.7}
#glExamOverview nav h4{margin:1.1em 0 .35em;font-size:.95rem}
#glExamOverview nav button{display:block;width:100%;margin:.2em 0;padding:.5em .8em;border:1px solid rgba(127,127,127,.35);border-radius:9px;background:transparent;color:inherit;font:inherit;font-size:.86rem;text-align:left}
#glExamOverview nav button[data-state="unavailable"]{opacity:.62;cursor:not-allowed}
.gl-exam-preview{margin-top:.9em;padding:.8em 1em;border:1px solid var(--gl-exam-preview-border,rgba(127,127,127,.3));border-radius:12px;text-align:left}
.gl-exam-preview-title{margin:0 0 .5em;font-weight:600;font-size:.92em}
.gl-exam-preview-modules{list-style:none;margin:0;padding:0}
.gl-exam-preview-modules li{padding:.18em 0;font-size:.9em}
`;

export function ensureExamStructureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
