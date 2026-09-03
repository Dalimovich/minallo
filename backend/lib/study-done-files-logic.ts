// Pure decision logic for the /api/study/done-files handler, split out so the
// edge cases (which topics get marked, which get reverted, provenance guards)
// are unit-testable without a database. The handler in
// functions/study-done-files.ts wires these to supaRequest.

// Topic progress states a file-mark may write 'studied' onto. "Marking a file
// done" means "I finished it", so a topic still 'not_started' or 'in_progress'
// (both rank below 'studied') is promoted. A topic already at 'studied' is left
// untouched (re-writing would flatten its last_studied_at / study_sessions),
// 'weak' is kept as a distinct "studied but struggling" signal, and
// practiced/mastered must never be downgraded.
export const MARKABLE_STATES = new Set(['', 'not_started', 'in_progress']);

export interface TopicDocRow {
  id: string;
  source_document_ids: unknown;
}

function docIds(row: TopicDocRow): string[] {
  return Array.isArray(row.source_document_ids)
    ? row.source_document_ids.map((d) => String(d))
    : [];
}

/** Topics covered by at least one of `documentIds`, plus the set of those docs
 *  that actually mapped to a topic (so the caller can report files with none). */
export function topicsForDocuments(
  topics: TopicDocRow[],
  documentIds: string[]
): { topicIds: string[]; docsWithTopics: Set<string> } {
  const wanted = new Set(documentIds);
  const topicIds: string[] = [];
  const docsWithTopics = new Set<string>();
  for (const t of topics) {
    const hit = docIds(t).filter((d) => wanted.has(d));
    if (hit.length) {
      topicIds.push(t.id);
      hit.forEach((d) => docsWithTopics.add(d));
    }
  }
  return { topicIds, docsWithTopics };
}

/** Of `topicIds`, those we may write 'studied' onto given their current state. */
export function selectMarkableTopics(
  topicIds: string[],
  stateByTopic: Map<string, string>
): string[] {
  return topicIds.filter((id) => MARKABLE_STATES.has(stateByTopic.get(id) ?? ''));
}

/** Topics covered by a now-removed (unchecked) file and NOT by any still-done
 *  file — the candidates for reverting to 'not_started'. Returns each
 *  candidate's document list so provenance checks can use file linkage. */
export function candidateRevertTopics(
  topics: TopicDocRow[],
  removed: Set<string>,
  stillDone: Set<string>
): { ids: string[]; docsById: Map<string, string[]> } {
  const ids: string[] = [];
  const docsById = new Map<string, string[]>();
  for (const t of topics) {
    const docs = docIds(t);
    if (!docs.some((d) => removed.has(d))) continue;
    if (docs.some((d) => stillDone.has(d))) continue;
    ids.push(t.id);
    docsById.set(t.id, docs);
  }
  return { ids, docsById };
}

/** From the revert candidates, drop any topic the user actually studied: one
 *  with a task-completion event (by topic_id) or covered by a completed task's
 *  worked file (lecture/source/exercise/solution). */
export function topicsToRevert(
  candidateIds: string[],
  docsById: Map<string, string[]>,
  earnedTopicIds: Set<string>,
  completedFiles: Set<string>
): string[] {
  return candidateIds.filter((id) => {
    if (earnedTopicIds.has(id)) return false;
    const docs = docsById.get(id) ?? [];
    if (docs.some((d) => completedFiles.has(d))) return false;
    return true;
  });
}
