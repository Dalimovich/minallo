/** Generic full-exam simulation session state, shared by every exam profile.
 *
 * Nothing here is exam-specific: navigation locking, module timers, autosave/recovery and
 * the final summary are all driven by `manifest.deliveryPolicy` (fixedTaskOrder,
 * backNavigationAllowed, additionalUnscoredTrialTasks — see
 * backend/python-ai/app/services/german_exams/shared.py::DeliveryPolicy, set per profile in
 * that profile's own file, e.g. testdaf_digital.py's DELIVERY_METADATA). A profile with no
 * delivery policy (the default before this session type is wired to a given exam family)
 * behaves as free navigation with no module timer — unchanged from today.
 *
 * This class never fabricates content: it does not invent additional trial tasks. It only
 * ever simulates the scored-core structure the manifest describes, and `finalSummary()`
 * says so explicitly so the UI can label the policy rather than imply a task count match
 * with the real exam.
 */

export interface DeliveryPolicy {
  fixedTaskOrder: boolean;
  backNavigationAllowed: boolean;
  additionalUnscoredTrialTasks: boolean;
}
export interface SessionManifestPart { id: string; taskType: string; implemented: boolean }
export interface SessionManifestModule { id: string; label: string; durationSeconds: number | null; parts: SessionManifestPart[] }
export interface SessionManifest {
  profileId: string; profileVersion: number;
  deliveryPolicy?: DeliveryPolicy | null;
  modules: SessionManifestModule[];
}

export type PartSubmissionState = 'not_started' | 'in_progress' | 'submitted' | 'expired';
export interface PartProgress { submissionState: PartSubmissionState; answer?: unknown }

export interface ExamSessionSnapshot {
  profileId: string; profileVersion: number;
  moduleIndex: number; partIndex: number;
  progress: Record<string, PartProgress>;
  moduleDeadlines: Record<string, number | null>;
  completedModules: string[];
  startedAt: number;
  finished: boolean;
}

function partKey(moduleId: string, partId: string): string { return `${moduleId}:${partId}`; }

export class ExamSession {
  readonly manifest: SessionManifest;
  private snap: ExamSessionSnapshot;
  private readonly now: () => number;
  private readonly storage: Storage | undefined;
  private readonly storageKey: string;

  constructor(manifest: SessionManifest, opts: { now?: () => number; storage?: Storage } = {}) {
    if (!manifest.modules.length || manifest.modules.some((m) => !m.parts.length)) throw new Error('Exam manifest has no navigable parts');
    this.manifest = manifest;
    this.now = opts.now || Date.now;
    this.storage = opts.storage;
    this.storageKey = `german-exam-session:${manifest.profileId}:${manifest.profileVersion}`;
    this.snap = this.loadOrCreate();
  }

  private loadOrCreate(): ExamSessionSnapshot {
    if (this.storage) {
      try {
        const raw = this.storage.getItem(this.storageKey);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<ExamSessionSnapshot>;
          if (parsed && parsed.profileId === this.manifest.profileId && parsed.profileVersion === this.manifest.profileVersion
            && typeof parsed.moduleIndex === 'number' && typeof parsed.partIndex === 'number') {
            return {
              profileId: this.manifest.profileId, profileVersion: this.manifest.profileVersion,
              moduleIndex: parsed.moduleIndex, partIndex: parsed.partIndex,
              progress: parsed.progress || {}, moduleDeadlines: parsed.moduleDeadlines || {},
              completedModules: parsed.completedModules || [], startedAt: parsed.startedAt ?? this.now(),
              finished: !!parsed.finished,
            };
          }
        }
      } catch { /* a corrupted recovery snapshot must never crash the session; start fresh */ }
    }
    return {
      profileId: this.manifest.profileId, profileVersion: this.manifest.profileVersion,
      moduleIndex: 0, partIndex: 0, progress: {}, moduleDeadlines: {}, completedModules: [],
      startedAt: this.now(), finished: false,
    };
  }

  private save(): void {
    if (!this.storage) return;
    try { this.storage.setItem(this.storageKey, JSON.stringify(this.snap)); } catch { /* best-effort autosave only */ }
  }

  get policy(): DeliveryPolicy {
    return this.manifest.deliveryPolicy || { fixedTaskOrder: false, backNavigationAllowed: true, additionalUnscoredTrialTasks: false };
  }

  get finished(): boolean { return this.snap.finished; }
  get currentModule(): SessionManifestModule | null { return this.manifest.modules[this.snap.moduleIndex] || null; }
  get currentPart(): SessionManifestPart | null { return this.currentModule ? this.currentModule.parts[this.snap.partIndex] || null : null; }

  progressFor(moduleId: string, partId: string): PartProgress {
    return this.snap.progress[partKey(moduleId, partId)] || { submissionState: 'not_started' };
  }

  /** Ensures the current module's countdown has a deadline the first time it is entered
   * (never resets an already-running or already-expired module's clock). */
  private ensureModuleDeadline(): void {
    const m = this.currentModule;
    if (!m || this.snap.moduleDeadlines[m.id] !== undefined) return;
    this.snap.moduleDeadlines[m.id] = m.durationSeconds != null ? this.now() + m.durationSeconds * 1000 : null;
    this.save();
  }

  remainingModuleSeconds(): number | null {
    this.ensureModuleDeadline();
    const m = this.currentModule;
    if (!m) return null;
    const deadline = this.snap.moduleDeadlines[m.id];
    if (deadline == null) return null;
    return Math.max(0, Math.ceil((deadline - this.now()) / 1000));
  }

  /** True when navigating to (moduleIndex, partIndex) is allowed right now, given
   * fixedTaskOrder/backNavigationAllowed and how far the session has already progressed.
   * Never allows moving to a module before the current one — a completed module is closed. */
  canNavigateTo(moduleIndex: number, partIndex: number): boolean {
    if (moduleIndex < 0 || moduleIndex >= this.manifest.modules.length) return false;
    if (moduleIndex < this.snap.moduleIndex) return false;
    const targetModule = this.manifest.modules[moduleIndex];
    if (!targetModule || partIndex < 0 || partIndex >= targetModule.parts.length) return false;
    if (moduleIndex > this.snap.moduleIndex) return partIndex === 0; // entering a later module always starts at its first part
    if (partIndex < this.snap.partIndex) return this.policy.backNavigationAllowed;
    if (partIndex === this.snap.partIndex) return true;
    if (this.policy.fixedTaskOrder) {
      const m = this.currentModule!, p = this.currentPart!;
      const submitted = this.progressFor(m.id, p.id).submissionState === 'submitted';
      return partIndex === this.snap.partIndex + 1 && submitted;
    }
    return true;
  }

  goToPart(moduleIndex: number, partIndex: number): void {
    if (this.snap.finished) throw new Error('Exam session is already finished');
    if (!this.canNavigateTo(moduleIndex, partIndex)) throw new Error('Navigation not allowed by the current delivery policy');
    this.snap.moduleIndex = moduleIndex;
    this.snap.partIndex = partIndex;
    this.save();
  }

  recordAnswer(answer: unknown): void {
    const m = this.currentModule, p = this.currentPart;
    if (!m || !p || this.snap.finished) throw new Error('No active part to record an answer for');
    this.snap.progress[partKey(m.id, p.id)] = { submissionState: 'in_progress', answer };
    this.save();
  }

  submitCurrentPart(answer?: unknown): void {
    const m = this.currentModule, p = this.currentPart;
    if (!m || !p || this.snap.finished) throw new Error('No active part to submit');
    const existing = this.progressFor(m.id, p.id);
    this.snap.progress[partKey(m.id, p.id)] = { submissionState: 'submitted', answer: answer !== undefined ? answer : existing.answer };
    this.save();
  }

  /** Advances to the next part (or module); auto-locks and skips a module whose timer has
   * expired. Returns false once the whole exam is finished. */
  advance(): boolean {
    if (this.snap.finished) return false;
    if (this.moduleJustExpired()) { this.lockCurrentModule(); }
    const m = this.currentModule!;
    if (this.snap.partIndex + 1 < m.parts.length) {
      if (this.canNavigateTo(this.snap.moduleIndex, this.snap.partIndex + 1)) {
        this.snap.partIndex += 1; this.save(); return true;
      }
      return false; // fixed order and current part not yet submitted — caller must submit first
    }
    return this.completeCurrentModuleAndAdvance();
  }

  private moduleJustExpired(): boolean {
    const remaining = this.remainingModuleSeconds();
    const m = this.currentModule;
    return remaining !== null && remaining <= 0 && !!m && !this.snap.completedModules.includes(m.id);
  }

  /** Marks every not-yet-submitted part of the current module as expired and closes it —
   * called automatically by `tick()`/`advance()` once the module deadline passes. */
  private lockCurrentModule(): void {
    const m = this.currentModule;
    if (!m) return;
    for (const p of m.parts) {
      const k = partKey(m.id, p.id);
      if ((this.snap.progress[k]?.submissionState || 'not_started') !== 'submitted') {
        this.snap.progress[k] = { ...this.snap.progress[k], submissionState: 'expired' };
      }
    }
    if (!this.snap.completedModules.includes(m.id)) this.snap.completedModules.push(m.id);
    this.save();
  }

  private completeCurrentModuleAndAdvance(): boolean {
    const m = this.currentModule!;
    if (!this.snap.completedModules.includes(m.id)) this.snap.completedModules.push(m.id);
    if (this.snap.moduleIndex + 1 < this.manifest.modules.length) {
      this.snap.moduleIndex += 1; this.snap.partIndex = 0; this.save(); return true;
    }
    this.snap.finished = true; this.save(); return false;
  }

  /** Call periodically (e.g. every second, driven by the caller's own timer — this class
   * never owns a timer/interval itself, keeping it trivially testable with a fake `now`). */
  tick(): void {
    if (this.snap.finished) return;
    if (this.moduleJustExpired()) {
      this.lockCurrentModule();
      this.completeCurrentModuleAndAdvance();
    }
  }

  /** True while there is submitted-but-unsynced or in-progress work a page refresh/close
   * would lose beyond what autosave already recovers (e.g. an active recording). Callers
   * wire this to `beforeunload` to warn the learner before navigating away mid-task. */
  hasUnsavedRisk(): boolean {
    const m = this.currentModule, p = this.currentPart;
    if (!m || !p) return false;
    return this.progressFor(m.id, p.id).submissionState === 'in_progress';
  }

  /** The scored-core-only practice summary. Never invents additional trial tasks: it only
   * reports on the parts the manifest actually contains, and labels the policy explicitly
   * so the UI never implies this simulation matches the real exam's total task count. */
  finalSummary(): {
    finished: boolean; modulesCompleted: string[]; totalModules: number;
    trialTasksPolicy: { simulatesScoredCoreOnly: true; additionalUnscoredTrialTasksInOfficialExam: boolean };
  } {
    return {
      finished: this.snap.finished,
      modulesCompleted: [...this.snap.completedModules],
      totalModules: this.manifest.modules.length,
      trialTasksPolicy: {
        simulatesScoredCoreOnly: true,
        additionalUnscoredTrialTasksInOfficialExam: this.policy.additionalUnscoredTrialTasks,
      },
    };
  }
}
