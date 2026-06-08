// Types for the multi-subject weekly study planner.

export type TaskStatus = 'todo' | 'in_progress' | 'completed' | 'skipped' | 'moved' | 'unavailable' | 'replaced';
export type PlanScope = 'global_week' | 'course_week';
export type ProgressState = 'not_started' | 'in_progress' | 'studied' | 'practiced' | 'weak' | 'mastered';
export type SourceConfidence = 'high' | 'confirmed' | 'low' | 'unverified';

// ── Database row shapes ──────────────────────────────────────────────────────

export interface TaskCandidate {
  id: string;
  user_id: string;
  course_id: string;
  subject_name: string | null;
  topic_id: string | null;
  source_file_id: string | null;
  exercise_file_id: string | null;
  task_type: string;
  task_title: string;
  task_description: string | null;
  estimated_minutes: number;
  difficulty: string;
  study_state_required: string;
  exercise_available: boolean;
  page_range: string | null;
  priority_score: number;
  is_valid: boolean;
  source_confidence: SourceConfidence;
  candidate_reason: string | null;
  // joined
  course_topics?: { name?: string; importance?: string } | null;
  documents?: { file_name?: string; processing_status?: string; source_type?: string } | null;
}

export interface SubjectState {
  id: string;
  user_id: string;
  course_id: string;
  subject_name: string | null;
  exam_date: string | null;         // ISO date
  deadline: string | null;          // ISO date
  priority: number;
  user_excluded: boolean;
  user_priority_override: number | null;
  total_topics: number;
  studied_topics: number;
  practiced_topics: number;
  weak_topics: number;
  last_studied_at: string | null;   // ISO timestamp
}

export interface TopicState {
  id: string;
  user_id: string;
  course_id: string;
  topic_id: string;
  progress_state: ProgressState;
  last_studied_at: string | null;
  last_practiced_at: string | null;
  weak_since: string | null;
  study_sessions: number;
  practice_sessions: number;
}

export interface StudyPreferences {
  user_id: string;
  default_plan_scope: PlanScope;
  daily_study_minutes: number;       // default 120
  preferred_subjects: string[];
  excluded_subjects: string[];
  study_days: number[];              // 0=Sun … 6=Sat, default [1,2,3,4,5]
}

// ── Planner-internal shapes ──────────────────────────────────────────────────

export interface ScoredSubject {
  courseId: string;
  subjectName: string;
  score: number;
  state: SubjectState | null;
  candidates: TaskCandidate[];
  topicStates: Map<string, TopicState>;
}

export interface DayAllocation {
  date: string;                      // YYYY-MM-DD
  allocations: Array<{
    courseId: string;
    subjectName: string;
    minutesAllocated: number;
    candidates: TaskCandidate[];
    topicStates: Map<string, TopicState>;
  }>;
}

export interface SequencedTask {
  candidate: TaskCandidate;
  estimatedMinutes: number;
  dayOrder: number;
  priorityScore: number;
}

export interface WeeklyStudyTask {
  id: string;
  plan_id: string;
  user_id: string;
  plan_date: string;
  day_order: number;
  course_id: string;
  subject_name: string | null;
  topic_id: string | null;
  source_file_id: string | null;
  exercise_file_id: string | null;
  task_type: string;
  task_title: string;
  task_description: string | null;
  estimated_minutes: number;
  priority_score: number;
  study_state_required: string;
  exercise_available: boolean;
  page_range: string | null;
  status: TaskStatus;
  status_changed_at: string | null;
  source_confidence: string;
  is_valid: boolean;
  invalidation_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface WeeklyStudyPlan {
  id: string;
  user_id: string;
  week_start_date: string;
  plan_scope: PlanScope;
  course_id: string | null;
  status: string;
  generated_at: string;
  regenerated_at: string | null;
  generation_params: Record<string, unknown>;
  created_at: string;
}
