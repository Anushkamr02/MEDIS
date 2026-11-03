-- =====================================================================
-- MEDIS migration v4: AI integration (teammate's medis engine)
-- Run after v3f. Safe to re-run.
--
--  1. Numeric lab columns on consultations. The longitudinal engine
--     (backend/medis/ai/trajectories.py METRICS) needs numbers in these
--     units; the free-text observations.blood_report stays as-is.
--  2. cad_assessments: saved longitudinal reports (+ optional PCE).
--  3. ecg_analyses: saved ECG analysis results.
--  OCR extraction is not stored: values go back to the doctor to verify
--  and are saved on the consultation (labs_source = 'extracted_verified').
-- =====================================================================

-- ---------- 1. Lab values (units match the engine's METRICS) ----------
alter table public.consultations
  add column if not exists total_cholesterol numeric(6,1),  -- mg/dL
  add column if not exists ldl_cholesterol   numeric(6,1),  -- mg/dL
  add column if not exists hdl_cholesterol   numeric(6,1),  -- mg/dL
  add column if not exists triglycerides     numeric(7,1),  -- mg/dL
  add column if not exists fasting_glucose   numeric(6,1),  -- mg/dL
  add column if not exists hba1c             numeric(4,1),  -- %
  add column if not exists serum_creatinine  numeric(5,2),  -- mg/dL
  add column if not exists egfr              numeric(5,1),  -- mL/min/1.73m2
  -- 'manual' | 'extracted_verified' (doctor applied values read from a report)
  add column if not exists labs_source       text;

-- ---------- 2. Longitudinal assessments ----------
create table if not exists public.cad_assessments (
  id               uuid primary key default gen_random_uuid(),
  patient_id       uuid not null references public.profiles(id) on delete cascade,
  consultation_id  uuid references public.consultations(id) on delete set null,
  requested_by     uuid not null references public.profiles(id),
  engine_version   text not null,
  as_of            date not null,
  review_priority  text not null,
  report           jsonb not null,
  pce              jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists cad_assessments_patient_idx
  on public.cad_assessments (patient_id, created_at desc);

alter table public.cad_assessments enable row level security;

drop policy if exists "cad_assessments: assigned doctor reads" on public.cad_assessments;
create policy "cad_assessments: assigned doctor reads"
  on public.cad_assessments for select
  using (
    exists (
      select 1 from public.doctor_patient_assignments dpa
      where dpa.doctor_id = auth.uid()
        and dpa.patient_id = cad_assessments.patient_id
        and dpa.is_active = true
    )
  );

drop policy if exists "cad_assessments: assigned doctor inserts" on public.cad_assessments;
create policy "cad_assessments: assigned doctor inserts"
  on public.cad_assessments for insert
  with check (
    requested_by = auth.uid()
    and exists (
      select 1 from public.doctor_patient_assignments dpa
      where dpa.doctor_id = auth.uid()
        and dpa.patient_id = cad_assessments.patient_id
        and dpa.is_active = true
    )
  );

-- ---------- 3. ECG analyses ----------
create table if not exists public.ecg_analyses (
  id               uuid primary key default gen_random_uuid(),
  patient_id       uuid not null references public.profiles(id) on delete cascade,
  consultation_id  uuid references public.consultations(id) on delete set null,
  document_id      uuid references public.medical_reports(id) on delete set null,
  requested_by     uuid not null references public.profiles(id),
  file_name        text,
  input_format     text,
  status           text not null,   -- validated_continuous_10s_analysis | digitization_complete_cnn_blocked | failed
  classification   jsonb,           -- null when blocked or failed
  result           jsonb not null,  -- full engine output minus raw lead samples
  created_at       timestamptz not null default now()
);
create index if not exists ecg_analyses_patient_idx
  on public.ecg_analyses (patient_id, created_at desc);

alter table public.ecg_analyses enable row level security;

drop policy if exists "ecg_analyses: assigned doctor reads" on public.ecg_analyses;
create policy "ecg_analyses: assigned doctor reads"
  on public.ecg_analyses for select
  using (
    exists (
      select 1 from public.doctor_patient_assignments dpa
      where dpa.doctor_id = auth.uid()
        and dpa.patient_id = ecg_analyses.patient_id
        and dpa.is_active = true
    )
  );

drop policy if exists "ecg_analyses: assigned doctor inserts" on public.ecg_analyses;
create policy "ecg_analyses: assigned doctor inserts"
  on public.ecg_analyses for insert
  with check (
    requested_by = auth.uid()
    and exists (
      select 1 from public.doctor_patient_assignments dpa
      where dpa.doctor_id = auth.uid()
        and dpa.patient_id = ecg_analyses.patient_id
        and dpa.is_active = true
    )
  );
