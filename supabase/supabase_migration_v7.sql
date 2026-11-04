-- Edit an existing prescription only while its owning consultation is a draft.
-- Run after v6 in the Supabase SQL editor. No general UPDATE policy is added.
begin;

create or replace function public.update_draft_prescription(
  p_prescription_id uuid,
  p_consultation_id uuid,
  p_medicines jsonb,
  p_instructions text default null
)
returns setof public.prescriptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  visit public.consultations%rowtype;
  medicine jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sign in to edit a prescription.' using errcode = '42501';
  end if;

  -- Finalizing a consultation takes the same row lock. An edit cannot race
  -- past finalization, even if another browser tab still displays the draft.
  select * into visit from public.consultations
    where id = p_consultation_id and doctor_id = auth.uid()
    for update;
  if not found then
    raise exception 'Only the consultation doctor can edit this prescription.' using errcode = '42501';
  end if;
  if visit.status <> 'pending' or visit.finalized_at is not null then
    raise exception 'This consultation has been finalized. Its prescriptions cannot be edited.' using errcode = '42501';
  end if;

  if jsonb_typeof(p_medicines) is distinct from 'array' then
    raise exception 'Provide a medicine list.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_medicines) = 0 then
    raise exception 'Add at least one medicine.' using errcode = '22023';
  end if;
  for medicine in select value from jsonb_array_elements(p_medicines) loop
    if jsonb_typeof(medicine) is distinct from 'object'
       or coalesce(btrim(medicine->>'name'), '') = ''
       or coalesce(btrim(medicine->>'dosage'), '') = ''
       or coalesce(btrim(medicine->>'frequency'), '') = ''
       or coalesce(medicine->>'duration_days', '') !~ '^[0-9]{1,3}$' then
      raise exception 'Each medicine needs a name, dosage, frequency and duration.' using errcode = '22023';
    end if;
    if (medicine->>'duration_days')::integer not between 1 and 365 then
      raise exception 'Medicine duration must be 1 to 365 days.' using errcode = '22023';
    end if;
  end loop;

  return query update public.prescriptions
    set medicines = p_medicines, instructions = nullif(btrim(p_instructions), '')
    where id = p_prescription_id
      and consultation_id = visit.id
      and patient_id = visit.patient_id
      and doctor_id = auth.uid()
    returning *;
  if not found then
    raise exception 'Prescription not found for this consultation.' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.update_draft_prescription(uuid, uuid, jsonb, text) from public;
revoke all on function public.update_draft_prescription(uuid, uuid, jsonb, text) from anon;
grant execute on function public.update_draft_prescription(uuid, uuid, jsonb, text) to authenticated;

commit;
