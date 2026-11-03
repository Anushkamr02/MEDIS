-- ============================================================
-- MEDIS DEMO SEED DATA
-- Run AFTER all migrations (v1, v2, v3, v3b, v3c, v3d, v3e, v3f, v4).
--
-- Creates (if missing) and fills these 4 accounts, all with
-- password  Demo@1234  and email already confirmed:
--
--   doctor1@demo.com   → Dr. Priya Mehta, Cardiology, Apollo Hospital
--   doctor2@demo.com   → Dr. Arjun Rao, Internal Medicine, Manipal Hospital
--   patient1@demo.com  → Rahul Sharma (the 4-visit longitudinal case)
--   patient2@demo.com  → Ananya Nair (1 visit + an open draft)
--
-- If you already created any of them yourself, they're reused as-is
-- (your password stays); role / ID / hospital are corrected below.
--
-- RE-RUNNABLE: it first deletes all existing clinical data for the
-- two demo patients. Never point these emails at real accounts.
-- ============================================================


-- ============================================================
-- PART 1: CREATE MISSING DEMO LOGIN ACCOUNTS
-- Inserts straight into Supabase Auth. The empty-string token
-- columns matter: Supabase Auth fails to log in users whose token
-- columns are NULL. Inserting into auth.users fires
-- handle_new_user, which creates the profiles row + MEDIS ID.
-- ============================================================
do $$
declare
  r record;
  v_uid uuid;
begin
  for r in
    select * from (values
      ('doctor1@demo.com',  'Priya Mehta',  'doctor'),
      ('doctor2@demo.com',  'Arjun Rao',    'doctor'),
      ('patient1@demo.com', 'Rahul Sharma', 'patient'),
      ('patient2@demo.com', 'Ananya Nair',  'patient')
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
      now(), now(),
      '', '', '', ''
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
-- PART 2: DEMO CLINICAL DATA
-- ============================================================
do $$
declare
  v_d1 uuid;  v_d2 uuid;  v_p1 uuid;  v_p2 uuid;
  v_apollo uuid;  v_manipal uuid;  v_fortis uuid;
  v_c1 uuid;  v_c2 uuid;  v_c3 uuid;  v_c4 uuid;  v_c5 uuid;
begin
  -- ----------------------------------------------------------
  -- 1. Find the demo accounts
  -- ----------------------------------------------------------
  select id into v_d1 from auth.users where email = 'doctor1@demo.com';
  select id into v_d2 from auth.users where email = 'doctor2@demo.com';
  select id into v_p1 from auth.users where email = 'patient1@demo.com';
  select id into v_p2 from auth.users where email = 'patient2@demo.com';

  if v_d1 is null or v_d2 is null or v_p1 is null or v_p2 is null then
    raise exception 'Create all 4 demo accounts first (doctor1/doctor2/patient1/patient2 @demo.com). Missing: %',
      concat_ws(', ',
        case when v_d1 is null then 'doctor1' end,
        case when v_d2 is null then 'doctor2' end,
        case when v_p1 is null then 'patient1' end,
        case when v_p2 is null then 'patient2' end);
  end if;

  -- ----------------------------------------------------------
  -- 2. Clean previous demo data (safe re-run)
  -- ----------------------------------------------------------
  delete from public.cad_assessments            where patient_id in (v_p1, v_p2);  -- migration v4
  delete from public.ecg_analyses               where patient_id in (v_p1, v_p2);  -- migration v4
  delete from public.appointments               where patient_id in (v_p1, v_p2);
  delete from public.consultations              where patient_id in (v_p1, v_p2);  -- cascades prescriptions, inputs, predictions
  delete from public.patient_medical_history    where patient_id in (v_p1, v_p2);
  delete from public.family_history             where patient_id in (v_p1, v_p2);
  delete from public.current_medications        where patient_id in (v_p1, v_p2);
  delete from public.notifications              where user_id    in (v_p1, v_p2);
  delete from public.doctor_patient_assignments where patient_id in (v_p1, v_p2);
  delete from public.audit_logs                 where target_id  in (v_p1, v_p2);

  -- ----------------------------------------------------------
  -- 3. Hospitals
  -- ----------------------------------------------------------
  insert into public.hospitals (name, address, city)
  select 'Manipal Hospital', 'HAL Airport Road', 'Bengaluru'
  where not exists (select 1 from public.hospitals where name = 'Manipal Hospital');

  insert into public.hospitals (name, address, city)
  select 'Fortis Hospital', 'Bannerghatta Road', 'Bengaluru'
  where not exists (select 1 from public.hospitals where name = 'Fortis Hospital');

  select id into v_apollo  from public.hospitals where name = 'Apollo Hospital'  order by created_at limit 1;
  select id into v_manipal from public.hospitals where name = 'Manipal Hospital' order by created_at limit 1;
  select id into v_fortis  from public.hospitals where name = 'Fortis Hospital'  order by created_at limit 1;

  if v_apollo is null then
    insert into public.hospitals (name, city) values ('Apollo Hospital', 'Bengaluru') returning id into v_apollo;
  end if;

  -- ----------------------------------------------------------
  -- 4. Doctors (force role + MEDIS-D ID + doctor_profiles)
  -- ----------------------------------------------------------
  update public.profiles set
    role = 'doctor', full_name = 'Priya Mehta', gender = 'female', phone = '+91 98450 11223',
    display_id = case when display_id like 'MEDIS-D-%' then display_id
                      else public.generate_display_id('D', 4) end
  where id = v_d1;

  update public.profiles set
    role = 'doctor', full_name = 'Arjun Rao', gender = 'male', phone = '+91 98860 44556',
    display_id = case when display_id like 'MEDIS-D-%' then display_id
                      else public.generate_display_id('D', 4) end
  where id = v_d2;

  -- In case a doctor account was first registered as a patient
  delete from public.patient_profiles where id in (v_d1, v_d2);

  insert into public.doctor_profiles (id, specialization, qualification, license_number, hospital_id, hospital_name, years_of_experience)
  values
    (v_d1, 'Cardiology',        'MBBS, MD, DM (Cardiology)', 'KMC-2012-44871', v_apollo,  'Apollo Hospital',  12),
    (v_d2, 'Internal Medicine', 'MBBS, MD',                  'KMC-2016-51203', v_manipal, 'Manipal Hospital',  8)
  on conflict (id) do update set
    specialization = excluded.specialization, qualification = excluded.qualification,
    license_number = excluded.license_number, hospital_id = excluded.hospital_id,
    hospital_name = excluded.hospital_name, years_of_experience = excluded.years_of_experience;

  -- ----------------------------------------------------------
  -- 5. Patients (force role + MEDIS-P ID + onboarding data)
  -- ----------------------------------------------------------
  update public.profiles set
    role = 'patient', full_name = 'Rahul Sharma', gender = 'male',
    date_of_birth = '1978-04-15', phone = '+91 99001 23456',
    display_id = case when display_id like 'MEDIS-P-%' then display_id
                      else public.generate_display_id('P', 5) end
  where id = v_p1;

  update public.profiles set
    role = 'patient', full_name = 'Ananya Nair', gender = 'female',
    date_of_birth = '1987-09-02', phone = '+91 98765 43210',
    display_id = case when display_id like 'MEDIS-P-%' then display_id
                      else public.generate_display_id('P', 5) end
  where id = v_p2;

  delete from public.doctor_profiles where id in (v_p1, v_p2);

  insert into public.patient_profiles (id, blood_group, height_cm, weight_kg, allergies, emergency_contact,
                                       smoking_status, alcohol_use, known_conditions)
  values
    (v_p1, 'B+', 172, 82, 'Penicillin', 'Meera Sharma (wife) +91 99001 65432', 'former', 'occasional',
     '{"hypertension": true, "diabetes": "prediabetes", "family_cardiac_history": true, "chest_pain_history": true, "previous_cardiac_events": false}'),
    (v_p2, 'O+', 160, 58, null, 'Vikram Nair (brother) +91 98765 11111', 'never', 'never',
     '{"hypertension": false, "diabetes": false, "family_cardiac_history": false, "chest_pain_history": false}')
  on conflict (id) do update set
    blood_group = excluded.blood_group, height_cm = excluded.height_cm, weight_kg = excluded.weight_kg,
    allergies = excluded.allergies, emergency_contact = excluded.emergency_contact,
    smoking_status = excluded.smoking_status, alcohol_use = excluded.alcohol_use,
    known_conditions = excluded.known_conditions;

  insert into public.patient_medical_history (patient_id, condition_name, diagnosed_at, is_active, notes) values
    (v_p1, 'Essential hypertension', '2025-08-10', true,  'Started amlodipine Aug 2025'),
    (v_p1, 'Prediabetes',            '2026-06-22', true,  'HbA1c 6.2% in June 2026'),
    (v_p1, 'Dyslipidemia',           '2026-06-22', true,  'Rising LDL across 2026'),
    (v_p2, 'Iron-deficiency anaemia', '2021-03-01', false, 'Resolved after supplementation');

  insert into public.family_history (patient_id, relation, condition_name, notes) values
    (v_p1, 'parent',  'Coronary artery disease', 'Father, myocardial infarction at age 52'),
    (v_p1, 'sibling', 'Type 2 diabetes',         'Elder brother, diagnosed at 45'),
    (v_p2, 'parent',  'Hypothyroidism',          'Mother');

  insert into public.current_medications (patient_id, medicine_name, condition_name, dosage, frequency, started_at, is_active) values
    (v_p1, 'Amlodipine',   'Hypertension', '5 mg',  'Once daily',          '2025-08-10', true),
    (v_p1, 'Atorvastatin', 'Dyslipidemia', '20 mg', 'Once daily at night', '2026-06-22', true),
    (v_p1, 'Telmisartan',  'Hypertension', '40 mg', 'Once daily',          '2025-08-10', false);

  -- ----------------------------------------------------------
  -- 6. Rahul's 4 visits — 3 hospitals, 2 doctors, worsening trend
  --    (visit_id and doctor access are created by v3 triggers)
  -- ----------------------------------------------------------

  -- Visit 1 · Jan 2026 · Apollo · Dr. Mehta · routine check, all normal-ish
  insert into public.consultations (patient_id, doctor_id, hospital_id, disease_type, status,
    consultation_date, finalized_at, is_shared_with_patient,
    complaints, systolic_bp, diastolic_bp, heart_rate, respiratory_rate, spo2, temperature_c,
    height_cm, weight_kg, bmi, observations, preliminary_diagnosis, final_diagnosis, assessment,
    follow_up_date, doctor_notes)
  values (v_p1, v_d1, v_apollo, 'cad', 'completed',
    '2026-01-12 10:30+05:30', '2026-01-12 11:05+05:30', true,
    '{"main_complaint":"Routine annual health check","chest_pain":"no","breathlessness":false,"palpitations":false,"dizziness":false,"sweating":false,"fatigue":false,"other_symptoms":""}',
    120, 80, 72, 14, 98, 36.7, 172, 78, 26.4,
    '{"general":"Well built, no pallor or oedema","cardiovascular":"S1 S2 normal, no murmurs","respiratory":"Clear, bilateral air entry equal","ecg":"Normal sinus rhythm, no ST-T changes","blood_report":"Total cholesterol 180, LDL 95, HDL 48, Triglycerides 130 mg/dL. Fasting glucose 95 mg/dL, HbA1c 5.5%","physical":"BMI 26.4 (overweight)","additional":"Hypertension well controlled on amlodipine."}',
    'Controlled hypertension', 'Essential hypertension, controlled',
    '{"clinical_assessment":"Stable. Overweight with family history of premature CAD.","suspected_conditions":"","cad_risk_assessment":"Low-moderate: family history + hypertension","supporting_findings":"Normal ECG, lipids within range","recommended_investigations":"Repeat lipid profile in 3 months"}',
    '2026-04-12', 'Your check-up was normal. Keep taking amlodipine, reduce salt and aim for 30 minutes of walking daily.')
  returning id into v_c1;

  -- Visit 2 · Mar 2026 · Manipal · Dr. Rao · new exertional discomfort (NOT shared — shows "results not shared")
  insert into public.consultations (patient_id, doctor_id, hospital_id, disease_type, status,
    consultation_date, finalized_at, is_shared_with_patient,
    complaints, systolic_bp, diastolic_bp, heart_rate, respiratory_rate, spo2, temperature_c,
    height_cm, weight_kg, bmi, observations, preliminary_diagnosis, final_diagnosis, assessment,
    follow_up_date, doctor_notes)
  values (v_p1, v_d2, v_manipal, 'cad', 'completed',
    '2026-03-18 16:00+05:30', '2026-03-18 16:40+05:30', false,
    '{"main_complaint":"Chest discomfort while climbing stairs","chest_pain":"yes","chest_pain_duration":"3 weeks","pain_location":"Central chest","pain_severity":"3","breathlessness":false,"palpitations":false,"dizziness":false,"sweating":false,"fatigue":false,"other_symptoms":"Settles with rest in 2-3 minutes"}',
    130, 85, 78, 16, 98, 36.8, 172, 79, 26.7,
    '{"general":"Comfortable at rest","cardiovascular":"S1 S2 normal","respiratory":"Clear","ecg":"Non-specific ST-T changes in V4-V6","blood_report":"Total cholesterol 195, LDL 110, HDL 44, Triglycerides 145 mg/dL. Fasting glucose 110 mg/dL, HbA1c 5.9%","physical":"","additional":"Symptoms suggest possible stable angina; needs stress testing."}',
    'Possible stable angina', 'Atypical chest pain, rule out stable angina',
    '{"clinical_assessment":"Exertional symptoms with rising LDL and fasting glucose.","suspected_conditions":"Stable angina","cad_risk_assessment":"Moderate","supporting_findings":"Non-specific ST-T changes","recommended_investigations":"TMT, 2D Echo"}',
    '2026-04-15', 'Please get the treadmill test (TMT) done before the next visit.')
  returning id into v_c2;

  -- Visit 3 · Jun 2026 · Manipal · Dr. Rao · worse lipids, prediabetes
  insert into public.consultations (patient_id, doctor_id, hospital_id, disease_type, status,
    consultation_date, finalized_at, is_shared_with_patient,
    complaints, systolic_bp, diastolic_bp, heart_rate, respiratory_rate, spo2, temperature_c,
    height_cm, weight_kg, bmi, observations, preliminary_diagnosis, final_diagnosis, assessment,
    follow_up_date, doctor_notes)
  values (v_p1, v_d2, v_manipal, 'cad', 'completed',
    '2026-06-22 11:15+05:30', '2026-06-22 12:00+05:30', true,
    '{"main_complaint":"Chest pain on exertion, more frequent","chest_pain":"yes","chest_pain_duration":"3 months","pain_location":"Retrosternal","pain_severity":"5","breathlessness":true,"palpitations":false,"dizziness":false,"sweating":false,"fatigue":false,"other_symptoms":"Breathless after 2 flights of stairs"}',
    140, 90, 82, 18, 97, 36.9, 172, 80.5, 27.2,
    '{"general":"Mildly anxious","cardiovascular":"S1 S2 normal, no murmur","respiratory":"Clear","ecg":"Possible ischaemic changes, ST depression 0.5 mm in V5-V6","blood_report":"Total cholesterol 215, LDL 135, HDL 40, Triglycerides 165 mg/dL. Fasting glucose 125 mg/dL, HbA1c 6.2%","physical":"BMI 27.2","additional":"TMT done 20 Apr: positive at stage 3. 2D Echo: normal LV function, EF 60%."}',
    'Stable angina', 'Stable angina with dyslipidemia and prediabetes',
    '{"clinical_assessment":"Progressive symptoms with positive TMT. Several risk factors worsening.","suspected_conditions":"Coronary artery disease","cad_risk_assessment":"High","supporting_findings":"Positive TMT, rising LDL, HbA1c 6.2%","recommended_investigations":"Cardiology referral; consider CT coronary angiography"}',
    '2026-09-22', 'Started a cholesterol tablet (atorvastatin). Please see a cardiologist. If chest pain lasts more than 15 minutes or comes at rest, go to emergency immediately.')
  returning id into v_c3;

  -- Visit 4 · Oct 2026 · Apollo · Dr. Mehta · cardiology review, worst values
  insert into public.consultations (patient_id, doctor_id, hospital_id, disease_type, status,
    consultation_date, finalized_at, is_shared_with_patient,
    complaints, systolic_bp, diastolic_bp, heart_rate, respiratory_rate, spo2, temperature_c,
    height_cm, weight_kg, bmi, observations, preliminary_diagnosis, final_diagnosis, assessment,
    follow_up_date, doctor_notes)
  values (v_p1, v_d1, v_apollo, 'cad', 'completed',
    '2026-10-08 09:45+05:30', '2026-10-08 10:40+05:30', true,
    '{"main_complaint":"Cardiology review: exertional chest pain persists","chest_pain":"yes","chest_pain_duration":"7 months","pain_location":"Retrosternal, radiating to left arm","pain_severity":"6","breathlessness":true,"palpitations":false,"dizziness":false,"sweating":false,"fatigue":true,"other_symptoms":"Reduced exercise tolerance"}',
    150, 95, 86, 18, 97, 36.8, 172, 82, 27.7,
    '{"general":"Overweight, no oedema","cardiovascular":"S1 S2 normal, no added sounds","respiratory":"Clear","ecg":"New T-wave inversion in V4-V6 compared to March and June ECGs","blood_report":"Total cholesterol 235, LDL 155, HDL 36, Triglycerides 190 mg/dL. Fasting glucose 145 mg/dL, HbA1c 6.8%","physical":"BMI 27.7","additional":"Poor statin adherence reported. Lipids worse despite atorvastatin 20 mg."}',
    'Chronic coronary syndrome', 'Chronic coronary syndrome with uncontrolled hypertension, dyslipidemia and new-onset type 2 diabetes',
    '{"clinical_assessment":"Every recorded risk factor has worsened across four visits at three hospitals.","suspected_conditions":"Multi-vessel CAD","cad_risk_assessment":"High: progressive LDL, BP, HbA1c, new ECG changes","supporting_findings":"Positive TMT (Apr), new T-wave inversion, HbA1c 6.8%","recommended_investigations":"CT coronary angiography; repeat lipid profile and HbA1c in 6 weeks"}',
    '2026-11-03', 'Your heart scan (CT angiography) is scheduled. Medicines have been increased; please take them every day. Avoid heavy exertion until the scan.')
  returning id into v_c4;

  -- Numeric labs (migration v4) matching each visit's blood_report text,
  -- so the AI trend engine and graphs have data to work with.
  update public.consultations c set
    total_cholesterol = v.tc, ldl_cholesterol = v.ldl, hdl_cholesterol = v.hdl,
    triglycerides = v.tg, fasting_glucose = v.fg, hba1c = v.a1c,
    serum_creatinine = v.cr, egfr = v.egfr, labs_source = 'manual'
  from (values
    (v_c1, 180, 95, 48, 130,  95, 5.5, 0.9, 95),
    (v_c2, 195, 110, 44, 145, 110, 5.9, 0.9, 94),
    (v_c3, 215, 135, 40, 165, 125, 6.2, 1.0, 90),
    (v_c4, 235, 155, 36, 190, 145, 6.8, 1.0, 88)
  ) as v(id, tc, ldl, hdl, tg, fg, a1c, cr, egfr)
  where c.id = v.id;

  -- Rahul's prescriptions (each insert notifies the patient via trigger)
  insert into public.prescriptions (consultation_id, patient_id, doctor_id, medicines, instructions, issued_at) values
    (v_c1, v_p1, v_d1,
     '[{"name":"Amlodipine","dosage":"5 mg","frequency":"Once daily","duration":"90 days","duration_days":90,"timing":"After food","notes":null}]',
     'Low-salt diet, 30 minutes brisk walk daily.', '2026-01-12 11:05+05:30'),
    (v_c2, v_p1, v_d2,
     '[{"name":"Sorbitrate (Isosorbide dinitrate)","dosage":"5 mg","frequency":"SOS","duration":"30 days","duration_days":30,"timing":"As needed","notes":"Under the tongue for chest pain"}]',
     'Get TMT and 2D Echo done before next visit.', '2026-03-18 16:40+05:30'),
    (v_c3, v_p1, v_d2,
     '[{"name":"Atorvastatin","dosage":"20 mg","frequency":"0-0-1","duration":"90 days","duration_days":90,"timing":"At bedtime","notes":null},
       {"name":"Aspirin","dosage":"75 mg","frequency":"1-0-0","duration":"90 days","duration_days":90,"timing":"After food","notes":null},
       {"name":"Metoprolol","dosage":"25 mg","frequency":"1-0-1","duration":"90 days","duration_days":90,"timing":"After food","notes":"Do not stop suddenly"}]',
     'Cardiology referral. Emergency if chest pain > 15 min or at rest.', '2026-06-22 12:00+05:30'),
    (v_c4, v_p1, v_d1,
     '[{"name":"Atorvastatin","dosage":"40 mg","frequency":"0-0-1","duration":"60 days","duration_days":60,"timing":"At bedtime","notes":"Dose increased from 20 mg"},
       {"name":"Aspirin","dosage":"75 mg","frequency":"1-0-0","duration":"60 days","duration_days":60,"timing":"After food","notes":null},
       {"name":"Metoprolol","dosage":"50 mg","frequency":"1-0-1","duration":"60 days","duration_days":60,"timing":"After food","notes":"Dose increased"},
       {"name":"Metformin","dosage":"500 mg","frequency":"1-0-1","duration":"60 days","duration_days":60,"timing":"After food","notes":"New: HbA1c 6.8%"}]',
     'CT coronary angiography booked. Repeat lipid profile + HbA1c in 6 weeks.', '2026-10-08 10:40+05:30');

  -- ----------------------------------------------------------
  -- 7. Ananya: one finalized visit + one open draft (for Drafts page)
  -- ----------------------------------------------------------
  insert into public.consultations (patient_id, doctor_id, hospital_id, disease_type, status,
    consultation_date, finalized_at, is_shared_with_patient,
    complaints, systolic_bp, diastolic_bp, heart_rate, respiratory_rate, spo2, temperature_c,
    height_cm, weight_kg, bmi, observations, preliminary_diagnosis, final_diagnosis, assessment, doctor_notes)
  values (v_p2, v_d1, v_apollo, 'cad', 'completed',
    '2026-09-05 14:00+05:30', '2026-09-05 14:30+05:30', true,
    '{"main_complaint":"Palpitations after coffee","chest_pain":"no","breathlessness":false,"palpitations":true,"dizziness":false,"sweating":false,"fatigue":false,"other_symptoms":""}',
    112, 72, 88, 14, 99, 36.6, 160, 58, 22.7,
    '{"general":"Healthy","cardiovascular":"Normal","respiratory":"Clear","ecg":"Sinus tachycardia 102 bpm, otherwise normal","blood_report":"TSH 2.1, Hb 12.8","physical":"","additional":""}',
    'Benign palpitations', 'Caffeine-related sinus tachycardia',
    '{"clinical_assessment":"Low risk","cad_risk_assessment":"Low","recommended_investigations":"None"}',
    'Your heart is healthy. Cut down coffee to one cup a day.')
  returning id into v_c5;

  insert into public.consultations (patient_id, doctor_id, hospital_id, disease_type, status,
    consultation_date, complaints, systolic_bp, diastolic_bp, heart_rate, height_cm, weight_kg, bmi)
  values (v_p2, v_d1, v_apollo, 'cad', 'pending',
    now() - interval '20 minutes',
    '{"main_complaint":"Follow-up: occasional palpitations at night","chest_pain":"no","breathlessness":false,"palpitations":true,"dizziness":false,"sweating":false,"fatigue":true,"other_symptoms":""}',
    116, 74, 84, 160, 58, 22.7);

  -- ----------------------------------------------------------
  -- 8. Access timeline — backdate assignments to first visit
  --    and add "opened record" audit entries for "Last opened"
  -- ----------------------------------------------------------
  update public.doctor_patient_assignments set assigned_at = '2026-01-12 10:25+05:30'
    where doctor_id = v_d1 and patient_id = v_p1;
  update public.doctor_patient_assignments set assigned_at = '2026-03-18 15:55+05:30'
    where doctor_id = v_d2 and patient_id = v_p1;
  update public.doctor_patient_assignments set assigned_at = '2026-09-05 13:55+05:30'
    where doctor_id = v_d1 and patient_id = v_p2;

  insert into public.audit_logs (user_id, action, target_id, target_type, metadata, created_at) values
    (v_d1, 'opened_patient_record', v_p1, 'patient', '{"source":"search"}', '2026-01-12 10:25+05:30'),
    (v_d2, 'opened_patient_record', v_p1, 'patient', '{"source":"search"}', '2026-03-18 15:55+05:30'),
    (v_d2, 'viewed_patient',        v_p1, 'patient', null,                  '2026-06-22 11:10+05:30'),
    (v_d1, 'viewed_patient',        v_p1, 'patient', null,                  '2026-10-08 09:40+05:30'),
    (v_d1, 'opened_patient_record', v_p2, 'patient', '{"source":"search"}', '2026-09-05 13:55+05:30');

  -- ----------------------------------------------------------
  -- 9. Appointments (times relative to NOW so re-running refreshes them)
  -- ----------------------------------------------------------
  insert into public.appointments (patient_id, doctor_id, scheduled_at, duration_minutes, reason,
                                   status, booked_by, related_consultation_id) values
    -- Shows the green "Now" badge for the next ~35 minutes
    (v_p1, v_d1, date_trunc('minute', now()) + interval '5 minutes', 30,
     'Follow-up: CT angiography results and lipid review', 'scheduled', 'doctor', v_c4),
    -- Tomorrow — the hourly pg_cron job sends the 24h reminder
    (v_p2, v_d1, date_trunc('hour', now()) + interval '1 day 2 hours', 30,
     'Palpitations follow-up', 'scheduled', 'patient', null),
    -- Dr. Rao, later this week
    (v_p1, v_d2, date_trunc('hour', now()) + interval '3 days', 30,
     'Diabetes review (HbA1c 6.8%)', 'scheduled', 'doctor', v_c4),
    -- Past, already done
    (v_p1, v_d2, '2026-06-22 11:00+05:30', 30,
     'Review TMT report', 'completed', 'doctor', v_c2);

  -- A few patient notifications
  insert into public.notifications (user_id, type, title, body, related_id, is_read, created_at) values
    (v_p1, 'consultation_shared', 'New screening result available',
     'Dr. Priya Mehta has shared your October consultation result.', v_c4, false, '2026-10-08 10:45+05:30'),
    (v_p1, 'general', 'Report reminder',
     'Please upload your CT coronary angiography report once available.', null, false, '2026-10-20 09:00+05:30');

  raise notice 'Demo data loaded. Patient IDs: % (Rahul), % (Ananya)',
    (select display_id from public.profiles where id = v_p1),
    (select display_id from public.profiles where id = v_p2);
end $$;


-- Shows the IDs to use for searching and logging in
select p.full_name, p.role, p.display_id, u.email
from public.profiles p
join auth.users u on u.id = p.id
where u.email in ('doctor1@demo.com', 'doctor2@demo.com', 'patient1@demo.com', 'patient2@demo.com')
order by p.role, u.email;
