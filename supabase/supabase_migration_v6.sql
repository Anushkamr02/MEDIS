-- =====================================================================
-- MEDIS migration v6: doctor shares an AI heart check with the patient
-- Run after v5. Safe to re-run.
--
--  1. cad_assessments gets sharing columns. Only an assessment the doctor
--     explicitly shares becomes visible to the patient (RLS below); the
--     patient always sees their latest shared one.
--  2. Sharing notifies the patient (bell icon).
-- =====================================================================

-- ---------- 1. Sharing columns + patient read policy ----------
alter table public.cad_assessments
  add column if not exists shared_with_patient boolean not null default false,
  add column if not exists shared_at           timestamptz,
  add column if not exists shared_by           uuid references public.profiles(id),
  add column if not exists patient_note        text;   -- the doctor's note to the patient

create index if not exists cad_assessments_shared_idx
  on public.cad_assessments (patient_id, shared_at desc) where shared_with_patient;

drop policy if exists "cad_assessments: patient reads shared" on public.cad_assessments;
create policy "cad_assessments: patient reads shared"
  on public.cad_assessments for select
  using (patient_id = auth.uid() and shared_with_patient);

-- ---------- 2. Notify the patient when an assessment is shared ----------
create or replace function public.notify_cad_assessment_shared()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doctor text;
begin
  if new.shared_with_patient and not coalesce(old.shared_with_patient, false) then
    select full_name into v_doctor from public.profiles where id = new.shared_by;
    insert into public.notifications (user_id, type, title, body, related_id)
    values (new.patient_id, 'general', 'Heart health check shared',
            coalesce('Dr. ' || v_doctor, 'Your doctor') ||
            ' has shared your heart health check. Open your dashboard to see it.',
            new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists cad_assessments_shared_notify on public.cad_assessments;
create trigger cad_assessments_shared_notify
  after update of shared_with_patient on public.cad_assessments
  for each row execute function public.notify_cad_assessment_shared();
