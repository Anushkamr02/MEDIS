-- ============================================================
-- MIGRATION V12 — CONTINUOUS MONITORING
-- Run after v11 in the Supabase SQL editor. Safe to re-run.
--
-- 1. cad_assessments records what triggered each check and the
--    monitoring result (Improving / Stable / Worsening / Not enough data).
-- 2. monitoring_queue: patients waiting for a re-check. Triggers queue a
--    patient when a visit is finalized, a prescription is issued or a
--    report is verified, so nothing is lost if the AI service was down.
--    The AI service (acting as a doctor with access) processes the queue
--    and adds treatment follow-up rows, because the medicine list lives in
--    the engine (medis/ai/drug_classes.py), not here.
-- 3. A daily pg_cron job tells doctors when a treatment follow-up is due.
-- 4. Doctors with access are notified when a patient turns Worsening.
--
-- No service-role key is involved: queueing runs in SECURITY DEFINER
-- triggers, and processing runs with the signed-in doctor's token.
-- ============================================================
begin;

-- ---------- 1. Monitoring columns on cad_assessments ----------
alter table public.cad_assessments
  add column if not exists trigger_event          text,
  add column if not exists trigger_ref            uuid,
  add column if not exists previous_assessment_id uuid references public.cad_assessments(id) on delete set null,
  add column if not exists health_trend           text,
  add column if not exists monitoring             jsonb;

alter table public.cad_assessments
  drop constraint if exists cad_assessments_trigger_event_check,
  add  constraint cad_assessments_trigger_event_check
    check (trigger_event is null or trigger_event in
      ('manual', 'visit_finalized', 'prescription_issued', 'report_verified', 'queued_recheck')),
  drop constraint if exists cad_assessments_health_trend_check,
  add  constraint cad_assessments_health_trend_check
    check (health_trend is null or health_trend in ('IMPROVING', 'STABLE', 'WORSENING', 'INSUFFICIENT_DATA'));

-- ---------- 2. Re-check queue ----------
create table if not exists public.monitoring_queue (
  id           uuid primary key default gen_random_uuid(),
  patient_id   uuid not null references public.profiles(id) on delete cascade,
  reason       text not null check (reason in
                 ('visit_finalized', 'prescription_issued', 'report_verified', 'treatment_follow_up')),
  ref_id       uuid,
  detail       jsonb,                 -- treatment_follow_up: {medicine, metric, metric_label, started}
  dedupe_key   text unique,           -- stops the same follow-up being queued twice
  due_at       timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  notified_at  timestamptz,           -- "follow-up due" notification sent
  processed_at timestamptz
);

create index if not exists monitoring_queue_pending_idx
  on public.monitoring_queue (due_at) where processed_at is null;
create index if not exists monitoring_queue_patient_idx
  on public.monitoring_queue (patient_id) where processed_at is null;

alter table public.monitoring_queue enable row level security;

drop policy if exists "monitoring_queue: doctor with access reads" on public.monitoring_queue;
create policy "monitoring_queue: doctor with access reads"
  on public.monitoring_queue for select
  using (exists (select 1 from public.doctor_patient_assignments dpa
                 where dpa.doctor_id = auth.uid() and dpa.patient_id = monitoring_queue.patient_id
                   and dpa.is_active));

-- The AI service adds follow-up checks for the doctor it acts as.
drop policy if exists "monitoring_queue: doctor with access adds follow-ups" on public.monitoring_queue;
create policy "monitoring_queue: doctor with access adds follow-ups"
  on public.monitoring_queue for insert
  with check (reason = 'treatment_follow_up'
              and exists (select 1 from public.doctor_patient_assignments dpa
                          where dpa.doctor_id = auth.uid() and dpa.patient_id = monitoring_queue.patient_id
                            and dpa.is_active));

drop policy if exists "monitoring_queue: doctor with access marks processed" on public.monitoring_queue;
create policy "monitoring_queue: doctor with access marks processed"
  on public.monitoring_queue for update
  using (exists (select 1 from public.doctor_patient_assignments dpa
                 where dpa.doctor_id = auth.uid() and dpa.patient_id = monitoring_queue.patient_id
                   and dpa.is_active));

-- Doctors may only stamp processed_at; everything else is written by triggers.
revoke update on public.monitoring_queue from authenticated;
grant select, insert on public.monitoring_queue to authenticated;
grant update (processed_at) on public.monitoring_queue to authenticated;

create or replace function public.queue_monitoring(p_patient_id uuid, p_reason text, p_ref_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- One open row per event is enough; processing collapses rows per patient.
  if not exists (select 1 from public.monitoring_queue q
                 where q.patient_id = p_patient_id and q.reason = p_reason
                   and q.ref_id is not distinct from p_ref_id and q.processed_at is null) then
    insert into public.monitoring_queue (patient_id, reason, ref_id) values (p_patient_id, p_reason, p_ref_id);
  end if;
end;
$$;
revoke execute on function public.queue_monitoring(uuid, text, uuid) from public, anon, authenticated;

create or replace function public.queue_on_consultation_finalized()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'completed' and (tg_op = 'INSERT' or old.status is distinct from 'completed') then
    perform public.queue_monitoring(new.patient_id, 'visit_finalized', new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists consultations_queue_monitoring on public.consultations;
create trigger consultations_queue_monitoring
  after insert or update of status on public.consultations
  for each row execute function public.queue_on_consultation_finalized();

create or replace function public.queue_on_prescription_issued()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.queue_monitoring(new.patient_id, 'prescription_issued', new.id);
  return new;
end;
$$;

drop trigger if exists prescriptions_queue_monitoring on public.prescriptions;
create trigger prescriptions_queue_monitoring
  after insert on public.prescriptions
  for each row execute function public.queue_on_prescription_issued();

create or replace function public.queue_on_report_verified()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.review_status = 'verified' and (tg_op = 'INSERT' or old.review_status is distinct from 'verified') then
    perform public.queue_monitoring(new.patient_id, 'report_verified', new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists medical_reports_queue_monitoring on public.medical_reports;
create trigger medical_reports_queue_monitoring
  after insert or update of review_status on public.medical_reports
  for each row execute function public.queue_on_report_verified();

-- ---------- 3. Daily "treatment follow-up due" notifications ----------
create or replace function public.medis_monitoring_due()
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
    select q.id, q.patient_id, q.detail, p.full_name as patient_name
      from public.monitoring_queue q
      join public.profiles p on p.id = q.patient_id
     where q.reason = 'treatment_follow_up' and q.due_at <= now()
       and q.notified_at is null and q.processed_at is null
  loop
    insert into public.notifications (user_id, type, title, body, related_id)
    select dpa.doctor_id, 'general', 'Treatment follow-up due',
           coalesce(v_row.patient_name, 'A patient') || ': ' ||
           coalesce(v_row.detail ->> 'metric_label', 'follow-up') || ' check after ' ||
           coalesce(v_row.detail ->> 'medicine', 'the new medicine') || ' is due.',
           v_row.patient_id
      from public.doctor_patient_assignments dpa
     where dpa.patient_id = v_row.patient_id and dpa.is_active;
    update public.monitoring_queue set notified_at = now() where id = v_row.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke execute on function public.medis_monitoring_due() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'medis_monitoring_due';
    -- 03:00 UTC = 08:30 IST, before morning clinics
    perform cron.schedule('medis_monitoring_due', '0 3 * * *', 'select public.medis_monitoring_due()');
  end if;
end;
$$;

-- ---------- 4. Notify the care team when a patient turns Worsening ----------
create or replace function public.notify_patient_worsening()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_patient text;
begin
  if new.health_trend = 'WORSENING' then
    select full_name into v_patient from public.profiles where id = new.patient_id;
    -- AI findings go to doctors only, never to the patient.
    insert into public.notifications (user_id, type, title, body, related_id)
    select dpa.doctor_id, 'general', 'Patient worsening',
           coalesce(v_patient, 'A patient') || '''s latest check shows recorded values moving away from target. '
           || 'Open their Monitoring card to review.',
           new.patient_id
      from public.doctor_patient_assignments dpa
     where dpa.patient_id = new.patient_id and dpa.is_active
       and dpa.doctor_id is distinct from new.requested_by;
  end if;
  return new;
end;
$$;

drop trigger if exists cad_assessments_worsening_notify on public.cad_assessments;
create trigger cad_assessments_worsening_notify
  after insert on public.cad_assessments
  for each row execute function public.notify_patient_worsening();

commit;
