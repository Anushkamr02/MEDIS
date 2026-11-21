-- ============================================================
-- MIGRATION V11 — PATIENT-CONTROLLED ACCESS
-- Run after v10 in the Supabase SQL editor. Safe to re-run.
--
-- Before: any doctor who searched a Patient ID got the record at once
-- (is_active = true on doctor_patient_assignments) and the patient only
-- found out afterwards, from the access history.
--
-- After: a search creates a *request* (is_active = false,
-- access_status = 'pending'). The patient approves or declines it from
-- "Doctors who accessed your profile", and can revoke any doctor later.
-- Emergency access ("break the glass") still opens the record at once,
-- but needs a written reason and is flagged in the patient's access
-- history and notifications. An appointment the patient booked
-- themself counts as consent for that doctor.
--
-- is_active stays the one flag every RLS policy checks, so no policy
-- changes. A trigger keeps direct writes honest: a row created outside
-- the functions below becomes a pending request, and nothing outside
-- them can switch a row to active.
-- ============================================================
begin;

-- ---------- 1. Request state on the assignment row ----------
alter table public.doctor_patient_assignments
  add column if not exists access_status text        not null default 'active',
  add column if not exists is_emergency  boolean     not null default false,
  add column if not exists access_reason text,
  add column if not exists requested_at  timestamptz,
  add column if not exists responded_at  timestamptz,
  add column if not exists revoked_at    timestamptz;

-- Rows from before this migration: an inactive row reads as revoked.
update public.doctor_patient_assignments
   set access_status = 'revoked'
 where access_status = 'active' and not is_active;

alter table public.doctor_patient_assignments
  drop constraint if exists doctor_patient_assignments_access_status_check,
  add  constraint doctor_patient_assignments_access_status_check
    check (access_status in ('pending', 'active', 'denied', 'revoked')),
  drop constraint if exists doctor_patient_assignments_active_matches_status,
  add  constraint doctor_patient_assignments_active_matches_status
    check (is_active = (access_status = 'active'));

create index if not exists doctor_patient_assignments_pending_idx
  on public.doctor_patient_assignments (patient_id, requested_at desc)
  where access_status = 'pending';

-- ---------- 2. Guard: only the functions below can grant access ----------
-- The functions mark their transaction with medis.access_rpc = 'on'.
-- Admin sessions (migrations, the demo seed) have no auth.uid() and are
-- left alone. Anything else that inserts a row — the old frontend, a
-- trigger on consultations — gets a pending request instead of access,
-- unless the doctor already holds it (then ON CONFLICT discards the row).
create or replace function public.guard_assignment_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('medis.access_rpc', true) = 'on' or auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if exists (
      select 1 from public.doctor_patient_assignments a
      where a.doctor_id = new.doctor_id and a.patient_id = new.patient_id and a.is_active
    ) then
      return new;
    end if;
    new.is_active     := false;
    new.access_status := 'pending';
    new.is_emergency  := false;
    new.requested_at  := coalesce(new.requested_at, now());
    new.responded_at  := null;
    new.revoked_at    := null;
    return new;
  end if;

  if new.is_active and not old.is_active then
    raise exception 'Access to a patient record is granted by the patient.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists doctor_patient_assignments_guard on public.doctor_patient_assignments;
create trigger doctor_patient_assignments_guard
  before insert or update on public.doctor_patient_assignments
  for each row execute function public.guard_assignment_write();

-- ---------- 3. Doctor asks for access (or takes it in an emergency) ----------
-- Returns the resulting state: 'active' or 'pending'.
create or replace function public.request_patient_access(
  p_patient_id     uuid,
  p_reason         text    default null,
  p_emergency      boolean default false,
  p_appointment_id uuid    default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doctor      uuid := auth.uid();
  v_reason      text := nullif(btrim(coalesce(p_reason, '')), '');
  v_existing    public.doctor_patient_assignments%rowtype;
  v_doctor_name text;
  v_hospital    text;
  v_grant       boolean := false;
begin
  if v_doctor is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles p where p.id = v_doctor and p.role = 'doctor') then
    raise exception 'Only doctors can request access to a patient record.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_patient_id and p.role = 'patient') then
    raise exception 'Patient not found.' using errcode = 'P0002';
  end if;

  perform set_config('medis.access_rpc', 'on', true);

  select * into v_existing
    from public.doctor_patient_assignments
   where doctor_id = v_doctor and patient_id = p_patient_id
   for update;

  if v_existing.doctor_id is not null and v_existing.is_active then
    return 'active';
  end if;

  select pr.full_name, h.name into v_doctor_name, v_hospital
    from public.profiles pr
    left join public.doctor_profiles dp on dp.id = pr.id
    left join public.hospitals h on h.id = dp.hospital_id
   where pr.id = v_doctor;

  if p_emergency then
    if v_reason is null or length(v_reason) < 10 then
      raise exception 'Emergency access needs a reason of at least 10 characters.' using errcode = '22023';
    end if;
    v_grant := true;
  elsif p_appointment_id is not null and exists (
    -- The patient chose this doctor when they booked, so no second approval.
    select 1 from public.appointments a
     where a.id = p_appointment_id
       and a.doctor_id = v_doctor and a.patient_id = p_patient_id
       and a.booked_by = 'patient' and a.status = 'scheduled'
  ) then
    v_grant := true;
  end if;

  if v_grant then
    insert into public.doctor_patient_assignments
      (doctor_id, patient_id, is_active, assigned_at, access_status, is_emergency,
       access_reason, requested_at, responded_at, revoked_at)
    values
      (v_doctor, p_patient_id, true, now(), 'active', p_emergency,
       v_reason, now(), now(), null)
    on conflict (doctor_id, patient_id) do update
      set is_active = true, assigned_at = now(), access_status = 'active',
          is_emergency = excluded.is_emergency, access_reason = excluded.access_reason,
          requested_at = now(), responded_at = now(), revoked_at = null;

    if p_emergency then
      insert into public.audit_logs (user_id, action, target_id, target_type, metadata)
      values (v_doctor, 'emergency_access', p_patient_id, 'patient', jsonb_build_object('reason', v_reason));

      insert into public.notifications (user_id, type, title, body, related_id)
      values (p_patient_id, 'general', 'Emergency access to your record',
              coalesce('Dr. ' || v_doctor_name, 'A doctor') || coalesce(' (' || v_hospital || ')', '') ||
              ' opened your record under emergency access. Reason given: ' || v_reason ||
              '. You can review or revoke this under "Doctors who accessed your profile".',
              v_doctor);
    end if;
    return 'active';
  end if;

  -- A request that is already waiting is not sent twice.
  if v_existing.doctor_id is not null and v_existing.access_status = 'pending' then
    return 'pending';
  end if;

  insert into public.doctor_patient_assignments
    (doctor_id, patient_id, is_active, access_status, is_emergency,
     access_reason, requested_at, responded_at, revoked_at)
  values
    (v_doctor, p_patient_id, false, 'pending', false, v_reason, now(), null, null)
  on conflict (doctor_id, patient_id) do update
    set is_active = false, access_status = 'pending', is_emergency = false,
        access_reason = excluded.access_reason, requested_at = now(),
        responded_at = null, revoked_at = null;

  insert into public.audit_logs (user_id, action, target_id, target_type, metadata)
  values (v_doctor, 'access_requested', p_patient_id, 'patient',
          case when v_reason is null then null else jsonb_build_object('reason', v_reason) end);

  insert into public.notifications (user_id, type, title, body, related_id)
  values (p_patient_id, 'general', 'A doctor is asking to open your record',
          coalesce('Dr. ' || v_doctor_name, 'A doctor') || coalesce(' (' || v_hospital || ')', '') ||
          ' has asked for access to your MEDIS record.' || coalesce(' Reason: ' || v_reason || '.', '') ||
          ' Approve or decline it under "Doctors who accessed your profile".',
          v_doctor);
  return 'pending';
end;
$$;

revoke all on function public.request_patient_access(uuid, text, boolean, uuid) from public, anon;
grant execute on function public.request_patient_access(uuid, text, boolean, uuid) to authenticated;

-- ---------- 4. Patient approves or declines ----------
-- Returns 'active' or 'denied'.
create or replace function public.respond_access_request(p_doctor_id uuid, p_approve boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_patient      uuid := auth.uid();
  v_row          public.doctor_patient_assignments%rowtype;
  v_patient_name text;
  v_display      text;
begin
  if v_patient is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;

  perform set_config('medis.access_rpc', 'on', true);

  select * into v_row
    from public.doctor_patient_assignments
   where doctor_id = p_doctor_id and patient_id = v_patient
   for update;

  if v_row.doctor_id is null or v_row.access_status <> 'pending' then
    raise exception 'There is no pending access request from this doctor.' using errcode = 'P0002';
  end if;

  if p_approve then
    update public.doctor_patient_assignments
       set is_active = true, access_status = 'active', assigned_at = now(),
           responded_at = now(), revoked_at = null
     where doctor_id = p_doctor_id and patient_id = v_patient;
  else
    update public.doctor_patient_assignments
       set is_active = false, access_status = 'denied', responded_at = now()
     where doctor_id = p_doctor_id and patient_id = v_patient;
  end if;

  select full_name, display_id::text into v_patient_name, v_display
    from public.profiles where id = v_patient;

  insert into public.audit_logs (user_id, action, target_id, target_type, metadata)
  values (v_patient, case when p_approve then 'access_granted' else 'access_denied' end,
          v_patient, 'patient', jsonb_build_object('doctor_id', p_doctor_id));

  insert into public.notifications (user_id, type, title, body, related_id)
  values (p_doctor_id, 'general',
          case when p_approve then 'Access approved' else 'Access declined' end,
          coalesce(v_patient_name, 'A patient') || coalesce(' (' || v_display || ')', '') ||
          case when p_approve
               then ' approved your request. You can open their record from My Patients.'
               else ' declined your request to open their record.' end,
          v_patient);

  return case when p_approve then 'active' else 'denied' end;
end;
$$;

revoke all on function public.respond_access_request(uuid, boolean) from public, anon;
grant execute on function public.respond_access_request(uuid, boolean) to authenticated;

-- ---------- 5. Patient revokes a doctor ----------
create or replace function public.revoke_doctor_access(p_doctor_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_patient      uuid := auth.uid();
  v_row          public.doctor_patient_assignments%rowtype;
  v_patient_name text;
  v_display      text;
begin
  if v_patient is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;

  perform set_config('medis.access_rpc', 'on', true);

  select * into v_row
    from public.doctor_patient_assignments
   where doctor_id = p_doctor_id and patient_id = v_patient
   for update;

  if v_row.doctor_id is null or not v_row.is_active then
    raise exception 'This doctor does not currently have access to your record.' using errcode = 'P0002';
  end if;

  update public.doctor_patient_assignments
     set is_active = false, access_status = 'revoked', revoked_at = now()
   where doctor_id = p_doctor_id and patient_id = v_patient;

  select full_name, display_id::text into v_patient_name, v_display
    from public.profiles where id = v_patient;

  insert into public.audit_logs (user_id, action, target_id, target_type, metadata)
  values (v_patient, 'access_revoked', v_patient, 'patient', jsonb_build_object('doctor_id', p_doctor_id));

  insert into public.notifications (user_id, type, title, body, related_id)
  values (p_doctor_id, 'general', 'Access revoked',
          coalesce(v_patient_name, 'A patient') || coalesce(' (' || v_display || ')', '') ||
          ' has revoked your access to their record. You can request it again from My Patients.',
          v_patient);
end;
$$;

revoke all on function public.revoke_doctor_access(uuid) from public, anon;
grant execute on function public.revoke_doctor_access(uuid) to authenticated;

-- ---------- 6. Per-doctor access summary now carries the request state ----------
-- Same authorization as v3f; the patient sees every doctor who ever
-- asked, so they can approve, decline or revoke from one list.
drop function if exists public.get_patient_access_history(uuid);

create function public.get_patient_access_history(p_patient_id uuid)
returns table (
  doctor_id          uuid,
  doctor_name        text,
  doctor_display_id  text,
  specialization     text,
  hospital_name      text,
  first_access       timestamptz,
  last_accessed      timestamptz,
  last_visit         timestamptz,
  visit_count        bigint,
  is_active          boolean,
  access_status      text,
  is_emergency       boolean,
  access_reason      text,
  requested_at       timestamptz,
  responded_at       timestamptz,
  revoked_at         timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if auth.uid() <> p_patient_id and not exists (
    select 1 from public.doctor_patient_assignments dpa
    where dpa.doctor_id = auth.uid()
      and dpa.patient_id = p_patient_id
      and dpa.is_active = true
  ) then
    raise exception 'Not authorized to view this patient''s access history';
  end if;

  return query
    select
      dpa.doctor_id,
      d.full_name,
      d.display_id::text,
      dp.specialization,
      h.name,
      dpa.assigned_at,
      (select max(al.created_at) from public.audit_logs al
        where al.user_id = dpa.doctor_id
          and al.target_id = p_patient_id
          and al.action in ('viewed_patient', 'opened_patient_record', 'emergency_access')),
      (select max(c.consultation_date) from public.consultations c
        where c.doctor_id = dpa.doctor_id
          and c.patient_id = p_patient_id
          and c.status <> 'pending'),
      (select count(*) from public.consultations c
        where c.doctor_id = dpa.doctor_id
          and c.patient_id = p_patient_id
          and c.status <> 'pending'),
      dpa.is_active,
      dpa.access_status,
      dpa.is_emergency,
      dpa.access_reason,
      dpa.requested_at,
      dpa.responded_at,
      dpa.revoked_at
    from public.doctor_patient_assignments dpa
    join public.profiles d on d.id = dpa.doctor_id
    left join public.doctor_profiles dp on dp.id = dpa.doctor_id
    left join public.hospitals h on h.id = dp.hospital_id
    where dpa.patient_id = p_patient_id
    order by (dpa.access_status = 'pending') desc, dpa.is_active desc,
             coalesce(dpa.requested_at, dpa.assigned_at) desc;
end;
$$;

revoke all on function public.get_patient_access_history(uuid) from public, anon;
grant execute on function public.get_patient_access_history(uuid) to authenticated;

-- ---------- 7. The event list shows requests and emergency access ----------
-- Identical to v8 except for the two new actions and their labels.
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
          'finalized_consultation', 'access_requested', 'emergency_access'
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
        when 'access_requested'       then 'Access requested'
        when 'emergency_access'       then 'Emergency access'
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

-- ============================================================
-- DONE — V11 APPLIED
-- ============================================================
