import { writingExamRequest, type WritingGrade } from '../writing-coach/writing-exam.js';
import type { FeedbackItem, FeedbackType } from '../writing-coach/writing-coach-ai.js';
import { wordCount, type Feedback, type ProductiveContent, type ProductiveGrader } from './productive-task.js';

/** Minimal shape this module needs from a TaskEnvelope — kept local (not
 * imported from task-workspace.ts) to avoid a circular import, since
 * task-workspace.ts is what calls createWritingGrader(). */
export interface WritingTaskEnvelope {
  generationId?: string;
  exam: { profileId: string };
  part: { id: string };
}

// Which analyse_writing() feedbackItem types are evidence for which rubric
// dimension name — covers both telc's dimension names (reused generically
// here even though telc never reaches this module) and Goethe/TestDaF's own
// (goethe_c1.py / testdaf_digital.py). A dimension absent here (e.g.
// task_fulfilment, or TestDaF's source_fidelity/linguistic_range/
// comprehensibility, which have no matching Writing Coach axis at all) simply
// gets no item-level evidence — never fabricated.
const DIMENSION_ITEM_TYPES: Record<string, FeedbackType[]> = {
  correctness: ['grammar'], structures: ['grammar'], grammar_accuracy: ['grammar'],
  repertoire: ['vocabulary'], vocabulary: ['vocabulary'], vocabulary_range: ['vocabulary'],
  communicative_design: ['style', 'pattern'], coherence: ['style', 'pattern'],
};

function dimensionScore(grade: WritingGrade, dim: string): number | null {
  const item = grade.examResultItems.find(i => (i as { metadata?: { rubricDimension?: string } }).metadata?.rubricDimension === dim);
  const value = item ? (item as { scoreValue?: unknown }).scoreValue : undefined;
  return typeof value === 'number' ? value : null;
}

/** Only ever returns quotes that are a literal substring of the submitted
 * text (renderFeedback() in productive-task.ts enforces this too) — never
 * invents evidence the learner didn't actually write. */
function evidenceFor(text: string, dim: string, items: FeedbackItem[]): Array<{ quote: string }> {
  const types = DIMENSION_ITEM_TYPES[dim];
  if (!types) return [];
  const evidence: Array<{ quote: string }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!types.includes(item.type) || !item.original || seen.has(item.original) || !text.includes(item.original)) continue;
    seen.add(item.original);
    evidence.push({ quote: item.original });
    if (evidence.length >= 3) break;
  }
  return evidence;
}

/** Maps a backend WritingGrade (the SAME evaluator telc's Writing Coach UI
 * uses, see german_exam_writing_grading.py) onto the generic productive-task
 * Feedback contract (productive-task.ts's renderFeedback) — never reports a
 * tdn/scaledScore/officialScore/rawScore/pass (renderFeedback itself refuses
 * those), and never invents a dimension score or evidence quote the backend
 * didn't actually produce. */
export function mapWritingGradeToFeedback(grade: WritingGrade, gradingDimensions: readonly string[], text: string): Feedback {
  const analysis = grade.analysis as unknown as {
    feedbackItems?: FeedbackItem[];
    scoreExplanation?: string;
    insufficientContext?: { message: string } | null;
  };
  const items = analysis.feedbackItems || [];
  const insufficientMessage = analysis.insufficientContext?.message || null;
  const dimensions = gradingDimensions.map(id => {
    const score = dimensionScore(grade, id);
    const evidence = insufficientMessage ? [] : evidenceFor(text, id, items);
    const feedback = insufficientMessage
      || (score == null ? 'No automatic signal yet for this criterion.' : analysis.scoreExplanation || `Score: ${Math.round(score)}/100`);
    return { id, feedback, evidence };
  });
  return { kind: 'practice_feedback', wordCount: wordCount(text), dimensions };
}

/** Builds the real grader for the generic productive-writing UI (TestDaF's
 * argumentative_essay/text_graph_summary, Goethe's forum_discussion_post/
 * formal_context_message) — replaces mountWriting's default "not connected"
 * stub. Reuses writingExamRequest (the same low-level POST helper telc's
 * Writing Coach exam mode already calls) rather than a second fetch path. */
export function createWritingGrader(
  envelope: WritingTaskEnvelope,
  content: ProductiveContent,
  gradingDimensions: readonly string[],
  request: typeof writingExamRequest = writingExamRequest
): ProductiveGrader {
  return async (submission, signal) => {
    const text = submission.text ?? '';
    const grade = await request<WritingGrade>('grade-writing', {
      profileId: envelope.exam.profileId,
      partId: envelope.part.id,
      topicId: content.id,
      generationId: envelope.generationId ?? null,
      task: content,
      text,
    }, signal);
    return mapWritingGradeToFeedback(grade, gradingDimensions, text);
  };
}
