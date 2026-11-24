-- ============================================================
-- MEDIS GOVERNANCE CHECK (step 10)
-- Run in the Supabase SQL editor after v15 and demo_seed.sql.
-- It impersonates the demo accounts, raises an error on the first failed
-- check, and ROLLS BACK everything it wrote. Success = only "PASS" notices.
--
-- Checks (IMPROVEMENT_PLAN §3.5, §3.6):
--  1. a patient reads zero rows of AI/review tables, even their own;
--  2. a patient cannot read another patient's or a withdrawn summary;
--  3. publishing is blocked until a significant finding is reviewed;
--  4. escalation: 5 h without review -> overdue (level 1); a review stops it;
--  5. revoking access hides the review, queue, escalation and summary rows at once;
--  6. a non-doctor account cannot request (and so cannot be granted) access.
-- ============================================================
begin;

do $$
declare
  v_p1 uuid; v_p2 uuid; v_d1 uuid;
  v_assessment uuid;
  v_count integer;
  v_failed boolean;
begin
  select id into v_p1 from auth.users where email = 'patient1@demo.com';
  select id into v_p2 from auth.users where email = 'patient2@demo.com';
  select id into v_d1 from auth.users where email = 'doctor1@demo.com';
  if v_p1 is null or v_p2 is null or v_d1 is null then
    raise exception 'Run demo_seed.sql first: the demo accounts are missing.';
  end if;

  -- ---------- setup (as the SQL editor's owner role; all rolled back) ----------
  perform set_config('medis.access_rpc', 'on', true);  -- lets setup write assignments directly (v11 guard)
  insert into public.doctor_patient_assignments (doctor_id, patient_id, is_active, access_status)
  values (v_d1, v_p1, true, 'active')
  on conflict (doctor_id, patient_id) do update set is_active = true, access_status = 'active';
  -- Older checks must not count as the patient's latest one.
  update public.cad_assessments set created_at = created_at - interval '30 days' where patient_id = v_p1;
  insert into public.cad_assessments (patient_id, requested_by, engine_version, as_of, review_priority, report)
  values (v_p1, v_d1, 'governance-check', current_date, 'URGENT_REVIEW', '{"review_priority": "URGENT_REVIEW"}'::jsonb)
  returning id into v_assessment;
  insert into public.patient_health_summaries (patient_id, status_message, headline, published_by, withdrawn_at)
  values (v_p1, 'steady', 'Governance check: withdrawn summary', v_d1, now()),
         (v_p2, 'steady', 'Governance check: another patient', v_d1, null);

  -- ---------- 1 + 2. as patient1 ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_p1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select (select count(*) from public.cad_assessments) + (select count(*) from public.ecg_analyses)
       + (select count(*) from public.finding_reviews) + (select count(*) from public.monitoring_queue)
       + (select count(*) from public.escalation_events)
    into v_count;
  if v_count <> 0 then raise exception 'FAIL 1: patient read % AI/review rows', v_count; end if;
  raise notice 'PASS 1: patient reads 0 rows from cad_assessments, ecg_analyses, finding_reviews, monitoring_queue, escalation_events';

  select count(*) into v_count from public.patient_health_summaries
   where patient_id <> v_p1 or withdrawn_at is not null;
  if v_count <> 0 then raise exception 'FAIL 2: patient read % foreign or withdrawn summaries', v_count; end if;
  raise notice 'PASS 2: no other patient''s summary and no withdrawn summary is readable';
  execute 'reset role';

  -- ---------- 3 + 4. as doctor1 ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_d1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_failed := false;
  begin
    perform public.publish_health_summary(v_p1, v_assessment, 'steady', 'Governance check', '{}', null, '{}');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'FAIL 3: published without a review'; end if;
  raise notice 'PASS 3: publishing is blocked while the Critical finding has no review';
  execute 'reset role';

  select count(*) into v_count from public.escalation_events where assessment_id = v_assessment and level = 0;
  if v_count <> 1 then raise exception 'FAIL 4a: no immediate (level 0) escalation'; end if;
  update public.cad_assessments set created_at = now() - interval '5 hours' where id = v_assessment;
  perform public.medis_escalate_urgent();
  select count(*) into v_count from public.escalation_events where assessment_id = v_assessment and level = 1;
  if v_count <> 1 then raise exception 'FAIL 4b: not overdue after 5 h'; end if;
  select count(*) into v_count from public.audit_logs
   where action = 'escalated_urgent_finding' and metadata ->> 'assessment_id' = v_assessment::text;
  if v_count <> 2 then raise exception 'FAIL 4c: expected 2 escalation audit rows, found %', v_count; end if;

  execute 'set local role authenticated';
  perform public.record_finding_review(v_assessment, null, 'patient_contacted', 'Governance check');
  perform public.publish_health_summary(v_p1, v_assessment, 'steady', 'Governance check', '{}', null, '{}');
  execute 'reset role';
  update public.cad_assessments set created_at = now() - interval '25 hours' where id = v_assessment;
  perform public.medis_escalate_urgent();
  select count(*) into v_count from public.escalation_events where assessment_id = v_assessment and level = 2;
  if v_count <> 0 then raise exception 'FAIL 4d: escalated after a review'; end if;
  raise notice 'PASS 3+4: immediate step, overdue after 5 h, audited; review allows publishing and stops escalation';

  -- ---------- 5. revoke doctor1, then read as doctor1 ----------
  update public.doctor_patient_assignments set is_active = false, access_status = 'revoked'
   where doctor_id = v_d1 and patient_id = v_p1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_d1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select (select count(*) from public.finding_reviews where patient_id = v_p1)
       + (select count(*) from public.monitoring_queue where patient_id = v_p1)
       + (select count(*) from public.escalation_events where patient_id = v_p1)
       + (select count(*) from public.patient_health_summaries where patient_id = v_p1)
       + (select count(*) from public.cad_assessments where patient_id = v_p1)
       + (select count(*) from public.ecg_analyses where patient_id = v_p1)
    into v_count;
  if v_count <> 0 then raise exception 'FAIL 5: revoked doctor still reads % rows', v_count; end if;
  raise notice 'PASS 5: revoked access hides reviews, queue, escalations, summaries, assessments and ECGs at once';
  execute 'reset role';

  -- ---------- 6. a patient account asks for access ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_p2, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_failed := false;
  begin
    perform public.request_patient_access(v_p1, 'Governance check');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'FAIL 6: a non-doctor could request access'; end if;
  raise notice 'PASS 6: a non-doctor (family, caregiver, other patient) cannot be granted access';
  execute 'reset role';
end;
$$;

rollback;
