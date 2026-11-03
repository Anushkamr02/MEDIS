-- ============================================================
-- MIGRATION V3d — DIGITAL CONSULTATION FIELDS (MEDIS Phase C)
-- Run after v3c.
-- Adds: 'cad' as a valid disease_type, and the structured
--       consultation fields the doctor fills in during a visit.
--
-- Vitals are typed columns (not JSONB) on purpose: the
-- longitudinal trend analysis (Phase D) charts BP / HR / BMI
-- across visits, which is far simpler with real numeric columns.
-- Free-form sections stay JSONB so fields can be added later
-- without another migration.
-- ============================================================


-- ============================================================
-- STEP 1: ALLOW 'cad' AS A DISEASE TYPE
-- (v1 only allowed glaucoma / fabry / diabetes)
-- ============================================================
alter table public.consultations
  drop constraint if exists consultations_disease_type_check;
alter table public.consultations
  add constraint consultations_disease_type_check
  check (disease_type in ('glaucoma', 'fabry', 'diabetes', 'cad'));

alter table public.consultation_inputs
  drop constraint if exists consultation_inputs_disease_type_check;
alter table public.consultation_inputs
  add constraint consultation_inputs_disease_type_check
  check (disease_type in ('glaucoma', 'fabry', 'diabetes', 'cad'));


-- ============================================================
-- STEP 2: STRUCTURED CONSULTATION FIELDS
-- status 'pending' = draft, 'completed' = finalized by doctor
-- ============================================================
alter table public.consultations
  add column if not exists hospital_id           uuid references public.hospitals(id),
  -- 8.1 Patient complaints
  add column if not exists complaints            jsonb default '{}',
  -- 8.2 Clinical examination
  add column if not exists systolic_bp           int,
  add column if not exists diastolic_bp          int,
  add column if not exists heart_rate            int,
  add column if not exists respiratory_rate      int,
  add column if not exists spo2                  numeric(5,2),
  add column if not exists temperature_c         numeric(4,1),
  add column if not exists height_cm             numeric(5,1),
  add column if not exists weight_kg             numeric(5,1),
  add column if not exists bmi                   numeric(4,1),
  -- 8.4 Clinical observations
  add column if not exists observations          jsonb default '{}',
  -- 8.5 Diagnosis and assessment
  add column if not exists preliminary_diagnosis text,
  add column if not exists final_diagnosis       text,
  add column if not exists assessment            jsonb default '{}',
  add column if not exists follow_up_date        date,
  add column if not exists finalized_at          timestamptz;

comment on column public.consultations.complaints is
  'Example: {"main_complaint":"Chest discomfort on exertion","chest_pain":"yes","chest_pain_duration":"2 weeks",
   "pain_location":"Retrosternal","pain_severity":"6","breathlessness":true,"palpitations":false,
   "dizziness":false,"sweating":false,"fatigue":true,"other_symptoms":""}';

comment on column public.consultations.observations is
  'Keys: general, cardiovascular, respiratory, ecg, blood_report, physical, additional';

comment on column public.consultations.assessment is
  'Keys: clinical_assessment, suspected_conditions, cad_risk_assessment, supporting_findings, recommended_investigations';

create index if not exists idx_consultations_hospital on public.consultations(hospital_id);


-- ============================================================
-- DONE — V3d APPLIED
-- ============================================================
