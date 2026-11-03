-- ============================================================
-- MIGRATION V3f — SHARED PATIENT HISTORY + DOCTOR DATA ENTRY
-- Run after v3e.
-- Adds:
--   1. Doctor identities (name, MEDIS ID) readable by signed-in users,
--      so visits / prescriptions can show "Dr. X" to patients and
--      to other doctors.
--   2. Any doctor with access to a patient can read that patient's
--      finalized visits and prescriptions from OTHER doctors
--      (the MEDIS multi-hospital history). Drafts stay private.
--   3. Doctors can upload reports and add / stop current medications
--      for patients they have access to.
--   4. medical_reports.consultation_id — link a report to a visit.
--   5. get_patient_visits() and get_patient_access_history() — the
--      visit timeline and "who accessed this record" list shown on
--      both the patient and doctor dashboards.
-- Every policy is dropped first, so this file is safe to re-run.
-- ============================================================


-- ============================================================
-- STEP 1: DOCTOR IDENTITIES READABLE BY SIGNED-IN USERS
-- (Checks only the row's own role column, so it cannot recurse.)
-- ============================================================
drop policy if exists "profiles: authenticated read doctor identities" on public.profiles;
create policy "profiles: authenticated read doctor identities"
  on public.profiles for select
  to authenticated
  using (role = 'doctor');

-- A patient who booked with a doctor directly has no assignment yet;
-- let that doctor see the patient's name on the appointment list.
drop policy if exists "profiles: doctor reads patients with appointments" on public.profiles;
create policy "profiles: doctor reads patients with appointments"
  on public.profiles for select
  using (
    exists (
      select 1 from public.appointments a
      where a.doctor_id = auth.uid()
        and a.patient_id = profiles.id
    )
  );


-- ============================================================
-- STEP 2: SHARED VISIT HISTORY ACROSS DOCTORS
-- ============================================================
drop policy if exists "consultations: assigned doctor reads finalized visits" on public.consultations;
create policy "consultations: assigned doctor reads finalized visits"
  on public.consultations for select
  using (
    status <> 'pending'
    and exists (
      select 1 from public.doctor_patient_assignments dpa
      where dpa.doctor_id = auth.uid()
        and dpa.patient_id = consultations.patient_id
        and dpa.is_active = true
    )
  );

drop policy if exists "prescriptions: assigned doctor reads" on public.prescriptions;
create policy "prescriptions: assigned doctor reads"
  on public.prescriptions for select
  using (
    exists (
      select 1 from public.doctor_patient_assignments dpa
      where dpa.doctor_id = auth.uid()
        and dpa.patient_id = prescriptions.patient_id
        and dpa.is_active = true
    )
  );


-- ============================================================
-- STEP 3: DOCTOR ADDS REPORTS + MEDICATIONS
-- ============================================================
alter table public.medical_reports
  add column if not exists consultation_id uuid references public.consultations(id) on delete set null;

create index if not exists idx_reports_consultation on public.medical_reports(consultation_id);

drop policy if exists "reports: doctor inserts for assigned patient" on public.medical_reports;
create policy "reports: doctor inserts for assigned patient"
  on public.medical_reports for insert
  with check (
    uploaded_by = auth.uid()
    and exists (
      select 1 from public.doctor_patient_assignments dpa
      where dpa.doctor_id = auth.uid()
        and dpa.patient_id = medical_reports.patient_id
        and dpa.is_active = true
    )
  );

drop policy if exists "medical-reports: doctor uploads to assigned patient folder" on storage.objects;
create policy "medical-reports: doctor uploads to assigned patient folder"
  on storage.objects for insert
  with check (
    bucket_id = 'medical-reports'
    and exists (
      select 1 from public.doctor_patient_assignments dpa
      where dpa.doctor_id = auth.uid()
        and dpa.patient_id::text = (storage.foldername(name))[1]
        and dpa.is_active = true
    )
  );

drop policy if exists "current_meds: doctor inserts for assigned patient" on public.current_medications;
create policy "current_meds: doctor inserts for assigned patient"
  on public.current_medications for insert
  with check (
    exists (
      select 1 from public.doctor_patient_assignments dpa
      where dpa.doctor_id = auth.uid()
        and dpa.patient_id = current_medications.patient_id
        and dpa.is_active = true
    )
  );

drop policy if exists "current_meds: doctor updates for assigned patient" on public.current_medications;
create policy "current_meds: doctor updates for assigned patient"
  on public.current_medications for update
  using (
    exists (
      select 1 from public.doctor_patient_assignments dpa
      where dpa.doctor_id = auth.uid()
        and dpa.patient_id = current_medications.patient_id
        and dpa.is_active = true
    )
  );


-- ============================================================
-- STEP 4: VISIT TIMELINE (all doctors, all hospitals)
-- Callable by the patient themself or a doctor with access.
-- Patients never see drafts, and only see the diagnosis of visits
-- the doctor has shared. Doctors see their own drafts too.
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
  hospital_name          text,
  is_shared_with_patient boolean,
  final_diagnosis        text
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
    raise exception 'Not authorized to view this patient''s visits';
  end if;

  return query
    select
      c.id,
      c.visit_id,
      c.consultation_date,
      c.status,
      c.doctor_id,
      d.full_name,
      d.display_id,
      h.name,
      c.is_shared_with_patient,
      case when not v_is_patient or c.is_shared_with_patient then c.final_diagnosis end
    from public.consultations c
    join public.profiles d on d.id = c.doctor_id
    left join public.hospitals h on h.id = c.hospital_id
    where c.patient_id = p_patient_id
      and (c.status <> 'pending' or c.doctor_id = auth.uid())
    order by c.consultation_date desc;
end;
$$;

revoke all on function public.get_patient_visits(uuid) from public, anon;
grant execute on function public.get_patient_visits(uuid) to authenticated;


-- ============================================================
-- STEP 5: WHO HAS ACCESSED THIS RECORD
-- One row per doctor who was granted access, with first access,
-- last time they opened/viewed the record, and visit count.
-- ============================================================
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
  is_active          boolean
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
      d.display_id,
      dp.specialization,
      h.name,
      dpa.assigned_at,
      (select max(al.created_at) from public.audit_logs al
        where al.user_id = dpa.doctor_id
          and al.target_id = p_patient_id
          and al.action in ('viewed_patient', 'opened_patient_record')),
      (select max(c.consultation_date) from public.consultations c
        where c.doctor_id = dpa.doctor_id
          and c.patient_id = p_patient_id
          and c.status <> 'pending'),
      (select count(*) from public.consultations c
        where c.doctor_id = dpa.doctor_id
          and c.patient_id = p_patient_id
          and c.status <> 'pending'),
      dpa.is_active
    from public.doctor_patient_assignments dpa
    join public.profiles d on d.id = dpa.doctor_id
    left join public.doctor_profiles dp on dp.id = dpa.doctor_id
    left join public.hospitals h on h.id = dp.hospital_id
    where dpa.patient_id = p_patient_id
    order by dpa.assigned_at desc;
end;
$$;

revoke all on function public.get_patient_access_history(uuid) from public, anon;
grant execute on function public.get_patient_access_history(uuid) to authenticated;


-- ============================================================
-- DONE — V3f APPLIED
-- ============================================================
