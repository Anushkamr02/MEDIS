-- =====================================================================
-- MEDIS migration v5: doctor AI summary + patient chatbot
-- Run after v4. Safe to re-run.
--
--  1. cad_assessments gets the LLM-written summary of that assessment.
--  2. chat_messages: the patient's "Ask MEDIS" conversation, private to
--     the patient (the AI service writes with the patient's own token).
-- =====================================================================

-- ---------- 1. AI summary on an assessment ----------
alter table public.cad_assessments
  add column if not exists ai_summary         jsonb,   -- {overview, changes[], review_points[], data_gaps[], unverified_numbers[]}
  add column if not exists summary_model      text,
  add column if not exists summary_created_at timestamptz;

drop policy if exists "cad_assessments: assigned doctor updates" on public.cad_assessments;
create policy "cad_assessments: assigned doctor updates"
  on public.cad_assessments for update
  using (
    exists (
      select 1 from public.doctor_patient_assignments dpa
      where dpa.doctor_id = auth.uid()
        and dpa.patient_id = cad_assessments.patient_id
        and dpa.is_active = true
    )
  );

-- ---------- 2. Patient chatbot history ----------
create table if not exists public.chat_messages (
  id            uuid primary key default gen_random_uuid(),
  patient_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  role          text not null check (role in ('user', 'assistant')),
  content       text not null,
  sources       jsonb not null default '[]',
  is_emergency  boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists chat_messages_patient_idx
  on public.chat_messages (patient_id, created_at);

alter table public.chat_messages enable row level security;

drop policy if exists "chat_messages: patient reads own" on public.chat_messages;
create policy "chat_messages: patient reads own"
  on public.chat_messages for select
  using (patient_id = auth.uid());

drop policy if exists "chat_messages: patient inserts own" on public.chat_messages;
create policy "chat_messages: patient inserts own"
  on public.chat_messages for insert
  with check (patient_id = auth.uid());

drop policy if exists "chat_messages: patient clears own" on public.chat_messages;
create policy "chat_messages: patient clears own"
  on public.chat_messages for delete
  using (patient_id = auth.uid());
