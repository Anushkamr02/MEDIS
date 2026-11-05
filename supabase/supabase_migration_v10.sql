-- Run after v9 in the Supabase SQL editor. Safe to re-run.
-- Delete only the signed-in doctor's unfinished consultation.
begin;

create or replace function public.delete_own_draft(p_consultation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  visit public.consultations%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in to delete a draft.' using errcode = '42501';
  end if;

  -- Serialize against finalization and prescription edits in other tabs.
  select * into visit from public.consultations
    where id = p_consultation_id and doctor_id = auth.uid()
    for update;
  if not found then
    raise exception 'Only the consultation doctor can delete this draft.' using errcode = '42501';
  end if;
  if visit.status is distinct from 'pending' or visit.finalized_at is not null then
    raise exception 'Finalized consultations cannot be deleted.' using errcode = '42501';
  end if;

  -- Existing foreign keys cascade visit prescriptions/inputs/predictions,
  -- and preserve uploaded reports and analyses by clearing their visit link.
  delete from public.consultations where id = visit.id;
  return visit.id;
end;
$$;

revoke all on function public.delete_own_draft(uuid) from public, anon;
grant execute on function public.delete_own_draft(uuid) to authenticated;

commit;
