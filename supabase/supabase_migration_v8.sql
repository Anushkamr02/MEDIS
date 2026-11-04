-- ============================================================
-- MIGRATION V8 — PER-EVENT ACCESS HISTORY, RICHER VISIT HISTORY
-- Run after v7 in the Supabase SQL editor. Safe to re-run.
--
-- 1. log_patient_access()        — the single server-side entry point
--                                  for recording an access event. The
--                                  timestamp is the server's, the actor
--                                  is auth.uid(), and the action must be
--                                  on a fixed whitelist.
-- 2. get_patient_access_events() — the individual audit events behind
--                                  "Doctors who accessed my profile",
--                                  newest first, with pagination.
-- 3. get_patient_visits()        — extended with the fields both visit
--                                  history panels show (reason,
--                                  specialization, follow-up, counts).
-- 4. get_patient_visit_details() — one visit in full, with its
--                                  prescriptions and documents.
-- 5. delete_medical_report()     — a patient or doctor removing a
--                                  document they uploaded themselves.
--
-- Nothing here invents history: every row returned comes from a real
-- audit_logs / consultations / prescriptions / medical_reports row.
-- ============================================================
begin;


-- ============================================================
-- STEP 1: SERVER-SIDE ACCESS LOGGING
-- The frontend and the AI service both call this instead of
-- inserting into audit_logs directly, so the caller cannot choose
-- the timestamp, the actor, or an arbitrary action name.
-- ============================================================
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
    'generated_history_pdf', 'ran_ai_analysis', 'updated_record'
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

  -- created_at keeps its column default (now()), so the timestamp is the
  -- server's and never the caller's.
  insert into public.audit_logs (user_id, action, target_id, target_type, metadata)
  values (v_actor, p_action, p_patient_id, 'patient', p_metadata);
end;
$$;

revoke all on function public.log_patient_access(uuid, text, jsonb) from public, anon;
grant execute on function public.log_patient_access(uuid, text, jsonb) to authenticated;


-- ============================================================
-- STEP 2: PER-EVENT ACCESS HISTORY
-- One row per recorded event, not one per doctor. Readable by the
-- patient themself and by a doctor with an active assignment.
-- Only events whose actor is a doctor are listed: this answers
-- "which doctors opened my record".
-- ============================================================
-- Searching, date filtering and paging all happen here rather than in
-- the browser, so a filtered list is filtered over the whole history and
-- not only over the page that happens to be loaded. The date bounds are
-- timestamptz: the caller sends the start and end of the chosen local
-- days, so a filter means the same thing in every timezone.
drop function if exists public.get_patient_access_events(uuid, integer, integer);
drop function if exists public.get_patient_access_events(uuid, text, timestamptz, timestamptz, integer, integer);

create function public.get_patient_access_events(
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
          'finalized_consultation'
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
        when 'opened_patient_record'  then 'Record opened'
        when 'viewed_patient'         then 'Profile view'
        when 'viewed_document'        then 'Document view'
        when 'downloaded_document'    then 'Document download'
        when 'generated_history_pdf'  then 'History download'
        when 'uploaded_report'        then 'Document upload'
        when 'deleted_report'         then 'Document deleted'
        when 'ran_ai_analysis'        then 'AI analysis'
        when 'finalized_consultation' then 'Visit recorded'
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


-- ============================================================
-- STEP 3: VISIT TIMELINE, WITH WHAT BOTH PANELS DISPLAY
-- Same authorization and the same patient-visibility rules as v3f: a
-- patient sees no other doctor's drafts, and no clinical detail for a
-- visit the doctor has not shared. Only the returned columns grow.
-- ============================================================
drop function if exists public.get_patient_visits(uuid);

create function public.get_patient_visits(p_patient_id uuid)
returns table (
  consultation_id        uuid,
  visit_id               text,
  consultation_date      timestamptz,
  status                 text,
  doctor_id              uuid,
  doctor_name            text,
  doctor_display_id      text,
  specialization         text,
  hospital_name          text,
  is_shared_with_patient boolean,
  reason                 text,
  final_diagnosis        text,
  doctor_notes           text,
  follow_up_date         date,
  prescription_count     bigint,
  document_count         bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_is_patient boolean := (auth.uid() = p_patient_id);
begin
  if not v_is_patient and not exists (
    select 1 from public.doctor_patient_assignments dpa
    where dpa.doctor_id = auth.uid()
      and dpa.patient_id = p_patient_id
      and dpa.is_active = true
  ) then
    raise exception 'Not authorized to view this patient visits';
  end if;

  return query
    select
      c.id,
      c.visit_id,
      c.consultation_date,
      c.status,
      c.doctor_id,
      d.full_name,
      d.display_id::text,
      dp.specialization,
      h.name,
      c.is_shared_with_patient,
      -- Clinical content stays hidden until the visit is shared.
      case when not v_is_patient or c.is_shared_with_patient
        then nullif(btrim(coalesce(c.complaints->>'main_complaint', '')), '') end,
      case when not v_is_patient or c.is_shared_with_patient then c.final_diagnosis end,
      case when not v_is_patient or c.is_shared_with_patient then c.doctor_notes end,
      -- Cast so the column matches whether follow_up_date is stored as a
      -- date or as a timestamp.
      (case when not v_is_patient or c.is_shared_with_patient then c.follow_up_date end)::date,
      (select count(*) from public.prescriptions rx where rx.consultation_id = c.id),
      (select count(*) from public.medical_reports mr where mr.consultation_id = c.id)
    from public.consultations c
    join public.profiles d on d.id = c.doctor_id
    left join public.doctor_profiles dp on dp.id = c.doctor_id
    left join public.hospitals h on h.id = coalesce(c.hospital_id, dp.hospital_id)
    where c.patient_id = p_patient_id
      and (c.status <> 'pending' or c.doctor_id = auth.uid())
    order by c.consultation_date desc;
end;
$$;

revoke all on function public.get_patient_visits(uuid) from public, anon;
grant execute on function public.get_patient_visits(uuid) to authenticated;


-- ============================================================
-- STEP 4: ONE VISIT IN FULL — the "View details" payload
-- Returns a single jsonb object so the prescriptions and documents of
-- that visit come back in the same authorized round trip.
-- ============================================================
drop function if exists public.get_patient_visit_details(uuid);

create function public.get_patient_visit_details(p_consultation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_visit      public.consultations%rowtype;
  v_is_patient boolean;
  v_visible    boolean;
begin
  select * into v_visit from public.consultations where id = p_consultation_id;
  if not found then
    raise exception 'Visit not found' using errcode = '42501';
  end if;

  v_is_patient := (auth.uid() = v_visit.patient_id);

  if not v_is_patient and not exists (
    select 1 from public.doctor_patient_assignments dpa
    where dpa.doctor_id = auth.uid()
      and dpa.patient_id = v_visit.patient_id
      and dpa.is_active = true
  ) then
    raise exception 'Not authorized to view this visit' using errcode = '42501';
  end if;

  -- A patient never opens an unfinished draft.
  if v_is_patient and v_visit.status = 'pending' then
    raise exception 'Not authorized to view this visit' using errcode = '42501';
  end if;

  v_visible := (not v_is_patient) or v_visit.is_shared_with_patient;

  return jsonb_build_object(
    'consultation_id', v_visit.id,
    'visit_id', v_visit.visit_id,
    'consultation_date', v_visit.consultation_date,
    'status', v_visit.status,
    'is_shared_with_patient', v_visit.is_shared_with_patient,
    'is_visible', v_visible,
    'follow_up_date', case when v_visible then v_visit.follow_up_date end,
    'doctor', (
      select jsonb_build_object(
        'doctor_id', d.id,
        'doctor_name', d.full_name,
        'doctor_display_id', d.display_id,
        'specialization', dp.specialization,
        'hospital_name', h.name
      )
      from public.profiles d
      left join public.doctor_profiles dp on dp.id = d.id
      left join public.hospitals h on h.id = coalesce(v_visit.hospital_id, dp.hospital_id)
      where d.id = v_visit.doctor_id
    ),
    'reason', case when v_visible
      then nullif(btrim(coalesce(v_visit.complaints->>'main_complaint', '')), '') end,
    'complaints', case when v_visible then v_visit.complaints end,
    'observations', case when v_visible then v_visit.observations end,
    'preliminary_diagnosis', case when v_visible then v_visit.preliminary_diagnosis end,
    'final_diagnosis', case when v_visible then v_visit.final_diagnosis end,
    'doctor_notes', case when v_visible then v_visit.doctor_notes end,
    'prescriptions', case when v_visible then coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', rx.id,
               'issued_at', rx.issued_at,
               'medicines', rx.medicines,
               'instructions', rx.instructions,
               'doctor_name', pd.full_name
             ) order by rx.issued_at desc)
      from public.prescriptions rx
      left join public.profiles pd on pd.id = rx.doctor_id
      where rx.consultation_id = v_visit.id
    ), '[]'::jsonb) else '[]'::jsonb end,
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', mr.id,
               'file_name', mr.file_name,
               'file_url', mr.file_url,
               'category', mr.category,
               'report_date', mr.report_date,
               'uploaded_at', mr.uploaded_at
             ) order by mr.uploaded_at desc)
      from public.medical_reports mr
      where mr.consultation_id = v_visit.id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_patient_visit_details(uuid) from public, anon;
grant execute on function public.get_patient_visit_details(uuid) to authenticated;


-- ============================================================
-- STEP 5: DELETING A DOCUMENT YOU UPLOADED
-- Only the uploader may delete, and only while the document is not
-- attached to a completed visit — a finalized record stays intact.
-- Returns the storage path so the caller can remove the stored object.
-- ============================================================
drop function if exists public.delete_medical_report(uuid);

create function public.delete_medical_report(p_report_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report public.medical_reports%rowtype;
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;

  select * into v_report from public.medical_reports
    where id = p_report_id for update;
  if not found then
    raise exception 'Document not found.' using errcode = '42501';
  end if;

  if v_report.uploaded_by is distinct from auth.uid() then
    raise exception 'Only the account that uploaded this document can delete it.' using errcode = '42501';
  end if;

  if v_report.consultation_id is not null then
    select status into v_status from public.consultations where id = v_report.consultation_id;
    if v_status is distinct from 'pending' then
      raise exception 'This document belongs to a completed visit and cannot be deleted.' using errcode = '42501';
    end if;
  end if;

  insert into public.audit_logs (user_id, action, target_id, target_type, metadata)
  values (auth.uid(), 'deleted_report', v_report.patient_id, 'patient',
          jsonb_build_object('file_name', v_report.file_name, 'category', v_report.category));

  delete from public.medical_reports where id = p_report_id;
  return v_report.file_url;
end;
$$;

revoke all on function public.delete_medical_report(uuid) from public, anon;
grant execute on function public.delete_medical_report(uuid) to authenticated;

-- Removing the stored object is allowed only for the account that
-- uploaded it (storage.objects.owner is set by Storage on upload).
drop policy if exists "medical-reports: uploader deletes own object" on storage.objects;
create policy "medical-reports: uploader deletes own object"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'medical-reports' and owner = auth.uid());


-- ============================================================
-- STEP 6: FILE SIZE ON DOCUMENTS
-- Recorded from now on by the upload form. Documents uploaded before
-- this migration keep a null size and the UI shows it as unknown
-- rather than guessing one.
-- ============================================================
alter table public.medical_reports
  add column if not exists file_size_bytes bigint;


-- ============================================================
-- STEP 7: INDEX FOR THE ACCESS-HISTORY QUERY
-- ============================================================
create index if not exists idx_audit_logs_target_created
  on public.audit_logs (target_id, created_at desc);

commit;

-- ============================================================
-- DONE — V8 APPLIED
-- ============================================================
