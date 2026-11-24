-- ============================================================
-- MIGRATION V15 — ESCALATION OF URGENT FINDINGS + AUDIT HARDENING
-- Run after v14 in the Supabase SQL editor. Safe to re-run.
--
-- 1. escalation_events: every escalation step for an urgent finding that
--    no doctor has reviewed yet (IMPROVEMENT_PLAN §3.4). Urgent means the
--    patient's latest assessment is Critical (which includes the engine's
--    SEVERE_RECENT_BP flag) or their latest ECG is a validated recording
--    classified as possible MI.
--      level 0  immediately   "Urgent" notification to every doctor with access
--      level 1  after 4 h     "Overdue urgent review", pinned on the Overview
--      level 2  after 24 h    level-2 notification; the banner stays
--    Each step writes an escalation_events row and an audit_logs row, and
--    escalation stops as soon as a finding_reviews row exists. Doctor-only:
--    there is no patient policy. Escalation stays within the care team; MEDIS
--    has no on-call or hospital-admin role (team question Q7).
-- 2. Hourly pg_cron job medis_escalate_urgent; new urgent findings escalate
--    at once through insert triggers.
-- 3. Step 10: "Clinical Insights viewed" is recordable through
--    log_patient_access() and listed in the patient's access history.
-- ============================================================
begin;

-- Escalation steps are written by the database itself, so they have no actor.
alter table public.audit_logs alter column user_id drop not null;

-- ---------- 1. Time limits (tune here) ----------
create or replace function public.medis_escalation_after(p_level integer)
returns interval
language sql
immutable
as $$
  select case p_level when 0 then interval '0' when 1 then interval '4 hours' when 2 then interval '24 hours' end;
$$;

-- Older findings are not escalated, so applying this migration does not
-- alert on every historical Critical check.
create or replace function public.medis_escalation_lookback()
returns interval
language sql
immutable
as $$ select interval '7 days' $$;

-- ---------- 2. Escalation events ----------
create table if not exists public.escalation_events (
  id               uuid primary key default gen_random_uuid(),
  patient_id       uuid not null references public.profiles(id) on delete cascade,
  assessment_id    uuid references public.cad_assessments(id) on delete cascade,
  ecg_analysis_id  uuid references public.ecg_analyses(id) on delete cascade,
  level            smallint not null check (level between 0 and 2),
  reason           text not null check (reason in ('critical_priority', 'ecg_possible_mi')),
  finding_at       timestamptz not null,
  doctors_notified integer not null default 0,
  created_at       timestamptz not null default now(),
  constraint escalation_events_one_target check (num_nonnulls(assessment_id, ecg_analysis_id) = 1),
  constraint escalation_events_assessment_level unique (assessment_id, level),
  constraint escalation_events_ecg_level unique (ecg_analysis_id, level)
);

create index if not exists escalation_events_patient_idx
  on public.escalation_events (patient_id, created_at desc);

alter table public.escalation_events enable row level security;

drop policy if exists "escalation_events: doctor with access reads" on public.escalation_events;
create policy "escalation_events: doctor with access reads"
  on public.escalation_events for select
  using (exists (select 1 from public.doctor_patient_assignments dpa
                 where dpa.doctor_id = auth.uid() and dpa.patient_id = escalation_events.patient_id
                   and dpa.is_active));

revoke insert, update, delete on public.escalation_events from authenticated;
grant select on public.escalation_events to authenticated;

-- Raises every escalation level that is due for one finding. Returns the
-- number of new steps. Only the highest new step notifies, so a finding
-- first seen late does not send three notifications at once.
create or replace function public.escalate_finding(
  p_patient_id    uuid,
  p_assessment_id uuid,
  p_ecg_id        uuid,
  p_reason        text,
  p_found_at      timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_level   integer;
  v_top     integer := -1;
  v_event   uuid;
  v_new     integer := 0;
  v_count   integer;
  v_patient text;
  v_finding text := case p_reason when 'critical_priority' then 'latest check is Critical'
                                  else 'ECG shows possible myocardial infarction (MI)' end;
begin
  if exists (select 1 from public.finding_reviews fr
              where fr.assessment_id = p_assessment_id or fr.ecg_analysis_id = p_ecg_id) then
    return 0;
  end if;

  for v_level in 0..2 loop
    exit when now() - p_found_at < public.medis_escalation_after(v_level);
    v_event := null;
    insert into public.escalation_events (patient_id, assessment_id, ecg_analysis_id, level, reason, finding_at)
    values (p_patient_id, p_assessment_id, p_ecg_id, v_level, p_reason, p_found_at)
    on conflict do nothing
    returning id into v_event;
    if v_event is not null then
      v_new := v_new + 1;
      v_top := v_level;
      insert into public.audit_logs (user_id, action, target_id, target_type, metadata)
      values (null, 'escalated_urgent_finding', p_patient_id, 'patient',
              jsonb_build_object('escalation_id', v_event, 'level', v_level, 'reason', p_reason,
                                 'assessment_id', p_assessment_id, 'ecg_analysis_id', p_ecg_id));
    end if;
  end loop;

  if v_top >= 0 then
    select full_name into v_patient from public.profiles where id = p_patient_id;
    -- Doctors only (including emergency access): AI findings never notify the patient.
    insert into public.notifications (user_id, type, title, body, related_id)
    select dpa.doctor_id, 'general',
           case v_top when 0 then 'Urgent: review needed'
                      when 1 then 'Overdue urgent review'
                      else 'Urgent review escalated (level 2)' end,
           coalesce(v_patient, 'A patient') || ': ' || v_finding ||
           case v_top when 0 then '. Please review it in Clinical Insights.'
                      when 1 then '. Not reviewed after 4 hours.'
                      else '. Still not reviewed after 24 hours.' end,
           p_patient_id
      from public.doctor_patient_assignments dpa
     where dpa.patient_id = p_patient_id and dpa.is_active;
    get diagnostics v_count = row_count;
    update public.escalation_events set doctors_notified = v_count
     where (assessment_id = p_assessment_id or ecg_analysis_id = p_ecg_id) and level = v_top;
  end if;
  return v_new;
end;
$$;
revoke execute on function public.escalate_finding(uuid, uuid, uuid, text, timestamptz) from public, anon, authenticated;

-- Urgent findings: the latest assessment / latest ECG of each patient,
-- inside the look-back window. A newer check supersedes an older one.
create or replace function public.medis_escalate_urgent()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   record;
  v_count integer := 0;
begin
  for v_row in
    select * from (
      select distinct on (a.patient_id) a.patient_id, a.id, a.created_at, a.report ->> 'review_priority' as priority
        from public.cad_assessments a
       order by a.patient_id, a.created_at desc
    ) latest
     where latest.priority = 'URGENT_REVIEW' and latest.created_at >= now() - public.medis_escalation_lookback()
  loop
    v_count := v_count + public.escalate_finding(v_row.patient_id, v_row.id, null, 'critical_priority', v_row.created_at);
  end loop;

  for v_row in
    select * from (
      select distinct on (e.patient_id) e.patient_id, e.id, e.created_at, e.status,
             e.classification ->> 'prediction' as prediction, e.result -> 'validation' ->> 'overall_valid' as valid
        from public.ecg_analyses e
       order by e.patient_id, e.created_at desc
    ) latest
     -- Same rule as ecgFindings() in frontend/src/lib/findingReview.js: digital recordings that passed quality checks.
     where latest.prediction = 'MI' and latest.status = 'validated_continuous_10s_analysis'
       and coalesce(latest.valid, 'true') <> 'false'
       and latest.created_at >= now() - public.medis_escalation_lookback()
  loop
    v_count := v_count + public.escalate_finding(v_row.patient_id, null, v_row.id, 'ecg_possible_mi', v_row.created_at);
  end loop;
  return v_count;
end;
$$;
revoke execute on function public.medis_escalate_urgent() from public, anon, authenticated;

-- ---------- 3. Immediate step for new findings ----------
create or replace function public.escalate_new_finding()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'cad_assessments' then
    if new.report ->> 'review_priority' = 'URGENT_REVIEW' then
      perform public.escalate_finding(new.patient_id, new.id, null, 'critical_priority', new.created_at);
    end if;
  elsif new.classification ->> 'prediction' = 'MI' and new.status = 'validated_continuous_10s_analysis'
        and coalesce(new.result -> 'validation' ->> 'overall_valid', 'true') <> 'false' then
    perform public.escalate_finding(new.patient_id, null, new.id, 'ecg_possible_mi', new.created_at);
  end if;
  return new;
end;
$$;

drop trigger if exists cad_assessments_escalate on public.cad_assessments;
create trigger cad_assessments_escalate
  after insert on public.cad_assessments
  for each row execute function public.escalate_new_finding();

drop trigger if exists ecg_analyses_escalate on public.ecg_analyses;
create trigger ecg_analyses_escalate
  after insert on public.ecg_analyses
  for each row execute function public.escalate_new_finding();

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'medis_escalate_urgent';
    perform cron.schedule('medis_escalate_urgent', '5 * * * *', 'select public.medis_escalate_urgent()');
  end if;
end;
$$;

-- ---------- 4. "Clinical Insights viewed" (step 10) ----------
-- Identical to v8 except for the new action.
create or replace function public.log_patient_access(
  p_patient_id uuid,
  p_action     text,
  p_metadata   jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;

  -- Only these access events are recordable through this function.
  if p_action not in (
    'opened_patient_record', 'viewed_patient', 'viewed_document',
    'downloaded_document', 'uploaded_report', 'deleted_report',
    'generated_history_pdf', 'ran_ai_analysis', 'updated_record',
    'viewed_clinical_insights'
  ) then
    raise exception 'Unknown access event: %', p_action using errcode = '22023';
  end if;

  -- A doctor may only log access to a patient they actually have access
  -- to; a patient may only log activity on their own record.
  if v_actor <> p_patient_id and not exists (
    select 1 from public.doctor_patient_assignments dpa
    where dpa.doctor_id = v_actor
      and dpa.patient_id = p_patient_id
      and dpa.is_active = true
  ) then
    raise exception 'Not authorized to access this patient record.' using errcode = '42501';
  end if;

  insert into public.audit_logs (user_id, action, target_id, target_type, metadata)
  values (v_actor, p_action, p_patient_id, 'patient', p_metadata);
end;
$$;

revoke all on function public.log_patient_access(uuid, text, jsonb) from public, anon;
grant execute on function public.log_patient_access(uuid, text, jsonb) to authenticated;

-- ---------- 5. Access history lists Clinical Insights views ----------
-- Identical to v14 except for the new action and its label. Escalation steps
-- have no doctor actor, so they never appear in the patient's history.
create or replace function public.get_patient_access_events(
  p_patient_id uuid,
  p_search     text        default null,
  p_from       timestamptz default null,
  p_to         timestamptz default null,
  p_limit      integer     default 20,
  p_offset     integer     default 0
)
returns table (
  event_id          uuid,
  doctor_id         uuid,
  doctor_name       text,
  doctor_display_id text,
  specialization    text,
  hospital_name     text,
  action            text,
  access_type       text,
  accessed_at       timestamptz,
  metadata          jsonb,
  total_count       bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 20), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text    := nullif(btrim(coalesce(p_search, '')), '');
begin
  if auth.uid() <> p_patient_id and not exists (
    select 1 from public.doctor_patient_assignments dpa
    where dpa.doctor_id = auth.uid()
      and dpa.patient_id = p_patient_id
      and dpa.is_active = true
  ) then
    raise exception 'Not authorized to view this patient access history';
  end if;

  return query
    with events as (
      select al.id, al.user_id, al.action, al.created_at, al.metadata
      from public.audit_logs al
      join public.profiles actor on actor.id = al.user_id
      where al.target_id = p_patient_id
        and al.target_type = 'patient'
        and actor.role = 'doctor'
        and (p_from is null or al.created_at >= p_from)
        and (p_to   is null or al.created_at <= p_to)
        and (v_search is null
             or actor.full_name ilike '%' || v_search || '%'
             or actor.display_id::text ilike '%' || v_search || '%')
        and al.action in (
          'opened_patient_record', 'viewed_patient', 'viewed_document',
          'downloaded_document', 'uploaded_report', 'deleted_report',
          'generated_history_pdf', 'ran_ai_analysis', 'updated_record',
          'stopped_medication', 'added_medication', 'added_history',
          'finalized_consultation', 'access_requested', 'emergency_access',
          'published_health_summary', 'withdrew_health_summary', 'viewed_clinical_insights'
        )
    )
    select
      e.id,
      e.user_id,
      d.full_name,
      d.display_id::text,
      dp.specialization,
      h.name,
      e.action,
      case e.action
        when 'opened_patient_record'    then 'Record opened'
        when 'viewed_patient'           then 'Profile view'
        when 'viewed_document'          then 'Document view'
        when 'downloaded_document'      then 'Document download'
        when 'generated_history_pdf'    then 'History download'
        when 'uploaded_report'          then 'Document upload'
        when 'deleted_report'           then 'Document deleted'
        when 'ran_ai_analysis'          then 'AI analysis'
        when 'finalized_consultation'   then 'Visit recorded'
        when 'access_requested'         then 'Access requested'
        when 'emergency_access'         then 'Emergency access'
        when 'published_health_summary' then 'Health summary published'
        when 'withdrew_health_summary'  then 'Health summary withdrawn'
        when 'viewed_clinical_insights' then 'Clinical Insights viewed'
        else 'Record update'
      end,
      e.created_at,
      e.metadata,
      count(*) over ()
    from events e
    join public.profiles d on d.id = e.user_id
    left join public.doctor_profiles dp on dp.id = e.user_id
    left join public.hospitals h on h.id = dp.hospital_id
    order by e.created_at desc, e.id desc
    limit v_limit offset v_offset;
end;
$$;

revoke all on function public.get_patient_access_events(uuid, text, timestamptz, timestamptz, integer, integer) from public, anon;
grant execute on function public.get_patient_access_events(uuid, text, timestamptz, timestamptz, integer, integer) to authenticated;

commit;
