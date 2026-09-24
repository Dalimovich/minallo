/** Module-separated result rendering, shared by every exam profile.
 *
 * Mirrors backend/python-ai/app/services/german_exams/result.py — the same three-way
 * distinction (practice raw correctness / official-style scaled result / formative
 * coverage), and the same refusal to fabricate a TDN classification or a combined
 * exam-wide PASS/FAIL. `renderExamResultSummary` renders one section per module and never
 * merges them into a single verdict.
 */
export interface ModuleManifest { id: string; label: string }
export interface PracticeRawResult { kind: 'practice_raw_result'; correct: number; total: number; percent: number | null }
export interface OfficialScaledResult { kind: 'official_style_scaled_result'; points: number; maxPoints: number; pass?: boolean }
export interface PracticeFormativeResult { kind: 'practice_formative_result'; partsCompleted: number; totalParts: number }
export interface ModuleResult {
  kind: 'module_result'; module: string;
  objective?: PracticeRawResult; official?: OfficialScaledResult; productive?: PracticeFormativeResult;
}

function isFiniteNonNegative(n: unknown): n is number { return typeof n === 'number' && Number.isFinite(n) && n >= 0; }

export function validateModuleResult(result: ModuleResult): void {
  if (result?.kind !== 'module_result' || typeof result.module !== 'string' || !result.module.trim()) throw new Error('Invalid module result');
  if (!result.objective && !result.productive) throw new Error('Module result needs objective and/or productive data');
  if (result.objective) {
    const o = result.objective;
    if (o.kind !== 'practice_raw_result' || !isFiniteNonNegative(o.correct) || !isFiniteNonNegative(o.total) || o.correct > o.total) throw new Error('Invalid objective result');
    if (o.percent !== null && (typeof o.percent !== 'number' || !Number.isFinite(o.percent))) throw new Error('Invalid objective percent');
  }
  if (result.official) {
    const s = result.official;
    if (s.kind !== 'official_style_scaled_result' || !isFiniteNonNegative(s.points) || !isFiniteNonNegative(s.maxPoints) || s.points > s.maxPoints) throw new Error('Invalid official result');
    // These keys must never appear: this contract never fabricates a TDN band or a
    // second, differently-computed score for the same result object.
    if (['tdn', 'scaledScore', 'rawScore'].some(k => k in s)) throw new Error('TDN/scaled score not permitted without a verified conversion');
    if (!result.objective) throw new Error('An official result requires the objective result it was derived from');
  }
  if (result.productive) {
    const p = result.productive;
    if (p.kind !== 'practice_formative_result' || !isFiniteNonNegative(p.partsCompleted) || !isFiniteNonNegative(p.totalParts) || p.partsCompleted > p.totalParts) throw new Error('Invalid productive result');
    if (['score', 'points', 'tdn', 'scaledScore'].some(k => k in p)) throw new Error('Formative coverage must not carry a numeric score');
  }
}

export function renderModuleResult(root: HTMLElement, manifest: ModuleManifest, result: ModuleResult): void {
  validateModuleResult(result);
  root.replaceChildren();
  const heading = document.createElement('h3'); heading.textContent = manifest.label; root.append(heading);
  if (result.objective) {
    const o = result.objective;
    const raw = document.createElement('p');
    raw.textContent = `${o.correct} / ${o.total} correct (practice)` + (o.percent != null ? ` — ${o.percent}%` : '');
    root.append(raw);
  }
  if (result.official) {
    const s = result.official;
    const scaled = document.createElement('p');
    scaled.textContent = `${s.points} / ${s.maxPoints} points`
      + (s.pass !== undefined ? (s.pass ? ' — passing (official-style, practice)' : ' — not yet passing (official-style, practice)') : '');
    root.append(scaled);
  } else if (result.objective) {
    const note = document.createElement('p');
    note.textContent = 'No official scaled score is available for this exam yet.';
    root.append(note);
  }
  if (result.productive) {
    const p = result.productive;
    const note = document.createElement('p');
    note.textContent = `Formative feedback given for ${p.partsCompleted} / ${p.totalParts} tasks`;
    root.append(note);
  }
}

export function renderExamResultSummary(root: HTMLElement, modules: Array<{ manifest: ModuleManifest; result: ModuleResult }>): void {
  root.replaceChildren();
  for (const { manifest, result } of modules) {
    const section = document.createElement('section');
    root.append(section);
    renderModuleResult(section, manifest, result);
  }
}
