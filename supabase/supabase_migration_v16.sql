-- ============================================================
-- MIGRATION V16 — ASK MEDIS FEEDBACK
-- Run after v15 in the Supabase SQL editor. Safe to re-run.
--
-- A patient can mark one of the assistant's replies as helpful or not
-- helpful. chat_messages deliberately has no UPDATE policy (v5), so the
-- rating is written only by rate_chat_message(), which checks that the
-- row belongs to the signed-in patient and is an assistant reply. The
-- feedback stays with the patient's own conversation: it is not part of
-- the doctor-only clinical record and no notification is sent.
-- ============================================================
begin;

alter table public.chat_messages
  add column if not exists feedback    text,
  add column if not exists feedback_at timestamptz;

do $$
begin
  alter table public.chat_messages
    add constraint chat_messages_feedback_check check (feedback in ('up', 'down'));
exception
  when duplicate_object then null;
end $$;

-- Rate (or clear the rating of) one of your own assistant replies.
create or replace function public.rate_chat_message(
  p_message_id uuid,
  p_feedback   text
)
returns public.chat_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_row   public.chat_messages;
begin
  if v_actor is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;
  if p_feedback is not null and p_feedback not in ('up', 'down') then
    raise exception 'Feedback must be up, down or empty.' using errcode = '22023';
  end if;

  update public.chat_messages
     set feedback = p_feedback,
         feedback_at = case when p_feedback is null then null else now() end
   where id = p_message_id
     and patient_id = v_actor
     and role = 'assistant'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Only your own Ask MEDIS replies can be rated.' using errcode = '42501';
  end if;
  return v_row;
end;
$$;

revoke all on function public.rate_chat_message(uuid, text) from public, anon;
grant execute on function public.rate_chat_message(uuid, text) to authenticated;

commit;
