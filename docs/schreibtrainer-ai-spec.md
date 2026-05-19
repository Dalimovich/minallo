# Deutsch Schreibtrainer — AI logic spec

Saved 2026-05-19 for later implementation. Not yet built.

## Core sentence

The Schreibtrainer must use the German level stored in the user profile as the target level, and the AI must judge corrections, vocabulary upgrades, style feedback, and explanation depth according to that profile level.

## UI changes (writing-coach view)

- Remove the manual level selector (`#wcLevel`) from the Schreibtrainer UI.
- Replace it with a read-only badge: **"Feedback level: {level} · Imported from Profile"**.
- If profile has no German level: show empty state "Please set your German level in your profile first." plus a **Go to Profile** button. Block analysis until level is set.
- Result UI must separate feedback into distinct sections (see below) — do not lump everything into "mistakes".

## Request shape

Send to the analyse endpoint:

```json
{
  "userId": "current-user-id",
  "profileLevel": "C1 Hochschule",
  "taskType": "Stellungnahme",
  "text": "..."
}
```

Do **not** send a `selectedLevel` field. The level is always read from the profile (`window._germanLevel` / Supabase profile row), never from a UI control.

## Response shape

```json
{
  "profileLevel": "C1 Hochschule",
  "estimatedLevel": "B2+/C1-",
  "score": {
    "overall": 74,
    "grammar": 78,
    "vocabulary": 68,
    "structure": 72,
    "style": 70,
    "taskFulfillment": 80
  },
  "correctedText": "...",
  "improvedText": "...",
  "feedbackItems": [
    {
      "type": "grammar | vocabulary | style",
      "label": "Grammar mistake | C1 vocabulary upgrade | Style/register improvement",
      "category": "...",
      "severity": "high | medium | low",
      "original": "...",
      "suggestion": "...",
      "isActualError": true,
      "isLevelUpgrade": false,
      "explanation": "..."
    }
  ],
  "practiceRecommendations": ["..."]
}
```

## AI judgment rules (by profile level)

**A1 / A2** — basic correctness only. Simple explanations. Do not flag simple vocabulary as bad. Focus on word order, articles, verb forms.

**B1** — sentence structure, articles, prepositions, verb conjugation, common vocab. Practical improvements. No academic rewrites.

**B2** — connectors, argument structure, natural wording, precise vocabulary. Realistic style feedback.

**C1 Hochschule** — academic / university German. Mark grammatically-correct-but-too-simple wording as `C1 vocabulary upgrade` or `Style/register improvement`, NOT grammar mistakes. Suggest formal connectors, paragraph structure, nominal style, precise wording.

## Three feedback categories (must be distinguished)

1. **Actual mistake** — e.g. `ich habe gegangen` → `ich bin gegangen`. `type: grammar`, `isActualError: true`, `isLevelUpgrade: false`.
2. **Level-based vocabulary upgrade** — e.g. `gut` → `vorteilhaft`. `type: vocabulary`, `isActualError: false`, `isLevelUpgrade: true`.
3. **Style / register improvement** — e.g. `Ich finde` → `Meiner Ansicht nach`. `type: style`, `isActualError: false`, `isLevelUpgrade: true`.

Do NOT report categories 2 and 3 as mistakes.

## Result UI sections (in this order)

1. **Mistakes Explained** — real grammar/spelling/structure mistakes only.
2. **Vocabulary Improvements** — correct but too simple for profile level.
3. **Style / Register Improvements** — phrases that should sound more formal/academic/natural for profile level.
4. **Improved Version** — full rewritten text adapted to profile level.
5. **Estimated Level** — what level the submitted text currently reads as.
6. **Practice Recommendations** — exercises tied to weak points.

## Colors

- Grammar mistakes: red
- Tense / case / preposition: orange
- Vocabulary upgrades: yellow
- Style / register upgrades: purple/blue
- Corrected suggestion (the "after" form): green

## C1 Hochschule upgrade examples

| Simple | C1 Hochschule alternative |
|---|---|
| gut | vorteilhaft / überzeugend / angemessen |
| schlecht | problematisch / nachteilig / unzureichend |
| machen | durchführen / erstellen / bewirken / verursachen |
| Leute | Personen / Studierende / Betroffene |
| Sache | Aspekt / Faktor / Problemstellung |
| sehr wichtig | von großer Bedeutung / besonders relevant |
| viele Probleme | zahlreiche Herausforderungen |
| bekommen | erhalten / erwerben / erlangen |

## Prompt principle (for the AI)

> "Evaluate the text according to the user's profile level. A phrase can be grammatically correct but still not appropriate for the profile level. Mark such cases as level upgrades, not grammar mistakes."

Tone of feedback also adapts: lower levels → simpler explanations, more examples, less theory. C1 → precise, academic wording, exam-oriented, clear but not overly complicated.

## Acceptance criteria

- [ ] No manual level selector in Schreibtrainer UI.
- [ ] Level is imported from Profile (read-only badge).
- [ ] Empty state when profile has no German level; Go-to-Profile button.
- [ ] AI feedback adapts to the profile level.
- [ ] C1 users get vocabulary / style / register upgrades.
- [ ] Simple-but-correct words are NOT marked as grammar mistakes.
- [ ] Feedback is split into mistakes / vocabulary upgrades / style improvements.
- [ ] Improved version is rewritten according to profile level.
- [ ] AI does not overcorrect lower-level users.

## Touchpoints (where to wire it up)

- UI: `frontend/views/writing-coach/writing-coach.html` (remove `#wcLevel`, add profile badge + empty state).
- Client: `frontend/js/features/writing-coach/writing-coach.ts` (read level from `window._germanLevel`, gate `_analyze` on its presence) and `writing-coach-ai.ts` (replace `selectedLevel` with `profileLevel` in request payload, parse new response shape).
- Backend: the analyse function (Netlify) — accept `profileLevel`, drop `selectedLevel`, update system prompt to encode the rules above, return the new response shape.
- Profile source of truth: `user_profiles` table column for German level (already populated; surfaced as `window._germanLevel`).
- **Profile editability (required, currently broken)**: `frontend/views/profile/profile.html` line 79 has `<input id="profileGermanLevel" … readonly>`. The Schreibtrainer spec depends on the profile being the editable source of truth — students advance over time (A2 → B1 → B2 → C1) and need to update their level. Remove `readonly`, switch to a `<select>` constrained to the allowed levels (A1, A2, B1, B2, C1, C1 Hochschule, C2), persist on save through the same path onboarding uses (`user_profiles.german_level`), and refresh `window._germanLevel` so the Schreibtrainer picks up the change without a reload. Onboarding writes this field at signup (`onboarding.ts:559–581`) but there is no post-signup edit surface today.

---

## Extended evaluation dimensions

Good German writing feedback is not just "wrong → correct". The Schreibtrainer must evaluate ten dimensions and the AI must use judgment across all of them, weighted by profile level + task type.

The ten dimensions:

1. Correctness
2. Level appropriateness
3. Task appropriateness
4. Clarity
5. Structure
6. Vocabulary precision
7. Register / formality
8. Repeated mistakes
9. Improvement over time
10. Exam readiness

**Core rule (extends the headline rule above):** Do not only correct what is wrong. Also explain what is too simple, too informal, repetitive, unclear, or weak for the user's profile level and task type.

### 1. Task type and intention

Before analysing, the AI must know the **task type**. The user picks one from a fixed list (UI control to be added — separate from the profile level, since task type changes per submission):

- `email` — E-Mail
- `stellungnahme` — Stellungnahme
- `argumentation` — Argumentation
- `zusammenfassung` — Zusammenfassung
- `bericht` — Bericht
- `motivationsschreiben` — Motivationsschreiben
- `freier_text` — Freier Text

Judgment is `profileLevel × taskType`. Same sentence can pass in one combination and fail in another — e.g. `Hallo Leute` is fine for a casual message but wrong for a formal email or a C1 Stellungnahme.

Add to request payload: `taskType`. Already shown in the request example above.

### 2. Meaning preservation — two output texts

The AI must NOT rewrite everything beautifully and erase the student's original idea. Produce **two** rewritten texts:

- `correctedText` — close to the student's original, only fixes language errors. Keeps the student's voice and ideas intact.
- `improvedText` — fuller rewrite, more natural and more appropriate for the profile level + task type. This is the "what good looks like" reference.

Both go in the response (the response shape above already names them — keep them strictly distinct, do not let `correctedText` drift into a stylistic rewrite).

### 3. Severity levels on every feedback item

Each `feedbackItem` carries a severity. Four levels:

- `high` — blocks understanding or breaks rules of the language (`ich habe gegangen`).
- `medium` — noticeable issue (case/preposition slip, wrong connector).
- `low` — minor issue (article in a low-stakes spot).
- `optional` — pure improvement, not a mistake (e.g. `Ich denke` → `Meiner Ansicht nach` at C1).

The UI must group / colour by severity so the student is not overwhelmed by a sea of red.

Mapping: vocabulary upgrades default to `medium`; style/register upgrades default to `low` or `optional`; actual grammar errors are `high` or `medium`.

### 4. Repeated mistakes — aggregate, don't enumerate

If the user makes the same kind of mistake N≥3 times, the AI must emit ONE aggregated item instead of N separate corrections:

```json
{
  "type": "pattern",
  "label": "Repeated mistake",
  "category": "Verb position in subordinate clauses",
  "severity": "high",
  "count": 4,
  "examples": ["…dass er kommt gestern", "…weil ich war müde", "…"],
  "explanation": "In Nebensätze the finite verb goes to the end. You did this in 4 places — make this your main practice focus."
}
```

Add `type: pattern` to the feedback union. The UI surfaces these prominently as "main practice focus" items.

### 5. Connectors and flow (B2+)

The AI must check connector quality once the profile level is B2 or above.

Strong / academic connectors to encourage:

`zunächst`, `darüber hinaus`, `außerdem`, `hingegen`, `folglich`, `dennoch`, `aus diesem Grund`, `zusammenfassend lässt sich sagen`

Weak / overused connectors at C1 — flag when overused:

| Weak | C1 upgrade |
|---|---|
| und | sowie / zudem |
| aber | allerdings / jedoch |
| weil | da / zumal |
| dann | anschließend / im Anschluss |
| auch | darüber hinaus / zudem |

Emit these as `type: style`, `category: Connector upgrade`, `severity: optional` (or `low` if very frequent).

### 6. Repetition detection — sentence openings and word reuse

Two checks:

- **Same word repeated** beyond a sensible threshold (e.g. `machen` used 6 times in 300 words).
- **Sentence-opening repetition** (4 sentences in a row starting with `Ich denke / finde / glaube / meine`).

Emit one `type: pattern` item per detected repetition with a `category` of `Sentence-opening variety` or `Word repetition`, plus a list of alternatives (`Meiner Ansicht nach …`, `Ein weiterer wichtiger Aspekt ist …`, `Daraus ergibt sich …`, `Es lässt sich feststellen, dass …`).

### 7. Sentence length and complexity

For A1–B1: encourage clear, simple sentences. Do not push complex structures.

For B2/C1: check **variety** — a mix of short sentences, longer subordinate clauses, relative clauses, connectors, nominal phrases.

**Hard rule:** C1 writing should be precise and structured, NOT unnecessarily complicated. Do not reward Nominalstil for its own sake.

Surface as one aggregated `type: pattern`, `category: Sentence variety` item per submission rather than per sentence.

### 8. Paragraph structure

The AI must judge the macro structure of the text against the task type. Generic template for argumentative tasks (Stellungnahme, Argumentation, C1 Hochschule essays):

- Introduction
- Main argument 1
- Main argument 2
- Counterargument
- Conclusion

Email / Bericht / Zusammenfassung have their own conventions — encode per task type in the prompt.

If structure is weak, emit a top-level `structureFeedback` field:

```json
{
  "structureFeedback": {
    "verdict": "weak | adequate | strong",
    "missing": ["counterargument", "clear conclusion"],
    "note": "Your grammar is mostly okay, but the text needs clearer paragraphs and a stronger conclusion."
  }
}
```

### 9. Register / formality detection

Detect informal phrases when the profile level / task type expects formal writing. Examples to flag at C1 + formal task:

`krass`, `super`, `mega`, `Leute`, `Sachen`, `machen`, `ein bisschen`

Suggest:

`bemerkenswert`, `besonders`, `Personen / Studierende / Betroffene`, `Aspekte / Faktoren`, `durchführen / bewirken / verursachen`, `in gewissem Maße`

Emit as `type: style`, `category: Formal register`.

### 10. "Why this is better" explanations

Every feedback item's `explanation` must answer **why**, not just **what**. Bad:

> Use "vorteilhaft" instead of "gut".

Good:

> "Vorteilhaft" is more precise and formal than "gut", so it fits better in an academic C1 text.

The explanation is what makes the student actually learn — enforce in the prompt that no item ships without one.

### 11. Per-item actions (UI hooks)

Every feedback card in the result UI should expose four actions (logic should be ready even if not all wired in v1):

- **Apply suggestion** — replaces the original snippet in the input box with the suggestion.
- **Ignore** — dismisses the item for this submission.
- **Save as weakness** — pushes the item's `category` into the user's weakness profile (see §14).
- **Practice this** — opens a focused exercise for the `category` (links into the practice page; can be a placeholder route initially).

### 12. Positive feedback / strengths

Response must include a `strengths` array — what the student did well. Example:

```json
{
  "strengths": [
    "Your meaning is clear.",
    "Your argument is understandable.",
    "You used Perfekt correctly in several places.",
    "Your vocabulary is mostly suitable for B2."
  ]
}
```

UI renders this in a dedicated **Strengths** section above mistakes. This is non-optional — the trainer must feel like a teacher, not a red-pen tool.

### 13. Exam readiness (C1 Hochschule)

For C1 Hochschule (and other exam-oriented levels we add later), include a top-level `examReadiness` block:

```json
{
  "examReadiness": {
    "wouldPass": true,
    "verdict": "borderline | likely | unlikely",
    "missing": ["formal connectors", "clearer paragraph structure", "more precise vocabulary"],
    "note": "Your text is understandable, but for C1 Hochschule it needs more formal connectors, clearer paragraph structure, and more precise vocabulary."
  }
}
```

The UI renders this as a dedicated **Exam readiness** card at the end of the result page when `profileLevel === 'C1 Hochschule'`.

### 14. Personal weakness profile (longitudinal)

The trainer must remember the user's recurring weaknesses across submissions. Persist a `user_writing_weaknesses` row per user (Supabase) — keyed by `category`, with `count`, `lastSeenAt`, `improving` (bool computed from frequency trend).

After each analysis, the AI gets the user's current weakness profile in the request and:

- Mentions improvement when a previously-frequent weakness is absent.
- Reinforces the current top weakness in `practiceRecommendations`.

Example response touch:

```json
{
  "longitudinalNote": "You improved your Perfekt mistakes from last week, but word order in subordinate clauses is still your main issue."
}
```

Request payload gains a `weaknessProfile` array (server-side fetched from Supabase — client doesn't have to pass it).

---

## Updated response shape (consolidated)

Top-level fields the response must contain (extends §"Response shape" above):

```json
{
  "profileLevel": "C1 Hochschule",
  "taskType": "Stellungnahme",
  "estimatedLevel": "B2+/C1-",
  "score": { "overall": 74, "grammar": 78, "vocabulary": 68, "structure": 72, "style": 70, "taskFulfillment": 80 },
  "correctedText": "...",
  "improvedText": "...",
  "strengths": ["..."],
  "feedbackItems": [
    { "type": "grammar | vocabulary | style | pattern", "label": "...", "category": "...", "severity": "high | medium | low | optional", "original": "...", "suggestion": "...", "count": 1, "examples": [], "isActualError": true, "isLevelUpgrade": false, "explanation": "..." }
  ],
  "structureFeedback": { "verdict": "weak | adequate | strong", "missing": [], "note": "..." },
  "examReadiness": { "wouldPass": true, "verdict": "borderline | likely | unlikely", "missing": [], "note": "..." },
  "practiceRecommendations": ["..."],
  "longitudinalNote": "..."
}
```

## Profile = editable source of truth

The Schreibtrainer reads the level from the profile; the profile is where it gets changed. There must be exactly one editing surface, and it lives in Profile — not inside the Schreibtrainer, not anywhere else.

Required:

- `#profileGermanLevel` in [profile.html](../frontend/views/profile/profile.html) becomes a `<select>` (allowed values: A1, A2, B1, B2, C1, C1 Hochschule, C2) — the `readonly` attribute goes away.
- Saving the profile persists the new level to `user_profiles.german_level` (same column onboarding uses) and updates `window._germanLevel` so the Schreibtrainer reads the new value immediately, no reload required.
- If the user changes their level mid-session and re-opens the Schreibtrainer, the profile badge updates accordingly.
- The profile is the ONLY place this is editable. Schreibtrainer, settings, and any other surface must read-only-display the value.

## Updated acceptance criteria (additive to the list above)

- [ ] Task type picker in UI; `taskType` sent to backend.
- [ ] AI emits `correctedText` (faithful) and `improvedText` (level-adapted) as two distinct outputs.
- [ ] Every `feedbackItem` has a `severity` field; UI colours/groups by severity.
- [ ] Repeated mistakes (≥3 of the same category) are aggregated into one `type: pattern` item with `count` + `examples`.
- [ ] Weak connectors / sentence-opening repetition / word repetition surface as aggregated pattern items, not per-occurrence.
- [ ] `structureFeedback` is emitted for argumentative task types.
- [ ] `examReadiness` block is emitted when `profileLevel === 'C1 Hochschule'`.
- [ ] Every feedback item has a non-empty `explanation` answering **why**.
- [ ] Result UI shows a **Strengths** section above mistakes.
- [ ] Each feedback card exposes Apply / Ignore / Save as weakness / Practice this actions (UI logic ready, not all wired required for v1).
- [ ] Weakness profile is persisted to Supabase and fed back into the next request; `longitudinalNote` references it when relevant.
- [ ] AI never rewrites the student's idea in `correctedText`; meaning preservation is enforced in the prompt.

---

## Final additions (round 3)

The strongest single rule for the whole trainer:

> It should not only fix German. It should teach the student **why** the correction fits their profile level and task type.

Eight additional requirements layered on top of everything above.

### 15. "AI-written" warning on the improved version

The `improvedText` is a model answer, not something for the student to copy and submit as their own work. Render a persistent warning banner above (or attached to) the **Improved Version** section:

> This improved version is a model answer. Do not copy it blindly. Try to reuse the structure and vocabulary in your own words.

UI: yellow/amber pill above the improved text. The warning is not dismissible (or dismissed only per submission, not persistently).

### 16. Crystal-clear "Corrected" vs "Improved" labels

Both texts already exist in the response. Pin the UI labels so there is no ambiguity:

- **Corrected version** — your text, only fixed. Subtitle in the UI: "Same idea, same voice — language errors removed."
- **Improved version** — stronger version for your profile level. Subtitle: "How a strong {profileLevel} writer might phrase this. Use as inspiration, not a template."

Render side-by-side on wide viewports, stacked on narrow.

### 17. Confidence / uncertainty on every feedback item

German correction is sometimes subjective. The AI must mark uncertain items as `optional` severity AND attach a confidence value, so the UI can soften the tone for low-confidence calls:

```json
{
  "severity": "optional",
  "confidence": "high | medium | low",
  "explanation": "This version sounds more formal, but your original is not wrong."
}
```

Add `confidence` to the `feedbackItem` shape. Medium / low confidence items render in a softer style ("Suggestion" rather than "Fix"). Hard grammar errors should ship with `confidence: high` — if the AI isn't sure, it should not call it a grammar error.

### 18. Missing-context / too-short detection

If the input is too short or too vague to grade fairly, the AI must not pretend. Return a top-level `insufficientContext` block instead of bluffing scores:

```json
{
  "insufficientContext": {
    "reason": "tooShort | tooVague | offTopic",
    "message": "Your text is too short to judge structure and exam readiness reliably. Write at least 120–150 words for full feedback.",
    "minWords": 120
  }
}
```

When this is present, the UI hides the score, structure, and exam-readiness blocks (those values would be guesses), shows the message at the top, and still lets the user see surface-level grammar items if any. Threshold defaults: 60 words for any judgment, 120 for full Stellungnahme/Argumentation grading.

### 19. Rubric explanation under the score

Numbers without context are useless. Each score (overall + per-axis) must carry a short rubric note:

```json
{
  "score": {
    "overall": 74,
    "grammar": 78,
    "vocabulary": 68,
    "structure": 72,
    "style": 70,
    "taskFulfillment": 80
  },
  "scoreExplanation": "Your grammar is mostly understandable, but repeated word-order mistakes and simple vocabulary lower the text from C1 to B2+/C1-."
}
```

UI: scoreboard tile shows the number; a "Why this score?" expander reveals `scoreExplanation`. Always present, never empty.

### 20. Version history (longitudinal submissions)

Persist every submission to Supabase so the user can compare progress over time. Table `user_writing_submissions`:

| column | type | notes |
|---|---|---|
| `id` | uuid | pk |
| `user_id` | uuid | fk → auth.users |
| `submitted_at` | timestamptz | default now() |
| `profile_level` | text | level at the time of submission |
| `task_type` | text | task type at the time of submission |
| `text` | text | original input |
| `estimated_level` | text | AI's verdict (e.g. `B2+/C1-`) |
| `score_overall` | int | for quick listing |
| `analysis` | jsonb | full response shape |

UI surface (deferred but logic ready): a **History** drawer in the Schreibtrainer showing one row per submission with date, task type, estimated level, overall score. Tapping a row replays the saved `analysis` in the result view. Progress strip across the top: `Submission 1: B1+ → Submission 2: B2 → Submission 3: B2+/C1-`.

### 21. "Learn this rule" cards for repeated mistakes

For every `type: pattern` item (the aggregated repeated-mistake items from §4), the AI also emits a `ruleCard`:

```json
{
  "ruleCard": {
    "title": "Verb position in Nebensätze",
    "rule": "In Nebensätze, the conjugated verb goes to the end.",
    "example": "Ich denke, dass es wichtig ist.",
    "miniExerciseHint": "Rewrite 5 sentences moving the finite verb to the end."
  }
}
```

UI: under the pattern item's explanation, a "Learn this rule" expandable card with `rule` + `example` + a **Practice this** button that links to grammar drills filtered by `category`. Connects correction directly to learning.

### 22. Explanation-language option (deferred)

Many learners can't follow grammar explanations *in German* yet, even at B2. Add a per-user setting (Profile → Schreibtrainer preferences) for the language of explanations:

- `Explain in English` (default for A1–B1)
- `Explain in German` (default for B2+)
- `Explain simply` (low-jargon variant, regardless of language)

Implementation: add `explanationLanguage` to the request payload. The AI keeps `original` / `suggestion` text in German always — only `explanation` and `scoreExplanation` swap language. Default is derived from profile level if the user hasn't set a preference.

---

## Inline-highlighting result UI (mandatory rendering pattern)

After analysis, the result view must render an **AI-edited text** area directly below the input textarea. The original text is preserved, with every edit shown inline:

- Grammar mistakes → highlighted **red**.
- Vocabulary upgrades → highlighted **yellow**.
- Style / register upgrades → highlighted **purple/blue**.
- The original phrase appears with a strikethrough.
- The suggested phrase appears next to it in **green**.
- Surrounding sentence context is preserved — do NOT show floating snippets divorced from the sentence they came from.

Layout:

```
┌─ AI-edited text ────────────────────────────────────────────┐
│ Ich ⟨habe gegangen⟩ → ⟨bin gegangen⟩ zur Universität, weil  │
│ ich finde, dass diese Sache ⟨gut⟩ → ⟨vorteilhaft⟩ war.      │
└──────────────────────────────────────────────────────────────┘

┌─ Explanation cards ─────────────────────────────────────────┐
│ [Grammar mistake · Perfekt auxiliary]                       │
│ Original: habe gegangen     Suggested: bin gegangen         │
│ The verb 'gehen' takes 'sein' in the Perfekt tense.         │
│ [Apply suggestion] [Ignore] [Save as weakness] [Practice]   │
├─────────────────────────────────────────────────────────────┤
│ [C1 vocabulary upgrade · Academic vocabulary]               │
│ Original: gut               Suggested: vorteilhaft          │
│ 'Gut' is understandable, but for C1 Hochschule …            │
│ [Apply suggestion] [Ignore] [Save as weakness] [Practice]   │
└─────────────────────────────────────────────────────────────┘
```

The user sees the correction inside their own text first (in context), then reads the explanation below — not the other way around. Each card in the explanation list corresponds to one highlighted span, and the two are visually linked (hovering the card glows the matching highlight; clicking either scrolls the other into view).

Each explanation card must include:

- `type` / `category` label (color-coded to match the inline highlight).
- `original` phrase.
- `suggestion` phrase.
- `explanation` (the "why" — non-empty per §10).
- **Apply suggestion** action (replaces the original phrase in the textarea above with the suggestion).

This rendering pattern depends on the response carrying `original` and `suggestion` *with character offsets* into the original text, so the frontend can splice highlights in without ambiguity. Add to each `feedbackItem`:

```json
{
  "spanStart": 12,
  "spanEnd": 26
}
```

(0-indexed UTF-16 offsets into the submitted `text`.) Aggregated pattern items can carry an `examples[].spanStart/spanEnd` array since they target multiple spans at once.

---

## Acceptance criteria (round 3 additions)

- [ ] **AI-written warning** persistently rendered on the Improved Version block.
- [ ] **Corrected vs Improved** clearly labelled with their subtitle strings.
- [ ] Every `feedbackItem` includes a `confidence` value; low-confidence items render in a softer "Suggestion" style.
- [ ] `insufficientContext` block honored: score / structure / exam-readiness hidden when present; message shown; min-word thresholds enforced.
- [ ] `scoreExplanation` is non-empty and shown via a "Why this score?" expander.
- [ ] Every submission persisted to `user_writing_submissions`; History drawer reads from it.
- [ ] `ruleCard` emitted for every `type: pattern` item; rendered as a "Learn this rule" expandable under the item.
- [ ] `explanationLanguage` preference plumbed through the request; AI swaps explanation language only (German content stays German).
- [ ] **Inline highlights**: red / yellow / purple-blue / green-strikethrough spans rendered in the original text with sentence context preserved.
- [ ] Explanation cards rendered under the inline text; each card visually linked to its highlight (hover-to-glow, click-to-scroll).
- [ ] Each `feedbackItem` carries `spanStart` / `spanEnd` offsets so the frontend can splice highlights without guessing.
