-- Security-advisor remediation: SECURITY DEFINER view + RPC authorization gaps.
--
-- Found during the 2026-10-14 release-readiness audit's targeted follow-up on
-- get_advisors(security) findings. Everything below is READ evidence from the
-- live project (pg_policies, information_schema.routine_privileges,
-- pg_get_functiondef, pg_get_viewdef) -- NOT applied. Two independent classes
-- of confirmed gap, both fixed the same way other functions in this same
-- schema already demonstrate is the correct pattern here.
--
-- ============================================================================
-- 1) public.daily_study_plans -- CONFIRMED cross-user data leak (ERROR-level
--    lint, independently verified, highest severity in this batch)
-- ============================================================================
--
-- The view has no WHERE user_id = auth.uid() clause at all, is SECURITY
-- DEFINER, and both anon + authenticated hold SELECT on it directly. Its two
-- base tables (weekly_study_tasks, weekly_study_plans) DO have correct RLS
-- (weekly_study_tasks_owner / weekly_study_plans_owner, both
-- "auth.uid() = user_id", roles {public}) -- confirmed via pg_policies. A
-- SECURITY DEFINER view evaluates RLS as its OWNER, not the querying session,
-- so those correct policies are silently bypassed for every reader of this
-- view. Preconditions to exploit: none beyond holding the anon API key (no
-- login required) -- SELECT * FROM daily_study_plans (or
-- GET /rest/v1/daily_study_plans) returns every user's task titles,
-- descriptions, course/subject names, linked file ids and page ranges.
--
-- Fix: switch the view to SECURITY INVOKER (Postgres 15+, this project runs
-- 17.6) so it evaluates RLS as the querying session again, using the
-- already-correct base-table policies. No application-facing column change.

alter view public.daily_study_plans set (security_invoker = true);

-- ============================================================================
-- 2) Six SECURITY DEFINER RPCs that trust a caller-supplied p_user_id with NO
--    auth.uid() check, all confirmed EXECUTE-granted to anon + authenticated
--    (information_schema.routine_privileges) -- unlike their properly-guarded
--    siblings in this same file set (bind_scoped_job_to_tutor_turn,
--    create_ai_tutor_turn, user_can_access_room all already check identity).
-- ============================================================================
--
-- Each one lets any signed-in user -- match_course_visuals needs no sign-in
-- at all -- act on or read ANOTHER user's row by passing their user_id as a
-- plain argument:
--   - match_course_visuals: returns another user's course visual captions,
--     OCR text and thumbnail paths for any (user_id, course_id) supplied --
--     a direct cross-user READ, zero auth required. Most severe of the six.
--   - activate_document_index_revision / rollback_document_index_revision:
--     can flip or roll back which index revision is "active" for another
--     user's document, given their user_id + document_id (+ a matching
--     revision for activate).
--   - claim_ai_tutor_generation / save_ai_tutor_state: can corrupt another
--     user's AI-tutor generation/state tracking for a known conversation_id.
--   - claim_pdf_region_ocr: can claim/poison another user's PDF-region-OCR
--     job row.
--
-- Fix: add the exact guard bind_scoped_job_to_tutor_turn / create_ai_tutor_turn
-- already use in this schema, so the fix is idiomatically consistent with
-- surrounding code rather than a new pattern.

create or replace function public.activate_document_index_revision(
  p_document_id uuid, p_user_id uuid, p_revision text,
  p_expected_pages integer, p_expected_chunks integer
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  actual_pages integer;
  actual_chunks integer;
  manifest_pages integer;
  manifest_distinct_pages integer;
  manifest_failures integer;
begin
  if auth.role() <> 'service_role' and auth.uid() is distinct from p_user_id then
    raise exception 'not_authorized';
  end if;

  select count(*) into actual_pages
  from public.document_pages
  where document_id = p_document_id and index_revision = p_revision;

  select count(*) into actual_chunks
  from public.document_chunks
  where document_id = p_document_id and index_revision = p_revision;

  select count(*), count(distinct page_number),
         count(*) filter (where status = 'failed')
    into manifest_pages, manifest_distinct_pages, manifest_failures
  from public.document_page_manifests
  where document_id = p_document_id and index_revision = p_revision;

  if actual_pages <> p_expected_pages
     or actual_chunks <> p_expected_chunks
     or manifest_pages <> p_expected_pages
     or manifest_distinct_pages <> p_expected_pages
     or manifest_failures <> 0
     or actual_pages < 1
     or actual_chunks < 1 then
    return false;
  end if;

  update public.documents
  set previous_index_revision = nullif(active_index_revision, ''),
      active_index_revision = p_revision,
      index_revision_status = 'ready',
      updated_at = now()
  where id = p_document_id and user_id = p_user_id;
  return found;
end;
$$;

create or replace function public.rollback_document_index_revision(p_document_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  old_active text;
  rollback_revision text;
begin
  if auth.role() <> 'service_role' and auth.uid() is distinct from p_user_id then
    raise exception 'not_authorized';
  end if;

  select active_index_revision, previous_index_revision
    into old_active, rollback_revision
  from public.documents
  where id = p_document_id and user_id = p_user_id
  for update;
  if rollback_revision is null or rollback_revision = '' then
    return false;
  end if;
  update public.documents
  set active_index_revision = rollback_revision,
      previous_index_revision = nullif(old_active, ''),
      index_revision_status = 'ready',
      updated_at = now()
  where id = p_document_id and user_id = p_user_id;
  return found;
end;
$$;

create or replace function public.claim_ai_tutor_generation(
  p_user_id uuid, p_conversation_id text, p_course_id text, p_generation bigint
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  accepted boolean;
begin
  if auth.role() <> 'service_role' and auth.uid() is distinct from p_user_id then
    raise exception 'not_authorized';
  end if;

  insert into public.ai_tutor_states (
    user_id, conversation_id, course_id, generation
  ) values (
    p_user_id, p_conversation_id, p_course_id, p_generation
  )
  on conflict (user_id, conversation_id) do update
    set generation = greatest(ai_tutor_states.generation, excluded.generation),
        course_id = excluded.course_id,
        updated_at = now();

  select generation = p_generation into accepted
  from public.ai_tutor_states
  where user_id = p_user_id and conversation_id = p_conversation_id;
  return coalesce(accepted, false);
end;
$$;

create or replace function public.save_ai_tutor_state(
  p_user_id uuid, p_conversation_id text, p_course_id text, p_generation bigint, p_state jsonb
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.role() <> 'service_role' and auth.uid() is distinct from p_user_id then
    raise exception 'not_authorized';
  end if;

  update public.ai_tutor_states
  set course_id = p_course_id,
      state = p_state,
      updated_at = now()
  where user_id = p_user_id
    and conversation_id = p_conversation_id
    and generation = p_generation;
  return found;
end;
$$;

create or replace function public.claim_pdf_region_ocr(
  p_user_id uuid, p_course_id text, p_document_id uuid, p_document_revision text,
  p_index_revision text, p_page_number integer, p_region_key text, p_crop_sha256 text,
  p_render_dpi integer, p_model text
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  current_status text;
begin
  if auth.role() <> 'service_role' and auth.uid() is distinct from p_user_id then
    raise exception 'not_authorized';
  end if;

  insert into public.pdf_region_ocr_results (
    user_id, course_id, document_id, document_revision, index_revision,
    page_number, region_key, crop_sha256, render_dpi, model, status
  ) values (
    p_user_id, p_course_id, p_document_id, p_document_revision,
    coalesce(p_index_revision, ''), p_page_number, p_region_key,
    p_crop_sha256, p_render_dpi, p_model, 'processing'
  )
  on conflict do nothing;

  if found then
    return 'claimed';
  end if;

  update public.pdf_region_ocr_results
  set status = 'processing',
      crop_sha256 = p_crop_sha256,
      claimed_at = now(),
      completed_at = null,
      error_code = null,
      updated_at = now()
  where user_id = p_user_id
    and document_id = p_document_id
    and document_revision = p_document_revision
    and index_revision = coalesce(p_index_revision, '')
    and page_number = p_page_number
    and region_key = p_region_key
    and render_dpi = p_render_dpi
    and model = p_model
    and (
      status = 'failed'
      or (status = 'processing' and claimed_at < now() - interval '5 minutes')
    );

  if found then
    return 'claimed';
  end if;

  select status into current_status
  from public.pdf_region_ocr_results
  where user_id = p_user_id
    and document_id = p_document_id
    and document_revision = p_document_revision
    and index_revision = coalesce(p_index_revision, '')
    and page_number = p_page_number
    and region_key = p_region_key
    and render_dpi = p_render_dpi
    and model = p_model;

  return coalesce(current_status, 'failed');
end;
$$;

create or replace function public.match_course_visuals(
  p_user_id uuid, p_course_id text, p_document_revision text,
  p_query_embedding vector, p_limit integer default 12
)
returns table(
  id uuid, document_id uuid, document_revision text, page_number integer,
  visual_type text, bounding_box jsonb, caption text, nearby_text text,
  section_title text, detected_labels jsonb, detected_topics jsonb, ocr_text text,
  visual_description text, quality_score double precision, thumbnail_path text,
  perceptual_hash text, similarity double precision
)
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $$
begin
  if auth.role() <> 'service_role' and auth.uid() is distinct from p_user_id then
    raise exception 'not_authorized';
  end if;

  return query
  select cv.id, cv.document_id, cv.document_revision, cv.page_number,
    cv.visual_type, cv.bounding_box, cv.caption, cv.nearby_text,
    cv.section_title, cv.detected_labels, cv.detected_topics, cv.ocr_text,
    cv.visual_description, cv.quality_score, cv.thumbnail_path,
    cv.perceptual_hash,
    1 - (cv.relevance_embedding operator(extensions.<=>) p_query_embedding) as similarity
  from public.course_visuals cv
  join public.documents d on d.id = cv.document_id
  where cv.user_id = p_user_id and cv.course_id = p_course_id
    and cv.document_revision = d.document_hash
    and (p_document_revision = '' or cv.document_revision = p_document_revision)
  order by cv.relevance_embedding operator(extensions.<=>) p_query_embedding
  limit greatest(1, least(coalesce(p_limit, 12), 30));
end;
$$;

-- ============================================================================
-- 3) claim_next_scoped_job -- internal worker-queue primitive, no user_id
--    concept at all, currently EXECUTE-granted to anon + authenticated. This
--    is a WORKER-ONLY function (dequeues and leases ANY pending document-
--    processing job, returning the full row including request_payload) --
--    unlike the six above, adding a p_user_id check doesn't fit its design;
--    it was never meant to be called by an end-user client at all. The
--    correct fix is to stop exposing it to PostgREST entirely.
--
-- Preconditions to exploit: none -- anon key only, no login. Impact: any
-- unauthenticated caller can claim/lease arbitrary queued or recovering
-- document-processing jobs system-wide, starving the real worker fleet and
-- reading other users' request_payload contents.
-- ============================================================================

revoke execute on function public.claim_next_scoped_job(text, integer) from anon, authenticated;

-- NOT applied yet -- proposed fix pending owner approval. Logic-level review
-- only: I verified each guard against this project's own existing
-- bind_scoped_job_to_tutor_turn / create_ai_tutor_turn / user_can_access_room
-- functions (same auth.role() <> 'service_role' and auth.uid() is distinct
-- from p_user_id pattern, already proven correct and in production use for
-- those three), and against pg_policies / information_schema.routine_privileges
-- / pg_get_viewdef output read directly from the live project. No isolated
-- Postgres instance was available to execute this migration end-to-end
-- (Supabase branch-create was declined twice; no local Docker/Postgres in
-- this environment) -- that is a genuine, separate gate before this can be
-- applied, same caveat as 20261014_000001_profiles_lock_user_type.sql.
