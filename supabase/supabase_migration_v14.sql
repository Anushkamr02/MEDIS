-- ============================================================
-- MIGRATION V14 — DOCTOR-REVIEWED PUBLICATION + PATIENT LOCKDOWN
-- Run after v13 in the Supabase SQL editor. Safe to re-run.
--
-- 1. Patients can no longer read any cad_assessments row. A shared
--    assessment exposed the raw engine report, flags, priority and risk %
--    through the API even though the UI hid most of it. Assessments that
--    were shared before become invisible until a doctor publishes a
--    summary (team question Q8, default).
-- 2. patient_health_summaries holds what the patient sees: text written
--    and approved by a doctor, a doctor-chosen status message, and the
--    measured values the doctor chose to show. Rows are immutable; a
--    correction is a withdrawal plus a new version, so history stays
--    auditable. Rows are written only by the RPCs below.
-- ============================================================
begin;

-- ---------- 1. Lock assessments to doctors ----------
drop policy if exists "cad_assessments: patient reads shared" on public.cad_assessments;
-- The v6 "Heart health check shared" notification is replaced by publication.
drop trigger if exists cad_assessments_shared_notify on public.cad_assessments;

-- ---------- 2. Published summaries ----------
create table if not exists public.patient_health_summaries (
  id             uuid primary key default gen_random_uuid(),
  patient_id     uuid not null references public.profiles(id) on delete cascade,
  -- Internal link for doctors; the patient cannot read cad_assessments.
  assessment_id  uuid references public.cad_assessments(id) on delete set null,
  status_message text not null check (status_message in ('steady', 'keep_an_eye', 'book_visit')),
  headline       text not null check (length(btrim(headline)) between 1 and 300),
  points         text[] not null default '{}',
  next_step      text,
  shown_metrics  jsonb not null default '{}'::jsonb,  -- copied at publish time
  published_by   uuid not null references public.profiles(id),
  published_at   timestamptz not null default now(),
  withdrawn_at   timestamptz,
  withdrawn_by   uuid references public.profiles(id)
);

create index if not exists patient_health_summaries_patient_idx
  on public.patient_health_summaries (patient_id, published_at desc);

alter table public.patient_health_summaries enable row level security;

drop policy if exists "patient_health_summaries: patient reads own published" on public.patient_health_summaries;
create policy "patient_health_summaries: patient reads own published"
  on public.patient_health_summaries for select
  using (patient_id = auth.uid() and withdrawn_at is null);

drop policy if exists "patient_health_summaries: doctor with access reads" on public.patient_health_summaries;
create policy "patient_health_summaries: doctor with access reads"
  on public.patient_health_summaries for select
  using (exists (select 1 from public.doctor_patient_assignments dpa
                 where dpa.doctor_id = auth.uid() and dpa.patient_id = patient_health_summaries.patient_id
                   and dpa.is_active));

revoke insert, update, delete on public.patient_health_summaries from authenticated;
grant select on public.patient_health_summaries to authenticated;

-- Same rule as the rest of MEDIS (v11): a doctor with active access.
create or replace function public.has_active_doctor_access(p_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.doctor_patient_assignments dpa
      join public.profiles d on d.id = dpa.doctor_id
     where dpa.doctor_id = auth.uid() and dpa.patient_id = p_patient_id
       and dpa.is_active and d.role = 'doctor');
$$;

revoke all on function public.has_active_doctor_access(uuid) from public, anon;
grant execute on function public.has_active_doctor_access(uuid) to authenticated;

-- ---------- 3. Publish ----------
create or replace function public.publish_health_summary(
  p_patient_id     uuid,
  p_assessment_id  uuid,
  p_status_message text,
  p_headline       text,
  p_points         text[],
  p_next_step      text,
  p_shown_metrics  jsonb
)
returns public.patient_health_summaries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor      uuid := auth.uid();
  v_assessment public.cad_assessments;
  v_doctor     text;
  v_row        public.patient_health_summaries;
begin
  if v_actor is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;
  if not public.has_active_doctor_access(p_patient_id) then
    raise exception 'Not authorized to publish for this patient.' using errcode = '42501';
  end if;

  if p_assessment_id is not null then
    select * into v_assessment from public.cad_assessments
     where id = p_assessment_id and patient_id = p_patient_id;
    if v_assessment.id is null then
      raise exception 'That assessment does not belong to this patient.' using errcode = '22023';
    end if;
    -- A significant finding needs a recorded review before anything reaches the
    -- patient. Mirrors assessmentFindings() in frontend/src/lib/findingReview.js (Q5).
    if (v_assessment.report->>'review_priority' in ('URGENT_REVIEW', 'REVIEW')
        or v_assessment.health_trend = 'WORSENING'
        or exists (select 1 from jsonb_array_elements(coalesce(v_assessment.monitoring->'treatment_responses', '[]'::jsonb)) t
                    where t->>'status' = 'worsening_on_treatment'))
       and not exists (select 1 from public.finding_reviews fr where fr.assessment_id = p_assessment_id) then
      raise exception 'Review the findings of this assessment before publishing.' using errcode = '22023';
    end if;
  end if;

  -- One current summary per patient: publishing a new version withdraws the old one.
  update public.patient_health_summaries
     set withdrawn_at = now(), withdrawn_by = v_actor
   where patient_id = p_patient_id and withdrawn_at is null;

  insert into public.patient_health_summaries
    (patient_id, assessment_id, status_message, headline, points, next_step, shown_metrics, published_by)
  values (p_patient_id, p_assessment_id, p_status_message, btrim(p_headline),
          coalesce(array(select btrim(p) from unnest(p_points) p where btrim(p) <> ''), '{}'),
          nullif(btrim(p_next_step), ''), coalesce(p_shown_metrics, '{}'::jsonb), v_actor)
  returning * into v_row;

  select full_name into v_doctor from public.profiles where id = v_actor;
  -- Never mentions AI findings: the patient only learns that a summary exists.
  insert into public.notifications (user_id, type, title, body, related_id)
  values (p_patient_id, 'general', 'Your doctor published a health summary',
          coalesce('Dr. ' || v_doctor, 'Your doctor') || ' published a health summary. Open your dashboard to read it.',
          v_row.id);

  insert into public.audit_logs (user_id, action, target_id, target_type, metadata)
  values (v_actor, 'published_health_summary', p_patient_id, 'patient',
          jsonb_build_object('summary_id', v_row.id, 'assessment_id', p_assessment_id,
                             'status_message', p_status_message));
  return v_row;
end;
$$;

revoke all on function public.publish_health_summary(uuid, uuid, text, text, text[], text, jsonb) from public, anon;
grant execute on function public.publish_health_summary(uuid, uuid, text, text, text[], text, jsonb) to authenticated;

-- ---------- 4. Withdraw ----------
create or replace function public.withdraw_health_summary(p_summary_id uuid)
returns public.patient_health_summaries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_row   public.patient_health_summaries;
begin
  select * into v_row from public.patient_health_summaries where id = p_summary_id;
  if v_row.id is null or not public.has_active_doctor_access(v_row.patient_id) then
    raise exception 'Not authorized to withdraw this summary.' using errcode = '42501';
  end if;
  if v_row.withdrawn_at is not null then
    return v_row;
  end if;

  update public.patient_health_summaries
     set withdrawn_at = now(), withdrawn_by = v_actor
   where id = p_summary_id
  returning * into v_row;

  insert into public.audit_logs (user_id, action, target_id, target_type, metadata)
  values (v_actor, 'withdrew_health_summary', v_row.patient_id, 'patient',
          jsonb_build_object('summary_id', v_row.id));
  return v_row;
end;
$$;

revoke all on function public.withdraw_health_summary(uuid) from public, anon;
grant execute on function public.withdraw_health_summary(uuid) to authenticated;

-- ---------- 5. Access history lists publication ----------
-- Identical to v11 except for the two new actions and their labels.
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
          'published_health_summary', 'withdrew_health_summary'
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
