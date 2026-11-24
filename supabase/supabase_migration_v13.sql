-- ============================================================
-- MIGRATION V13 — REVIEW OF SIGNIFICANT FINDINGS
-- Run after v12 in the Supabase SQL editor. Safe to re-run.
--
-- finding_reviews records that a doctor with access evaluated a
-- clinically significant AI finding (a cad_assessments row or an
-- ecg_analyses row) and what they decided. Rows are written only by
-- record_finding_review(), which checks access and writes the audit row
-- itself, so a client cannot skip either. Reviews are doctor-only: there
-- is deliberately no patient policy on this table.
-- ============================================================
begin;

create table if not exists public.finding_reviews (
  id              uuid primary key default gen_random_uuid(),
  patient_id      uuid not null references public.profiles(id) on delete cascade,
  assessment_id   uuid references public.cad_assessments(id) on delete cascade,
  ecg_analysis_id uuid references public.ecg_analyses(id) on delete cascade,
  reviewed_by     uuid not null references public.profiles(id),
  reviewed_at     timestamptz not null default now(),
  outcome         text not null check (outcome in
                    ('no_action', 'follow_up_booked', 'patient_contacted', 'treatment_changed', 'escalated')),
  note            text,
  constraint finding_reviews_one_target check (num_nonnulls(assessment_id, ecg_analysis_id) = 1)
);

create index if not exists finding_reviews_assessment_idx on public.finding_reviews (assessment_id);
create index if not exists finding_reviews_ecg_idx on public.finding_reviews (ecg_analysis_id);
create index if not exists finding_reviews_patient_idx on public.finding_reviews (patient_id, reviewed_at desc);

alter table public.finding_reviews enable row level security;

drop policy if exists "finding_reviews: doctor with access reads" on public.finding_reviews;
create policy "finding_reviews: doctor with access reads"
  on public.finding_reviews for select
  using (exists (select 1 from public.doctor_patient_assignments dpa
                 where dpa.doctor_id = auth.uid() and dpa.patient_id = finding_reviews.patient_id
                   and dpa.is_active));

revoke insert, update, delete on public.finding_reviews from authenticated;
grant select on public.finding_reviews to authenticated;

create or replace function public.record_finding_review(
  p_assessment_id   uuid,
  p_ecg_analysis_id uuid,
  p_outcome         text,
  p_note            text default null
)
returns public.finding_reviews
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor   uuid := auth.uid();
  v_patient uuid;
  v_row     public.finding_reviews;
begin
  if v_actor is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;
  if num_nonnulls(p_assessment_id, p_ecg_analysis_id) <> 1 then
    raise exception 'Review exactly one finding.' using errcode = '22023';
  end if;

  if p_assessment_id is not null then
    select patient_id into v_patient from public.cad_assessments where id = p_assessment_id;
  else
    select patient_id into v_patient from public.ecg_analyses where id = p_ecg_analysis_id;
  end if;

  -- Same rule as the rest of MEDIS (v11): a doctor with active access.
  if v_patient is null or not exists (
    select 1 from public.doctor_patient_assignments dpa
      join public.profiles d on d.id = dpa.doctor_id
     where dpa.doctor_id = v_actor and dpa.patient_id = v_patient
       and dpa.is_active and d.role = 'doctor'
  ) then
    raise exception 'Not authorized to review findings for this patient.' using errcode = '42501';
  end if;

  insert into public.finding_reviews (patient_id, assessment_id, ecg_analysis_id, reviewed_by, outcome, note)
  values (v_patient, p_assessment_id, p_ecg_analysis_id, v_actor, p_outcome, nullif(trim(p_note), ''))
  returning * into v_row;

  -- Not in the patient's access-history allow-list, so the outcome stays doctor-only.
  insert into public.audit_logs (user_id, action, target_id, target_type, metadata)
  values (v_actor, 'reviewed_finding', v_patient, 'patient',
          jsonb_build_object('review_id', v_row.id, 'assessment_id', p_assessment_id,
                             'ecg_analysis_id', p_ecg_analysis_id, 'outcome', p_outcome));
  return v_row;
end;
$$;

revoke all on function public.record_finding_review(uuid, uuid, text, text) from public, anon;
grant execute on function public.record_finding_review(uuid, uuid, text, text) to authenticated;

commit;
