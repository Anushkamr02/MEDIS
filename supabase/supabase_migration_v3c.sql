-- ============================================================
-- MIGRATION V3c — FIX search_patient_by_display_id
-- Run after v3 / v3b.
--
-- The v3 version fails on every call with:
--   column reference "id" is ambiguous
-- because its RETURNS TABLE column names clash with unqualified
-- column references inside the body. This recreates it with every
-- column qualified and returns a fixed shape the frontend relies on:
--   (patient_id uuid, display_id text, full_name text)
-- ============================================================

drop function if exists public.search_patient_by_display_id(text);

create function public.search_patient_by_display_id(p_display_id text)
returns table (patient_id uuid, display_id text, full_name text)
language plpgsql
security definer set search_path = public
as $$
begin
  -- Only doctors may search, and only by exact ID — no browsing.
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'doctor'
  ) then
    raise exception 'Only doctors can search for patients';
  end if;

  insert into public.audit_logs (user_id, action, target_type, metadata)
  values (auth.uid(), 'searched_patient', 'patient', jsonb_build_object('query', p_display_id));

  -- Returns identity only (name + ID), never the medical record.
  return query
    select p.id, p.display_id::text, p.full_name
    from public.profiles p
    where p.role = 'patient'
      and upper(p.display_id) = upper(trim(p_display_id));
end;
$$;

revoke all on function public.search_patient_by_display_id(text) from public, anon;
grant execute on function public.search_patient_by_display_id(text) to authenticated;
