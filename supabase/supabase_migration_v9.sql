-- ============================================================
-- MIGRATION V9 — LOG IN WITH A MEDIS ID
-- Run after v8 in the Supabase SQL editor. Safe to re-run.
--
-- resolve_login_email() turns a MEDIS ID (MEDIS-P-… / MEDIS-D-…)
-- into the account's email so the login page can then sign in with
-- Supabase Auth as usual. The email is returned only when the
-- password also matches, so the function cannot be used to look up
-- someone's email from their ID.
-- ============================================================

create or replace function public.resolve_login_email(p_medis_id text, p_password text)
returns text
language sql
stable
security definer set search_path = public, extensions
as $$
  select u.email::text
  from public.profiles p
  join auth.users u on u.id = p.id
  where upper(p.display_id::text) = upper(trim(p_medis_id))
    and u.encrypted_password = extensions.crypt(p_password, u.encrypted_password)
  limit 1;
$$;

revoke all on function public.resolve_login_email(text, text) from public;
grant execute on function public.resolve_login_email(text, text) to anon, authenticated;
