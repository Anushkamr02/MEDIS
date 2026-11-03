-- ============================================================
-- MIGRATION V3e — DOCTOR REGISTRATION WITH HOSPITAL
-- Run after v3d.
--
-- Problem: the register page needs the hospital list *before* the
-- user has an account (v3 only lets authenticated users read it), and
-- with email confirmation on there's no session right after signUp,
-- so the browser can't insert doctor_profiles itself.
--
-- Fix: let anonymous visitors read hospital names (not sensitive),
-- and have the signup trigger create doctor_profiles from the
-- metadata passed to supabase.auth.signUp().
-- ============================================================


-- STEP 1: hospital list readable on the register page
drop policy if exists "hospitals: anon read for registration" on public.hospitals;
create policy "hospitals: anon read for registration"
  on public.hospitals for select
  to anon
  using (true);


-- STEP 2: qualification shown on prescriptions (e.g. "MBBS, MD")
alter table public.doctor_profiles
  add column if not exists qualification text;


-- STEP 3: signup trigger also creates doctor_profiles for doctors
-- Metadata keys read: full_name, role, hospital_id, specialization, qualification
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_role text := coalesce(new.raw_user_meta_data->>'role', 'patient');
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    v_role
  );

  if v_role = 'doctor' then
    insert into public.doctor_profiles (id, hospital_id, specialization, qualification)
    values (
      new.id,
      -- Looked up rather than cast, so a bad/unknown id can't break signup
      (select h.id from public.hospitals h
        where h.id::text = new.raw_user_meta_data->>'hospital_id'),
      nullif(new.raw_user_meta_data->>'specialization', ''),
      nullif(new.raw_user_meta_data->>'qualification', '')
    )
    on conflict (id) do nothing;
  end if;

  return new;
end;
$$;


-- ============================================================
-- DONE — V3e APPLIED
-- ============================================================
