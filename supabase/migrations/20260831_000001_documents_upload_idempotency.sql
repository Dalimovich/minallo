-- Prevents the upload race that created duplicate `documents` rows for the
-- same physical upload (confirmed in production: 9 pairs across multiple
-- courses, all created milliseconds apart — a double-submit/retry hitting
-- documents-upload.ts before the first insert was visible). storage_path is
-- already content-hash-derived (userId/courseId/sha256(bytes).pdf), so this
-- triple is the correct physical-upload identity — NOT file_name, since two
-- different files can legitimately share a name.
--
-- Existing duplicates were audited and merged (references repointed, one
-- row kept) before this migration was written; do not run this against a
-- database that still has (user_id, course_id, storage_path) duplicates —
-- the unique index creation will fail.
alter table public.documents
  add constraint documents_user_course_storage_uniq
  unique (user_id, course_id, storage_path);
