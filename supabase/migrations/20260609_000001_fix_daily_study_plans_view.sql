-- Fix daily_study_plans view to properly map field names for frontend
-- Rename task_title→title, task_description→description, add priority_group

drop view if exists public.daily_study_plans cascade;

create view public.daily_study_plans as
select
  wst.id,
  wst.plan_id,
  wst.user_id,
  wst.plan_date,
  wst.day_order,
  wst.course_id,
  wst.subject_name,
  wst.topic_id,
  wst.source_file_id,
  wst.exercise_file_id,
  wst.task_type,
  wst.task_title as title,
  wst.task_description as description,
  wst.estimated_minutes,
  wst.priority_score,
  case
    when wst.priority_score >= 0.8 then 'must_do'
    when wst.priority_score >= 0.5 then 'should_do'
    else 'optional'
  end as priority_group,
  wst.study_state_required,
  wst.exercise_available,
  wst.page_range,
  null::integer as page_start,
  null::integer as page_end,
  null::text as reason,
  null::text as reason_code,
  wst.status,
  wst.status_changed_at,
  wst.source_confidence,
  wst.is_valid,
  wst.invalidation_reason,
  wst.created_at,
  wst.updated_at,
  wsp.plan_scope,
  wsp.week_start_date
from public.weekly_study_tasks wst
join public.weekly_study_plans wsp on wsp.id = wst.plan_id
where wst.status not in ('replaced', 'unavailable')
  and wst.is_valid = true;
