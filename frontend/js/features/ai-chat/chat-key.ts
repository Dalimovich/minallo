// Shared chat-key helper for the AI side panel.
//
// The side panel's chat history must be scoped to the exact
// (course, file) pair that's currently open — never to the course alone,
// and never to a generic/shared key. This is the single place that builds
// that key; every load/save/clear/restore call must go through it so the
// scoping can't drift out of sync between call sites.
export function getAiChatKey(
  courseId?: string | null,
  fileId?: string | null
): string | null {
  if (!courseId || !fileId) return null;
  return `course:${courseId}:file:${fileId}:sidepanel`;
}
