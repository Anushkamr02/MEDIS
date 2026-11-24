-- ============================================================
-- MEDIS EXTENDED DEMO DATA
-- Run AFTER the migrations (v1 … v11, and v12–v15 if you use them) and
-- AFTER demo_seed.sql. Paste the whole file into the Supabase SQL editor.
--
-- Adds 3 doctors and 6 patients (password  Demo@1234 , email confirmed),
-- linked to the demo_seed.sql doctors:
--
--   doctor3@demo.com  Dr. Kavya Reddy    Endocrinology      Fortis Hospital
--   doctor4@demo.com  Dr. Sameer Khan    General Medicine   Narayana Health
--   doctor5@demo.com  Dr. Lakshmi Iyer   Nephrology         Apollo Hospital
--   (doctor1 Dr. Priya Mehta and doctor2 Dr. Arjun Rao come from demo_seed.sql)
--
--   patient3  Meera Iyer     type 2 diabetes improving on treatment (4 visits, 2 hospitals)
--   patient4  Arvind Kumar   kidney function falling, BP rising   (4 visits, latest NOT shared)
--   patient5  Fatima Sheikh  well-controlled hypertension, stable (3 visits)
--   patient6  Rohan Das      first visit only; booked his own follow-up
--   patient7  Suresh Patil   critical: chest pain at rest + BP 188/122 two days ago,
--                            seen under emergency access; open draft follow-up
--   patient8  Divya Menon    every access state: active, pending, declined, revoked
--
-- It also fills Rahul Sharma's (patient1) numeric lab values where they are
-- empty, so his LDL / HbA1c trends work (PART 4). Nothing else of
-- demo_seed.sql's accounts is changed, so governance_check.sql still applies.
--
-- RE-RUNNABLE: it first deletes the clinical data of patient3–patient8 only.
-- Dates are fixed in 2026 except appointments and Suresh's emergency visit,
-- which are relative to now() so "today", "upcoming" and "recent" stay true.
-- After loading, open each patient as a doctor and press "Run AI check":
-- assessments are produced by the engine, not inserted here. Expected results
-- (checked by replaying this data through backend/adapters.py + assess_timeline):
--
--   Rahul Sharma   Needs review      LDL 95→155, BP 120→150, HbA1c 5.5→6.8
--   Meera Iyer     Needs review      improving (HbA1c 8.6→7.1, LDL 126→98) but HbA1c and
--                                    glucose are still above target, which the engine flags
--   Arvind Kumar   Needs review      eGFR 72→46 falling, creatinine rising, BP above target
--   Fatima Sheikh  No concern found  every value in range and steady
--   Rohan Das      Not enough data   one visit
--   Suresh Patil   Critical          BP 188/122 and chest pain at rest within the last 7 days
--                                    (stays Critical for a week after loading; re-run to refresh)
--   Divya Menon    Not enough data   one visit
--
-- Logins: password Demo@1234. Divya's record shows all four access states;
-- log in as patient8@demo.com to approve Dr. Reddy's pending request.
-- ============================================================


-- ============================================================
-- PART 1: LOGIN ACCOUNTS (same method as demo_seed.sql)
-- ============================================================
do $$
declare
  r record;
  v_uid uuid;
begin
  for r in
    select * from (values
      ('doctor3@demo.com',  'Kavya Reddy',   'doctor'),
      ('doctor4@demo.com',  'Sameer Khan',   'doctor'),
      ('doctor5@demo.com',  'Lakshmi Iyer',  'doctor'),
      ('patient3@demo.com', 'Meera Iyer',    'patient'),
      ('patient4@demo.com', 'Arvind Kumar',  'patient'),
      ('patient5@demo.com', 'Fatima Sheikh', 'patient'),
      ('patient6@demo.com', 'Rohan Das',     'patient'),
      ('patient7@demo.com', 'Suresh Patil',  'patient'),
      ('patient8@demo.com', 'Divya Menon',   'patient')
    ) as t(email, full_name, role)
  loop
    if exists (select 1 from auth.users where email = r.email) then
      continue;
    end if;
    v_uid := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new
    ) values (
      '00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated',
      r.email, extensions.crypt('Demo@1234', extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}',
      jsonb_build_object('full_name', r.full_name, 'role', r.role),
      now(), now(), '', '', '', ''
    );
    insert into auth.identities (
      id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), v_uid, v_uid::text, 'email',
      jsonb_build_object('sub', v_uid::text, 'email', r.email, 'email_verified', true),
      now(), now(), now()
    );
    raise notice 'Created demo account %', r.email;
  end loop;
end $$;


-- ============================================================
-- PART 2: PEOPLE, HOSPITALS, BACKGROUND HISTORY
-- ============================================================
do $$
declare
  v_missing text;
begin
  select string_agg(e, ', ') into v_missing
  from unnest(array['doctor1@demo.com','doctor2@demo.com','doctor3@demo.com','doctor4@demo.com','doctor5@demo.com',
                    'patient3@demo.com','patient4@demo.com','patient5@demo.com','patient6@demo.com',
                    'patient7@demo.com','patient8@demo.com']) e
  where not exists (select 1 from auth.users u where u.email = e);
  if v_missing is not null then
    raise exception 'Missing accounts: %. Run demo_seed.sql first (doctor1/doctor2), then this file.', v_missing;
  end if;

  -- ---------- clean previous run (new demo patients only) ----------
  delete from public.appointments               where patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com');
  delete from public.consultations              where patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com');
  delete from public.prescriptions              where patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com');
  delete from public.patient_medical_history    where patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com');
  delete from public.family_history             where patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com');
  delete from public.current_medications        where patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com');
  delete from public.notifications              where user_id    in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com');
  delete from public.doctor_patient_assignments where patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com');
  delete from public.audit_logs                 where target_id  in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com');
  -- Rows created later by the app (AI checks, reviews, published summaries)
  -- reference assessments, so they go first. Each table exists only from its migration on.
  if to_regclass('public.finding_reviews') is not null then
    delete from public.finding_reviews where patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com');
  end if;
  if to_regclass('public.escalation_events') is not null then
    delete from public.escalation_events where patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com');
  end if;
  if to_regclass('public.patient_health_summaries') is not null then
    delete from public.patient_health_summaries where patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com');
  end if;
  if to_regclass('public.ecg_analyses') is not null then
    delete from public.ecg_analyses where patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com');
  end if;
  if to_regclass('public.chat_messages') is not null then
    delete from public.chat_messages where patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com');
  end if;
  if to_regclass('public.cad_assessments') is not null then
    delete from public.cad_assessments where patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com');
  end if;
  if to_regclass('public.monitoring_queue') is not null then
    delete from public.monitoring_queue where patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com');
  end if;

  -- ---------- hospitals ----------
  insert into public.hospitals (name, address, city)
  select h.name, h.address, 'Bengaluru'
  from (values ('Apollo Hospital',  'Bannerghatta Road'),
               ('Manipal Hospital', 'HAL Airport Road'),
               ('Fortis Hospital',  'Bannerghatta Road'),
               ('Narayana Health',  'Bommasandra Industrial Area')) as h(name, address)
  where not exists (select 1 from public.hospitals x where x.name = h.name);

  -- ---------- doctors ----------
  update public.profiles p set
    role = 'doctor', full_name = d.full_name, gender = d.gender, phone = d.phone,
    display_id = case when p.display_id like 'MEDIS-D-%' then p.display_id else public.generate_display_id('D', 4) end
  from (values ('doctor3@demo.com', 'Kavya Reddy',  'female', '+91 98450 22110'),
               ('doctor4@demo.com', 'Sameer Khan',  'male',   '+91 98860 33221'),
               ('doctor5@demo.com', 'Lakshmi Iyer', 'female', '+91 99000 44332')) as d(email, full_name, gender, phone)
  join auth.users u on u.email = d.email
  where p.id = u.id;

  delete from public.patient_profiles where id in (select id from auth.users where email in ('doctor3@demo.com','doctor4@demo.com','doctor5@demo.com'));

  insert into public.doctor_profiles (id, specialization, qualification, license_number, hospital_id, hospital_name, years_of_experience)
  select u.id, d.spec, d.qual, d.lic, h.id, h.name, d.yrs
  from (values ('doctor3@demo.com', 'Endocrinology',    'MBBS, MD, DM (Endocrinology)', 'KMC-2014-47210', 'Fortis Hospital', 10),
               ('doctor4@demo.com', 'General Medicine', 'MBBS, MD',                     'KMC-2018-55621', 'Narayana Health',  6),
               ('doctor5@demo.com', 'Nephrology',       'MBBS, MD, DM (Nephrology)',    'KMC-2010-40983', 'Apollo Hospital', 15)) as d(email, spec, qual, lic, hosp, yrs)
  join auth.users u on u.email = d.email
  join lateral (select id, name from public.hospitals where name = d.hosp order by created_at limit 1) h on true
  on conflict (id) do update set
    specialization = excluded.specialization, qualification = excluded.qualification,
    license_number = excluded.license_number, hospital_id = excluded.hospital_id,
    hospital_name = excluded.hospital_name, years_of_experience = excluded.years_of_experience;

  -- ---------- patients ----------
  update public.profiles p set
    role = 'patient', full_name = x.full_name, gender = x.gender, date_of_birth = x.dob::date, phone = x.phone,
    display_id = case when p.display_id like 'MEDIS-P-%' then p.display_id else public.generate_display_id('P', 5) end
  from (values ('patient3@demo.com', 'Meera Iyer',    'female', '1970-03-11', '+91 98451 10001'),
               ('patient4@demo.com', 'Arvind Kumar',  'male',   '1963-07-22', '+91 98451 10002'),
               ('patient5@demo.com', 'Fatima Sheikh', 'female', '1981-12-05', '+91 98451 10003'),
               ('patient6@demo.com', 'Rohan Das',     'male',   '1992-05-30', '+91 98451 10004'),
               ('patient7@demo.com', 'Suresh Patil',  'male',   '1959-01-18', '+91 98451 10005'),
               ('patient8@demo.com', 'Divya Menon',   'female', '1997-08-09', '+91 98451 10006')) as x(email, full_name, gender, dob, phone)
  join auth.users u on u.email = x.email
  where p.id = u.id;

  delete from public.doctor_profiles where id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com');

  insert into public.patient_profiles (id, blood_group, height_cm, weight_kg, allergies, emergency_contact,
                                       smoking_status, alcohol_use, known_conditions)
  select u.id, x.bg, x.ht, x.wt, x.allergies, x.contact, x.smoke, x.alcohol, x.conds::jsonb
  from (values
    ('patient3@demo.com', 'A+',  158, 70, 'Sulfa drugs', 'Raghav Iyer (husband) +91 98451 20001', 'never',   'never',
     '{"diabetes": "type 2", "hypertension": true, "family_cardiac_history": false, "chest_pain_history": false}'),
    ('patient4@demo.com', 'O+',  170, 76, null,          'Sunita Kumar (wife) +91 98451 20002',   'former',  'occasional',
     '{"diabetes": "prediabetes", "hypertension": true, "kidney_disease": true, "family_cardiac_history": true}'),
    ('patient5@demo.com', 'B+',  162, 63, 'Dust',        'Imran Sheikh (husband) +91 98451 20003', 'never',  'never',
     '{"diabetes": false, "hypertension": true, "family_cardiac_history": false}'),
    ('patient6@demo.com', 'AB+', 178, 74, null,          'Anita Das (mother) +91 98451 20004',    'current', 'regular',
     '{"diabetes": false, "hypertension": false}'),
    ('patient7@demo.com', 'B-',  168, 81, 'Aspirin (gastritis)', 'Vinod Patil (son) +91 98451 20005', 'current', 'occasional',
     '{"diabetes": "type 2", "hypertension": true, "chest_pain_history": true, "family_cardiac_history": true, "previous_cardiac_events": false}'),
    ('patient8@demo.com', 'O-',  158, 52, null,          'Ravi Menon (father) +91 98451 20006',   'never',   'never',
     '{"diabetes": false, "hypertension": false}')
  ) as x(email, bg, ht, wt, allergies, contact, smoke, alcohol, conds)
  join auth.users u on u.email = x.email
  on conflict (id) do update set
    blood_group = excluded.blood_group, height_cm = excluded.height_cm, weight_kg = excluded.weight_kg,
    allergies = excluded.allergies, emergency_contact = excluded.emergency_contact,
    smoking_status = excluded.smoking_status, alcohol_use = excluded.alcohol_use,
    known_conditions = excluded.known_conditions;

  insert into public.patient_medical_history (patient_id, condition_name, diagnosed_at, is_active, notes)
  select u.id, x.cond, x.at::date, x.active, x.notes
  from (values
    ('patient3@demo.com', 'Type 2 diabetes mellitus',          '2025-11-20', true,  'HbA1c 8.9% at diagnosis'),
    ('patient3@demo.com', 'Essential hypertension',            '2026-02-02', true,  null),
    ('patient4@demo.com', 'Essential hypertension',            '2018-04-01', true,  'On treatment since 2018'),
    ('patient4@demo.com', 'Chronic kidney disease, stage 3',   '2026-04-28', true,  'eGFR 63 and falling'),
    ('patient4@demo.com', 'Renal calculus',                    '2015-09-10', false, 'Passed spontaneously'),
    ('patient5@demo.com', 'Essential hypertension',            '2024-06-15', true,  'Well controlled on amlodipine'),
    ('patient6@demo.com', 'Gastro-oesophageal reflux disease', '2026-11-12', true,  null),
    ('patient7@demo.com', 'Type 2 diabetes mellitus',          '2019-03-01', true,  null),
    ('patient7@demo.com', 'Essential hypertension',            '2016-07-01', true,  null),
    ('patient7@demo.com', 'Dyslipidemia',                      '2026-05-06', true,  'LDL 142 mg/dL'),
    ('patient8@demo.com', 'Migraine without aura',             '2023-02-11', true,  'Triggered by poor sleep')
  ) as x(email, cond, at, active, notes)
  join auth.users u on u.email = x.email;

  insert into public.family_history (patient_id, relation, condition_name, notes)
  select u.id, x.rel, x.cond, x.notes
  from (values
    ('patient3@demo.com', 'parent',  'Type 2 diabetes',          'Mother'),
    ('patient3@demo.com', 'sibling', 'Hypertension',             'Younger sister'),
    ('patient4@demo.com', 'parent',  'Chronic kidney disease',   'Father, on dialysis at 70'),
    ('patient4@demo.com', 'parent',  'Coronary artery disease',  'Mother, angioplasty at 66'),
    ('patient5@demo.com', 'parent',  'Hypertension',             'Both parents'),
    ('patient7@demo.com', 'sibling', 'Myocardial infarction',    'Elder brother at 55'),
    ('patient7@demo.com', 'parent',  'Stroke',                   'Father at 70'),
    ('patient8@demo.com', 'parent',  'Migraine',                 'Mother')
  ) as x(email, rel, cond, notes)
  join auth.users u on u.email = x.email;

  insert into public.current_medications (patient_id, medicine_name, condition_name, dosage, frequency, started_at, is_active)
  select u.id, x.med, x.cond, x.dose, x.freq, x.started::date, x.active
  from (values
    ('patient3@demo.com', 'Metformin',     'Type 2 diabetes',        '1000 mg', 'Twice daily',         '2026-06-15', true),
    ('patient3@demo.com', 'Telmisartan',   'Hypertension',           '40 mg',   'Once daily',          '2026-06-15', true),
    ('patient3@demo.com', 'Atorvastatin',  'Dyslipidemia',           '10 mg',   'Once daily at night', '2026-08-20', true),
    ('patient3@demo.com', 'Metformin',     'Type 2 diabetes',        '500 mg',  'Twice daily',         '2026-02-02', false),
    ('patient4@demo.com', 'Telmisartan',   'Hypertension / CKD',     '80 mg',   'Once daily',          '2026-07-30', true),
    ('patient4@demo.com', 'Amlodipine',    'Hypertension',           '5 mg',    'Once daily',          '2026-07-30', true),
    ('patient5@demo.com', 'Amlodipine',    'Hypertension',           '5 mg',    'Once daily',          '2024-06-15', true),
    ('patient6@demo.com', 'Pantoprazole',  'Acid reflux',            '40 mg',   'Before breakfast',    '2026-11-12', true),
    ('patient7@demo.com', 'Metformin',     'Type 2 diabetes',        '500 mg',  'Twice daily',         '2019-03-01', true),
    ('patient7@demo.com', 'Losartan',      'Hypertension',           '50 mg',   'Once daily',          '2026-08-19', true),
    ('patient7@demo.com', 'Rosuvastatin',  'Dyslipidemia',           '10 mg',   'Once daily at night', '2026-08-19', true),
    ('patient8@demo.com', 'Naproxen',      'Migraine attacks',       '500 mg',  'As needed',           '2026-09-25', true)
  ) as x(email, med, cond, dose, freq, started, active)
  join auth.users u on u.email = x.email;
end $$;


-- ============================================================
-- PART 3: VISITS, PRESCRIPTIONS, ACCESS, APPOINTMENTS, NOTIFICATIONS
-- Visits are inserted one at a time so each gets its MEDIS-V ID and
-- doctor link from the existing triggers; v_visits maps a short key to
-- the new consultation id for the prescriptions and appointments below.
-- ============================================================
do $$
declare
  r        record;
  v_id     uuid;
  v_visits jsonb := '{}'::jsonb;
  v_at     timestamptz;
begin
  for r in
    select * from (values
      -- key, patient, doctor, hospital, when (fixed date, or '-N days' from now), status, shared,
      -- complaint, chest_pain, severity, at_rest, breathless, nyha, palpitations,
      -- sbp, dbp, hr, spo2, weight, height,
      -- total chol, ldl, hdl, trig, fasting glucose, hba1c, creatinine, egfr,
      -- ecg, preliminary dx, final dx, follow-up date, note to patient

      -- Meera Iyer: diabetes improving (Dr. Reddy at Fortis, one cardiac screen with Dr. Mehta)
      ('m1', 'patient3@demo.com', 'doctor3@demo.com', 'Fortis Hospital', '2026-02-02 10:00+05:30', 'completed', true,
       'Tiredness, frequent urination', 'no', null, null, false, null, false,
       142, 90, 84, 98, 74, 158,  205, 126, 42, 190, 181, 8.6, 0.8, 88,
       'Normal sinus rhythm', 'Uncontrolled type 2 diabetes', 'Type 2 diabetes, poorly controlled; stage 1 hypertension', '2026-05-02',
       'Your sugar is high. Start metformin, walk 30 minutes daily and cut down sweets and rice portions.'),
      ('m2', 'patient3@demo.com', 'doctor3@demo.com', 'Fortis Hospital', '2026-06-15 11:30+05:30', 'completed', true,
       'Diabetes review', 'no', null, null, false, null, false,
       136, 86, 80, 98, 72, 158,  196, 118, 44, 172, 158, 7.9, 0.8, 87,
       null, 'Type 2 diabetes, improving', 'Type 2 diabetes, improving control; hypertension', '2026-09-15',
       'Good progress. Metformin increased to 1000 mg twice daily and a BP tablet added.'),
      ('m3', 'patient3@demo.com', 'doctor1@demo.com', 'Apollo Hospital', '2026-08-20 09:30+05:30', 'completed', true,
       'Cardiac risk screening (referred by endocrinologist)', 'no', null, null, false, null, false,
       130, 84, 78, 99, 71, 158,  180, 104, 46, 150, 140, 7.4, 0.8, 86,
       'Normal sinus rhythm, no ST-T changes', 'Diabetes with cardiovascular risk', 'No evidence of coronary disease; statin started for diabetes', '2027-02-20',
       'Your heart tests are normal. A small dose of atorvastatin is added to protect your heart.'),
      ('m4', 'patient3@demo.com', 'doctor3@demo.com', 'Fortis Hospital', '2026-10-20 10:15+05:30', 'completed', true,
       'Diabetes review', 'no', null, null, false, null, false,
       128, 78, 76, 99, 70, 158,  172, 98, 47, 140, 132, 7.1, 0.8, 86,
       null, 'Type 2 diabetes, improving', 'Type 2 diabetes, near target; hypertension controlled', '2027-01-20',
       'Very good progress. Continue the same medicines. Repeat HbA1c in 3 months.'),

      -- Arvind Kumar: kidney function falling (Dr. Rao, then nephrology with Dr. Iyer)
      ('a1', 'patient4@demo.com', 'doctor2@demo.com', 'Manipal Hospital', '2026-01-20 16:00+05:30', 'completed', true,
       'Ankle swelling in the evenings', 'no', null, null, false, null, false,
       148, 92, 78, 97, 77, 170,  198, 118, 44, 160, 104, 6.0, 1.10, 72,
       'Left ventricular hypertrophy by voltage', 'Hypertension with possible kidney involvement', 'Hypertension; mildly reduced kidney function', '2026-04-20',
       'Your BP is high and your kidney test is slightly low. Reduce salt and see a kidney specialist.'),
      ('a2', 'patient4@demo.com', 'doctor5@demo.com', 'Apollo Hospital', '2026-04-28 10:30+05:30', 'completed', true,
       'Nephrology referral: falling eGFR', 'no', null, null, false, null, false,
       146, 90, 76, 98, 77, 170,  196, 115, 44, 155, 106, 6.0, 1.25, 63,
       null, 'Chronic kidney disease', 'Chronic kidney disease stage 3a, hypertensive', '2026-07-28',
       'Your kidneys are working at about 63%. Telmisartan protects the kidneys; please take it daily.'),
      ('a3', 'patient4@demo.com', 'doctor5@demo.com', 'Apollo Hospital', '2026-07-30 11:00+05:30', 'completed', true,
       'Kidney follow-up', 'no', null, null, true, 'II', false,
       150, 94, 80, 97, 78, 170,  201, 120, 43, 162, 108, 6.1, 1.40, 55,
       null, 'Chronic kidney disease, progressing', 'Chronic kidney disease stage 3a, progressing; uncontrolled BP', '2026-10-30',
       'Kidney function has dropped further. Telmisartan increased and amlodipine added. Avoid painkillers like ibuprofen.'),
      ('a4', 'patient4@demo.com', 'doctor5@demo.com', 'Apollo Hospital', '2026-11-10 10:00+05:30', 'completed', false,
       'Kidney follow-up, more breathless on stairs', 'no', null, null, true, 'II', false,
       154, 96, 82, 96, 79, 170,  205, 124, 42, 168, 110, 6.1, 1.65, 46,
       'Left ventricular hypertrophy', 'Chronic kidney disease stage 3b', 'Chronic kidney disease stage 3b; resistant hypertension', '2026-12-10',
       'Results to be discussed at your next visit.'),

      -- Fatima Sheikh: stable, well-controlled hypertension (all with Dr. Rao)
      ('f1', 'patient5@demo.com', 'doctor2@demo.com', 'Manipal Hospital', '2026-02-14 12:00+05:30', 'completed', true,
       'Routine BP review', 'no', null, null, false, null, false,
       124, 78, 72, 99, 63, 162,  172, 96, 52, 120, 92, 5.4, 0.8, 98,
       'Normal', 'Hypertension, controlled', 'Essential hypertension, well controlled', '2026-06-14',
       'Your BP is well controlled. Continue amlodipine.'),
      ('f2', 'patient5@demo.com', 'doctor2@demo.com', 'Manipal Hospital', '2026-06-10 12:30+05:30', 'completed', true,
       'Routine BP review', 'no', null, null, false, null, false,
       122, 76, 70, 99, 63, 162,  170, 94, 53, 118, 90, 5.4, 0.8, 97,
       null, 'Hypertension, controlled', 'Essential hypertension, well controlled', '2026-10-10',
       'Everything is in range. Keep up the walking.'),
      ('f3', 'patient5@demo.com', 'doctor2@demo.com', 'Manipal Hospital', '2026-10-05 11:45+05:30', 'completed', true,
       'Routine BP review', 'no', null, null, false, null, false,
       120, 76, 70, 99, 62, 162,  168, 92, 54, 115, 91, 5.3, 0.8, 98,
       'Normal', 'Hypertension, controlled', 'Essential hypertension, well controlled', '2027-02-05',
       'All results normal. Next check in four months.'),

      -- Rohan Das: one visit only
      ('r1', 'patient6@demo.com', 'doctor4@demo.com', 'Narayana Health', '2026-11-12 18:00+05:30', 'completed', true,
       'Burning in the chest after meals', 'no', null, null, false, null, false,
       118, 76, 74, 99, 74, 178,  null, null, null, null, null, null, null, null,
       'Normal sinus rhythm', 'Acid reflux', 'Gastro-oesophageal reflux disease', '2026-12-12',
       'This is acid reflux, not a heart problem. Take pantoprazole before breakfast, avoid late heavy dinners, and cut down smoking.'),

      -- Suresh Patil: worsening then an acute visit two days ago under emergency access
      ('s1', 'patient7@demo.com', 'doctor1@demo.com', 'Apollo Hospital', '2026-05-06 10:00+05:30', 'completed', true,
       'Occasional chest tightness on brisk walking', 'yes', '3', 'no', false, null, false,
       138, 86, 80, 97, 82, 168,  222, 142, 38, 180, 138, 7.2, 1.0, 82,
       'Non-specific ST-T changes', 'Possible stable angina', 'Exertional chest discomfort; diabetes with dyslipidemia', '2026-08-06',
       'Please get a treadmill test done. Stop smoking; it is the single most helpful change.'),
      ('s2', 'patient7@demo.com', 'doctor1@demo.com', 'Apollo Hospital', '2026-08-19 10:30+05:30', 'completed', true,
       'Chest tightness more often, breathless on stairs', 'yes', '5', 'no', true, 'II', false,
       150, 94, 84, 96, 83, 168,  230, 150, 36, 195, 150, 7.6, 1.1, 76,
       'ST depression 1 mm in V4-V6 on exertion (TMT positive)', 'Stable angina', 'Stable angina with uncontrolled hypertension and dyslipidemia', '2026-10-19',
       'Your stress test is positive. New medicines started. If chest pain lasts more than 15 minutes or comes at rest, go to emergency immediately.'),
      ('s3', 'patient7@demo.com', 'doctor4@demo.com', 'Narayana Health', '-2 days', 'completed', true,
       'Chest pain at rest for 40 minutes, sweating', 'yes', '8', 'yes', true, 'III', false,
       188, 122, 104, 94, 83, 168,  null, null, null, null, 210, null, 1.2, 70,
       'ST depression 2 mm in V4-V6 at rest', 'Suspected acute coronary syndrome', 'Unstable angina with hypertensive urgency; referred to cardiology', null,
       'You were treated for chest pain and very high blood pressure. Dr. Mehta will see you urgently.'),

      -- Divya Menon: one visit; the access states are set below
      ('d1', 'patient8@demo.com', 'doctor4@demo.com', 'Narayana Health', '2026-09-25 17:30+05:30', 'completed', true,
       'Throbbing headache twice a week', 'no', null, null, false, null, false,
       112, 72, 70, 99, 52, 158,  null, null, null, null, null, null, null, null,
       null, 'Migraine', 'Migraine without aura', '2026-12-25',
       'Keep a headache diary, sleep at regular times, and take naproxen at the start of an attack.')
    ) as t(key, p, d, h, at, st, sh, cc, cp, sev, rest, br, nyha, pal,
           sbp, dbp, hr, spo2, wt, ht, tc, ldl, hdl, tg, fg, a1c, cr, egfr,
           ecg, prelim, final, fu, notes)
  loop
    v_at := case when r.at like '-%' then now() + r.at::interval else r.at::timestamptz end;

    insert into public.consultations (
      patient_id, doctor_id, hospital_id, disease_type, status, consultation_date, finalized_at,
      is_shared_with_patient, complaints,
      systolic_bp, diastolic_bp, heart_rate, respiratory_rate, spo2, temperature_c,
      height_cm, weight_kg, bmi, observations, preliminary_diagnosis, final_diagnosis, assessment,
      follow_up_date, doctor_notes,
      total_cholesterol, ldl_cholesterol, hdl_cholesterol, triglycerides, fasting_glucose, hba1c,
      serum_creatinine, egfr, labs_source)
    values (
      (select id from auth.users where email = r.p),
      (select id from auth.users where email = r.d),
      (select id from public.hospitals where name = r.h order by created_at limit 1),
      'cad', r.st, v_at,
      case when r.st = 'completed' then v_at + interval '40 minutes' end,
      r.sh,
      jsonb_strip_nulls(jsonb_build_object(
        'main_complaint', r.cc, 'chest_pain', r.cp, 'pain_severity', r.sev, 'pain_at_rest', r.rest,
        'breathlessness', r.br, 'nyha_class', r.nyha, 'palpitations', r.pal,
        'dizziness', false, 'sweating', r.rest = 'yes', 'fatigue', false, 'other_symptoms', '')),
      r.sbp::numeric, r.dbp::numeric, r.hr::numeric, 16, r.spo2::numeric, 36.8,
      r.ht::numeric, r.wt::numeric, round(r.wt::numeric / power(r.ht::numeric / 100, 2), 1),
      jsonb_strip_nulls(jsonb_build_object(
        'ecg', r.ecg,
        'blood_report', nullif(concat_ws(', ',
            'Total cholesterol ' || r.tc || ' mg/dL', 'LDL ' || r.ldl || ' mg/dL', 'HDL ' || r.hdl || ' mg/dL',
            'Triglycerides ' || r.tg || ' mg/dL', 'Fasting glucose ' || r.fg || ' mg/dL', 'HbA1c ' || r.a1c || '%',
            'Creatinine ' || r.cr || ' mg/dL', 'eGFR ' || r.egfr), ''))),
      r.prelim, r.final,
      jsonb_build_object('clinical_assessment', r.final),
      r.fu::date, r.notes,
      r.tc::numeric, r.ldl::numeric, r.hdl::numeric, r.tg::numeric, r.fg::numeric, r.a1c::numeric,
      r.cr::numeric, r.egfr::numeric,
      case when coalesce(r.tc, r.fg, r.cr, r.egfr) is not null then 'manual' end)
    returning id into v_id;

    v_visits := v_visits || jsonb_build_object(r.key, v_id);
  end loop;

  -- Suresh: Dr. Mehta's follow-up started 30 minutes ago and not finished (Drafts page)
  insert into public.consultations (patient_id, doctor_id, hospital_id, disease_type, status, consultation_date,
                                    complaints, systolic_bp, diastolic_bp, heart_rate, height_cm, weight_kg, bmi)
  values ((select id from auth.users where email = 'patient7@demo.com'),
          (select id from auth.users where email = 'doctor1@demo.com'),
          (select id from public.hospitals where name = 'Apollo Hospital' order by created_at limit 1),
          'cad', 'pending', now() - interval '30 minutes',
          '{"main_complaint":"Urgent cardiology review after emergency visit","chest_pain":"no","breathlessness":true,"nyha_class":"II"}',
          158, 98, 88, 168, 83, 29.4)
  returning id into v_id;
  v_visits := v_visits || jsonb_build_object('s4_draft', v_id);

  -- ---------- prescriptions (issued 45 minutes after each visit) ----------
  insert into public.prescriptions (consultation_id, patient_id, doctor_id, medicines, instructions, issued_at)
  select c.id, c.patient_id, c.doctor_id, x.meds::jsonb, x.instr, c.consultation_date + interval '45 minutes'
  from (values
    ('m1', '[{"name":"Metformin","dosage":"500 mg","frequency":"1-0-1","duration":"90 days","duration_days":90,"timing":"After food","notes":null}]',
           'Walk 30 minutes daily. Reduce sweets and rice portions.'),
    ('m2', '[{"name":"Metformin","dosage":"1000 mg","frequency":"1-0-1","duration":"90 days","duration_days":90,"timing":"After food","notes":"Dose increased from 500 mg"},
             {"name":"Telmisartan","dosage":"40 mg","frequency":"1-0-0","duration":"90 days","duration_days":90,"timing":"Before food","notes":"New: for blood pressure"}]',
           'Check BP at home twice a week.'),
    ('m3', '[{"name":"Atorvastatin","dosage":"10 mg","frequency":"0-0-1","duration":"180 days","duration_days":180,"timing":"At bedtime","notes":"New: diabetes with cardiovascular risk"}]',
           'Continue diabetes medicines as prescribed by Dr. Reddy.'),
    ('m4', '[{"name":"Metformin","dosage":"1000 mg","frequency":"1-0-1","duration":"90 days","duration_days":90,"timing":"After food","notes":null},
             {"name":"Telmisartan","dosage":"40 mg","frequency":"1-0-0","duration":"90 days","duration_days":90,"timing":"Before food","notes":null}]',
           'Repeat HbA1c and lipid profile in 3 months.'),
    ('a1', '[{"name":"Amlodipine","dosage":"5 mg","frequency":"1-0-0","duration":"90 days","duration_days":90,"timing":"After food","notes":null}]',
           'Low-salt diet. Nephrology referral given.'),
    ('a2', '[{"name":"Telmisartan","dosage":"40 mg","frequency":"1-0-0","duration":"90 days","duration_days":90,"timing":"Before food","notes":"Replaces amlodipine: protects the kidneys"}]',
           'Avoid painkillers such as ibuprofen and diclofenac. Repeat creatinine in 3 months.'),
    ('a3', '[{"name":"Telmisartan","dosage":"80 mg","frequency":"1-0-0","duration":"90 days","duration_days":90,"timing":"Before food","notes":"Dose increased"},
             {"name":"Amlodipine","dosage":"5 mg","frequency":"0-0-1","duration":"90 days","duration_days":90,"timing":"After food","notes":"Added back for BP"}]',
           'Daily home BP log. Limit salt to 5 g a day.'),
    ('a4', '[{"name":"Telmisartan","dosage":"80 mg","frequency":"1-0-0","duration":"30 days","duration_days":30,"timing":"Before food","notes":null},
             {"name":"Amlodipine","dosage":"10 mg","frequency":"0-0-1","duration":"30 days","duration_days":30,"timing":"After food","notes":"Dose increased"},
             {"name":"Sodium bicarbonate","dosage":"500 mg","frequency":"1-1-1","duration":"30 days","duration_days":30,"timing":"After food","notes":"New: for kidney acid balance"}]',
           'Kidney ultrasound and urine albumin before the next visit.'),
    ('f1', '[{"name":"Amlodipine","dosage":"5 mg","frequency":"1-0-0","duration":"120 days","duration_days":120,"timing":"After food","notes":null}]', 'Continue walking.'),
    ('f2', '[{"name":"Amlodipine","dosage":"5 mg","frequency":"1-0-0","duration":"120 days","duration_days":120,"timing":"After food","notes":null}]', 'Continue walking.'),
    ('f3', '[{"name":"Amlodipine","dosage":"5 mg","frequency":"1-0-0","duration":"120 days","duration_days":120,"timing":"After food","notes":null}]', 'Next review in four months.'),
    ('r1', '[{"name":"Pantoprazole","dosage":"40 mg","frequency":"1-0-0","duration":"28 days","duration_days":28,"timing":"Before breakfast","notes":null}]',
           'No heavy meals within 3 hours of bedtime. Cut down smoking and alcohol.'),
    ('s1', '[{"name":"Sorbitrate (Isosorbide dinitrate)","dosage":"5 mg","frequency":"SOS","duration":"30 days","duration_days":30,"timing":"As needed","notes":"Under the tongue for chest pain"}]',
           'Treadmill test before the next visit. Stop smoking.'),
    ('s2', '[{"name":"Losartan","dosage":"50 mg","frequency":"1-0-0","duration":"60 days","duration_days":60,"timing":"After food","notes":"New: for blood pressure"},
             {"name":"Rosuvastatin","dosage":"10 mg","frequency":"0-0-1","duration":"60 days","duration_days":60,"timing":"At bedtime","notes":"New: for cholesterol"},
             {"name":"Metoprolol","dosage":"25 mg","frequency":"1-0-1","duration":"60 days","duration_days":60,"timing":"After food","notes":"New: do not stop suddenly"}]',
           'Emergency if chest pain lasts more than 15 minutes or comes at rest. Aspirin avoided because of gastritis.'),
    ('s3', '[{"name":"Clopidogrel","dosage":"75 mg","frequency":"1-0-0","duration":"30 days","duration_days":30,"timing":"After food","notes":"Started in emergency; aspirin not tolerated"},
             {"name":"Rosuvastatin","dosage":"20 mg","frequency":"0-0-1","duration":"30 days","duration_days":30,"timing":"At bedtime","notes":"Dose increased"}]',
           'Urgent cardiology review arranged with Dr. Mehta.'),
    ('d1', '[{"name":"Naproxen","dosage":"500 mg","frequency":"SOS","duration":"30 days","duration_days":30,"timing":"After food","notes":"At the start of a headache; at most 2 a day"}]',
           'Headache diary. Regular sleep and meals.')
  ) as x(key, meds, instr)
  join public.consultations c on c.id = (v_visits ->> x.key)::uuid;

  -- ---------- access: who may open which record ----------
  -- The SQL editor has no signed-in user, so the v11 guard lets these
  -- states through as written (the app itself only changes them via RPCs).
  insert into public.doctor_patient_assignments
    (doctor_id, patient_id, is_active, access_status, is_emergency, access_reason,
     assigned_at, requested_at, responded_at, revoked_at)
  select dr.id, pt.id, x.status = 'active', x.status, x.emergency, x.reason,
         coalesce(x.assigned::timestamptz, now()), coalesce(x.requested, x.assigned)::timestamptz,
         x.responded::timestamptz, x.revoked::timestamptz
  from (values
    -- doctor,            patient,             status,    emergency, reason, assigned/requested, responded, revoked
    ('doctor3@demo.com', 'patient3@demo.com', 'active',  false, null, '2026-02-02 09:50+05:30', null, '2026-02-02 09:52+05:30', null),
    ('doctor1@demo.com', 'patient3@demo.com', 'active',  false, 'Cardiac risk screening referral', '2026-08-20 09:20+05:30', null, '2026-08-20 09:25+05:30', null),
    ('doctor2@demo.com', 'patient4@demo.com', 'active',  false, null, '2026-01-20 15:50+05:30', null, '2026-01-20 15:55+05:30', null),
    ('doctor5@demo.com', 'patient4@demo.com', 'active',  false, 'Nephrology referral from Dr. Rao', '2026-04-28 10:20+05:30', null, '2026-04-28 10:24+05:30', null),
    ('doctor2@demo.com', 'patient5@demo.com', 'active',  false, null, '2026-02-14 11:50+05:30', null, '2026-02-14 11:55+05:30', null),
    ('doctor4@demo.com', 'patient6@demo.com', 'active',  false, null, '2026-11-12 17:50+05:30', null, '2026-11-12 17:52+05:30', null),
    ('doctor1@demo.com', 'patient7@demo.com', 'active',  false, null, '2026-05-06 09:50+05:30', null, '2026-05-06 09:55+05:30', null),
    ('doctor4@demo.com', 'patient7@demo.com', 'active',  true,
       'Walk-in with chest pain at rest and BP 188/122; needed previous cardiac history urgently', null, null, null, null),
    ('doctor4@demo.com', 'patient8@demo.com', 'active',  false, null, '2026-09-25 17:20+05:30', null, '2026-09-25 17:22+05:30', null),
    ('doctor3@demo.com', 'patient8@demo.com', 'pending', false, 'Referred for thyroid evaluation', null, null, null, null),
    ('doctor1@demo.com', 'patient8@demo.com', 'denied',  false, 'Routine cardiac screening', '2026-10-02 10:00+05:30', null, '2026-10-02 18:30+05:30', null),
    ('doctor2@demo.com', 'patient8@demo.com', 'revoked', false, 'Second opinion on headaches', '2026-07-01 12:00+05:30', null, '2026-07-01 12:30+05:30', '2026-10-30 20:15+05:30'),
    ('doctor5@demo.com', 'patient3@demo.com', 'pending', false, 'Kidney screening for diabetes (urine albumin)', null, null, null, null)
  ) as x(doc, pat, status, emergency, reason, assigned, requested, responded, revoked)
  join auth.users dr on dr.email = x.doc
  join auth.users pt on pt.email = x.pat
  on conflict (doctor_id, patient_id) do update set
    is_active = excluded.is_active, access_status = excluded.access_status, is_emergency = excluded.is_emergency,
    access_reason = excluded.access_reason, assigned_at = excluded.assigned_at, requested_at = excluded.requested_at,
    responded_at = excluded.responded_at, revoked_at = excluded.revoked_at;

  -- Rows written with relative times (emergency now, pending requests recent)
  update public.doctor_patient_assignments a set
    assigned_at = (select consultation_date from public.consultations where id = (v_visits ->> 's3')::uuid) - interval '10 minutes',
    requested_at = (select consultation_date from public.consultations where id = (v_visits ->> 's3')::uuid) - interval '10 minutes',
    responded_at = (select consultation_date from public.consultations where id = (v_visits ->> 's3')::uuid) - interval '10 minutes'
  where a.doctor_id = (select id from auth.users where email = 'doctor4@demo.com')
    and a.patient_id = (select id from auth.users where email = 'patient7@demo.com');
  update public.doctor_patient_assignments a set requested_at = now() - interval '3 hours'
  where a.access_status = 'pending'
    and a.patient_id in (select id from auth.users where email in ('patient3@demo.com', 'patient8@demo.com'));

  -- ---------- access history (what the patient sees under "Doctors who accessed your record") ----------
  insert into public.audit_logs (user_id, action, target_id, target_type, metadata, created_at)
  select a.user_id, a.action, a.target_id, 'patient', a.meta, a.at
  from (
    select dpa.doctor_id as user_id, 'opened_patient_record' as action, dpa.patient_id as target_id,
           '{"source":"search"}'::jsonb as meta, dpa.assigned_at as at
      from public.doctor_patient_assignments dpa
     where dpa.access_status in ('active', 'revoked') and not dpa.is_emergency
       and dpa.patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com')
    union all
    select c.doctor_id, 'viewed_patient', c.patient_id, null, c.consultation_date - interval '5 minutes'
      from public.consultations c
     where c.patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com')
    union all
    select dpa.doctor_id, 'emergency_access', dpa.patient_id, jsonb_build_object('reason', dpa.access_reason), dpa.assigned_at
      from public.doctor_patient_assignments dpa
     where dpa.is_emergency
       and dpa.patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com')
    union all
    select dpa.doctor_id, 'access_requested', dpa.patient_id, jsonb_build_object('reason', dpa.access_reason), dpa.requested_at
      from public.doctor_patient_assignments dpa
     where dpa.access_status in ('pending', 'denied')
       and dpa.patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com')
    union all
    select dpa.patient_id, 'access_denied', dpa.patient_id, jsonb_build_object('doctor_id', dpa.doctor_id), dpa.responded_at
      from public.doctor_patient_assignments dpa
     where dpa.access_status = 'denied'
       and dpa.patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com')
    union all
    select dpa.patient_id, 'access_revoked', dpa.patient_id, jsonb_build_object('doctor_id', dpa.doctor_id), dpa.revoked_at
      from public.doctor_patient_assignments dpa
     where dpa.access_status = 'revoked'
       and dpa.patient_id in (select id from auth.users where email like 'patient_@demo.com' and email >= 'patient3@demo.com')
  ) a;

  -- ---------- appointments: every status, plus today / tomorrow / this week ----------
  insert into public.appointments (patient_id, doctor_id, scheduled_at, duration_minutes, reason, status, booked_by, related_consultation_id)
  select pt.id, dr.id, x.at, 30, x.reason, x.status, x.booked, (v_visits ->> x.visit)::uuid
  from (values
    ('patient7@demo.com', 'doctor1@demo.com', date_trunc('hour', now()) + interval '2 hours',  'Urgent cardiology review after emergency visit', 'scheduled', 'doctor',  's3'),
    ('patient4@demo.com', 'doctor5@demo.com', date_trunc('hour', now()) + interval '4 hours',  'Kidney function and BP review',                  'scheduled', 'doctor',  'a4'),
    ('patient6@demo.com', 'doctor4@demo.com', date_trunc('hour', now()) + interval '1 day',    'Follow-up: acid reflux',                         'scheduled', 'patient', 'r1'),
    ('patient3@demo.com', 'doctor3@demo.com', date_trunc('hour', now()) + interval '2 days 1 hour', 'Diabetes follow-up and HbA1c review',     'scheduled', 'doctor',  'm4'),
    ('patient8@demo.com', 'doctor4@demo.com', date_trunc('hour', now()) + interval '6 days',   'Migraine follow-up',                             'scheduled', 'patient', 'd1'),
    ('patient5@demo.com', 'doctor2@demo.com', date_trunc('hour', now()) + interval '14 days',  'Routine BP review',                              'scheduled', 'patient', 'f3'),
    ('patient3@demo.com', 'doctor3@demo.com', '2026-10-20 10:00+05:30'::timestamptz,           'Diabetes review',                                'completed', 'doctor',  'm2'),
    ('patient4@demo.com', 'doctor2@demo.com', '2026-09-15 11:00+05:30'::timestamptz,           'BP check',                                       'missed',    'doctor',  'a1'),
    ('patient5@demo.com', 'doctor2@demo.com', '2026-08-12 12:00+05:30'::timestamptz,           'Routine BP review',                              'cancelled', 'patient', 'f2'),
    ('patient7@demo.com', 'doctor1@demo.com', '2026-08-19 10:30+05:30'::timestamptz,           'Treadmill test review',                          'completed', 'doctor',  's1')
  ) as x(pat, doc, at, reason, status, booked, visit)
  join auth.users pt on pt.email = x.pat
  join auth.users dr on dr.email = x.doc;

  -- ---------- notifications ----------
  insert into public.notifications (user_id, type, title, body, related_id, is_read, created_at)
  select u.id, x.type, x.title, x.body, (v_visits ->> x.visit)::uuid, x.is_read, x.at
  from (values
    ('patient3@demo.com', 'consultation_shared', 'New visit result available', 'Dr. Kavya Reddy has shared your October diabetes review.', 'm4', false, '2026-10-20 11:00+05:30'::timestamptz),
    ('patient3@demo.com', 'general', 'A doctor is asking to open your record', 'Dr. Lakshmi Iyer (Apollo Hospital) has asked for access to your MEDIS record. Reason: Kidney screening for diabetes (urine albumin). Approve or decline it under "Doctors who accessed your profile".', null, false, now() - interval '3 hours'),
    ('patient4@demo.com', 'consultation_shared', 'New visit result available', 'Dr. Lakshmi Iyer has shared your July kidney follow-up.', 'a3', true, '2026-07-30 12:00+05:30'::timestamptz),
    ('patient5@demo.com', 'consultation_shared', 'New visit result available', 'Dr. Arjun Rao has shared your October BP review.', 'f3', true, '2026-10-05 12:30+05:30'::timestamptz),
    ('patient7@demo.com', 'general', 'Emergency access to your record', 'Dr. Sameer Khan (Narayana Health) opened your record under emergency access. Reason given: Walk-in with chest pain at rest and BP 188/122; needed previous cardiac history urgently. You can review or revoke this under "Doctors who accessed your profile".', null, false, now() - interval '2 days'),
    ('patient7@demo.com', 'consultation_shared', 'New visit result available', 'Dr. Sameer Khan has shared your emergency visit summary.', 's3', false, now() - interval '2 days' + interval '1 hour'),
    ('patient8@demo.com', 'general', 'A doctor is asking to open your record', 'Dr. Kavya Reddy (Fortis Hospital) has asked for access to your MEDIS record. Reason: Referred for thyroid evaluation. Approve or decline it under "Doctors who accessed your profile".', null, false, now() - interval '3 hours')
  ) as x(email, type, title, body, visit, is_read, at)
  join auth.users u on u.email = x.email;

  raise notice 'Extended demo data loaded: % visits.', (select count(*) from jsonb_object_keys(v_visits));
end $$;


-- ============================================================
-- PART 4: REPAIR RAHUL SHARMA'S LAB VALUES (patient1, demo_seed.sql)
-- Fills the numeric lab columns only where they are empty, matching each
-- visit by its date. Values are the ones in each visit's blood report.
-- ============================================================
update public.consultations c set
  total_cholesterol = v.tc, ldl_cholesterol = v.ldl, hdl_cholesterol = v.hdl,
  triglycerides = v.tg, fasting_glucose = v.fg, hba1c = v.a1c,
  serum_creatinine = v.cr, egfr = v.egfr, labs_source = 'manual'
from (values
  ('2026-01-12'::date, 180, 95, 48, 130,  95, 5.5, 0.9, 95),
  ('2026-03-18'::date, 195, 110, 44, 145, 110, 5.9, 0.9, 94),
  ('2026-06-22'::date, 215, 135, 40, 165, 125, 6.2, 1.0, 90),
  ('2026-10-08'::date, 235, 155, 36, 190, 145, 6.8, 1.0, 88)
) as v(d, tc, ldl, hdl, tg, fg, a1c, cr, egfr)
where c.patient_id = (select id from auth.users where email = 'patient1@demo.com')
  and (c.consultation_date at time zone 'Asia/Kolkata')::date = v.d
  and c.status = 'completed'
  and c.ldl_cholesterol is null;


-- ============================================================
-- Logins and IDs
-- ============================================================
select p.full_name, p.role, p.display_id, u.email,
       coalesce(dp.specialization || ', ' || dp.hospital_name, '') as doctor_at,
       (select count(*) from public.consultations c where c.patient_id = p.id) as visits
from public.profiles p
join auth.users u on u.id = p.id
left join public.doctor_profiles dp on dp.id = p.id
where u.email like '%@demo.com'
order by p.role, u.email;
