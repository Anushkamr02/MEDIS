// Synthetic fixtures only. Browser tests intercept all Supabase and AI requests.
export const DOCTOR = '11111111-1111-4111-8111-111111111111';
export const PATIENT = '22222222-2222-4222-8222-222222222222';
export const DRAFT = '33333333-3333-4333-8333-333333333333';
export const FINAL = '44444444-4444-4444-8444-444444444444';
export const doctor = { id: DOCTOR, role: 'doctor', full_name: 'Test Doctor', display_id: 'MEDIS-D-000001' };
export const patient = { id: PATIENT, role: 'patient', full_name: 'Test Patient', display_id: 'MEDIS-P-000123', gender: 'male', date_of_birth: '1975-01-01' };
const hospitals = [{ id: '55555555-5555-4555-8555-555555555555', name: 'Test Hospital', city: 'Test City' }];
const doctorDetails = { id: DOCTOR, specialization: 'Cardiology', qualification: 'MD', hospital_id: hospitals[0].id, hospitals: hospitals[0] };

export async function mockApp(page, role = 'doctor', options = {}) {
  const profile = role === 'patient' ? patient : doctor;
  const user = { id: profile.id, email: `${role}@example.test`, aud: 'authenticated', role: 'authenticated', user_metadata: { role: profile.role, full_name: profile.full_name } };
  const jwt = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: 4102444800, role: 'authenticated' })).toString('base64url')}.synthetic`;
  const session = { access_token: jwt, refresh_token: 'synthetic-refresh', expires_in: 3600, expires_at: 4102444800, token_type: 'bearer', user };
  if (role !== 'anonymous') await page.addInitScript((session) => localStorage.setItem('sb-medis-test-auth-token', JSON.stringify(session)), session);

  const state = { requests: [], failDelete: false, failAppointments: false, failSearch: false, ...options };
  const at = new Date().toISOString();
  const draft = { id: DRAFT, visit_id: 'MEDIS-V-000001', patient_id: PATIENT, doctor_id: DOCTOR, consultation_date: at, updated_at: at, status: 'pending', profiles: patient, complaints: {} };
  const finalized = { id: FINAL, visit_id: 'MEDIS-V-000002', patient_id: PATIENT, doctor_id: DOCTOR, consultation_date: '2026-01-10T10:00:00Z', status: 'completed', profiles: patient, final_diagnosis: 'Synthetic diagnosis', complaints: {}, vitals: {}, observations: {} };
  state.consultations = [draft, finalized];
  state.notifications = [{ id: 'note-1', user_id: profile.id, type: 'appointment', title: 'Appointment scheduled', body: 'Synthetic appointment information', is_read: false, created_at: at }];
  const documents = [
    { id: 'ecg-doc', patient_id: PATIENT, file_name: 'synthetic-ecg.pdf', file_url: `${PATIENT}/synthetic-ecg.pdf`, category: 'ecg', report_date: '2026-01-10', uploaded_at: at, uploaded_by: DOCTOR, hospitals: hospitals[0], review_status: 'pending_review', file_size_bytes: 245760 },
    { id: 'lab-doc', patient_id: PATIENT, file_name: 'synthetic-lab.pdf', file_url: `${PATIENT}/synthetic-lab.pdf`, category: 'blood_report', report_date: '2026-01-10', uploaded_at: at, uploaded_by: DOCTOR, hospitals: hospitals[0], review_status: 'reviewed', file_size_bytes: 102400 },
    { id: 'own-doc', patient_id: PATIENT, file_name: 'synthetic-scan.pdf', file_url: `${PATIENT}/synthetic-scan.pdf`, category: 'ct_scan', report_date: '2026-02-01', uploaded_at: at, uploaded_by: PATIENT, hospitals: hospitals[0], review_status: 'pending_review', file_size_bytes: 1048576 },
  ];
  state.documents = documents;

  // Enough visits that the panel must scroll, with long text on one of them.
  const longText = 'Extended clinical narrative. '.repeat(40);
  state.visits = [
    { consultation_id: DRAFT, visit_id: 'MEDIS-V-000001', consultation_date: at, status: 'pending', doctor_id: DOCTOR, doctor_name: doctor.full_name, doctor_display_id: doctor.display_id, specialization: 'Cardiology', hospital_name: hospitals[0].name, is_shared_with_patient: false, reason: null, final_diagnosis: null, doctor_notes: null, follow_up_date: null, prescription_count: 0, document_count: 0 },
    { consultation_id: FINAL, visit_id: 'MEDIS-V-000002', consultation_date: '2026-01-10T10:00:00Z', status: 'completed', doctor_id: DOCTOR, doctor_name: doctor.full_name, doctor_display_id: doctor.display_id, specialization: 'Cardiology', hospital_name: hospitals[0].name, is_shared_with_patient: true, reason: 'Synthetic chest discomfort', final_diagnosis: 'Synthetic diagnosis', doctor_notes: longText, follow_up_date: '2026-02-10', prescription_count: 1, document_count: 1 },
    ...Array.from({ length: 12 }, (_, i) => ({
      consultation_id: `visit-${i}`, visit_id: `MEDIS-V-0001${String(i).padStart(2, '0')}`,
      consultation_date: new Date(Date.UTC(2025, i, 5, 9, 30)).toISOString(), status: 'completed',
      doctor_id: DOCTOR, doctor_name: doctor.full_name, doctor_display_id: doctor.display_id,
      specialization: 'Cardiology', hospital_name: hospitals[0].name, is_shared_with_patient: true,
      reason: `Synthetic routine review ${i}`, final_diagnosis: `Synthetic follow-up finding ${i}`,
      doctor_notes: longText, follow_up_date: null, prescription_count: 0, document_count: 0,
    })),
  ];

  state.accessEvents = [
    { event_id: 'event-1', doctor_id: DOCTOR, doctor_name: doctor.full_name, doctor_display_id: doctor.display_id, specialization: 'Cardiology', hospital_name: hospitals[0].name, action: 'opened_patient_record', access_type: 'Record opened', accessed_at: at, metadata: { source: 'search' }, total_count: 2 },
    { event_id: 'event-2', doctor_id: DOCTOR, doctor_name: doctor.full_name, doctor_display_id: doctor.display_id, specialization: 'Cardiology', hospital_name: hospitals[0].name, action: 'viewed_document', access_type: 'Document view', accessed_at: '2026-01-10T10:05:00Z', metadata: { file_name: 'synthetic-lab.pdf' }, total_count: 2 },
  ];
  const assessment = { id: 'assessment-1', patient_id: PATIENT, requested_by: DOCTOR, review_priority: 'REVIEW', profiles: doctor, created_at: at, report: { review_priority: 'REVIEW', overall_assessment: 'Synthetic review result', coverage: { valid_visits: 2 }, as_of: '2026-11-04', engine_version: 'synthetic', clinical_flags: [], metric_trajectories: {
    systolic_bp: { count: 2, unit: 'mmHg', delta: 20, percent_change: 16.7, direction: 'INCREASING', points: [
      { date: '2026-01-10', value: 120, evidence: [{ visit_id: 'MEDIS-V-000002', hospital: 'Test Hospital' }] },
      { date: '2026-02-10', value: null, evidence: [] },
      { date: '2026-03-10', value: 140, evidence: [{ visit_id: 'MEDIS-V-000003', hospital: 'Test Hospital' }] },
    ] },
  } } };
  state.assessment = assessment;

  await page.route('https://medis-test.supabase.co/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const name = url.pathname.split('/').at(-1);
    let body;
    try { body = request.postDataJSON(); } catch { body = null; }
    state.requests.push({ name, method, body, search: url.search });
    const send = (data, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data), headers });
    if (url.pathname.includes('/auth/v1/')) {
      if (name === 'signup') return send({ user, session: null });
      if (name === 'token') return state.failLogin ? send({ msg: 'Invalid login credentials' }, 400) : send(session);
      return send(user);
    }
    if (url.pathname.includes('/storage/v1/')) return send({ signedURL: '/object/sign/medical-reports/synthetic.pdf?token=synthetic' });
    if (name === 'delete_own_draft') {
      if (state.failDelete) return send({ code: '42501', message: 'Draft deletion rejected' }, 403);
      const id = body.p_consultation_id;
      if (!state.consultations.some((d) => d.id === id && d.status === 'pending' && d.doctor_id === profile.id)) return send({ code: '42501', message: 'Forbidden' }, 403);
      state.consultations = state.consultations.filter((d) => d.id !== id);
      return send(id);
    }
    if (name === 'search_patient_by_display_id') return state.failSearch ? send({ message: 'Search unavailable' }, 500) : send(body.p_display_id === patient.display_id ? [{ patient_id: PATIENT, ...patient }] : []);
    if (name === 'get_patient_visits') {
      // Only the visits that still exist as consultations, so deleting a
      // draft removes it from the timeline too.
      const live = new Set(state.consultations.map((c) => c.id));
      return send(state.visits.filter((v) => !v.consultation_id.startsWith('visit-') ? live.has(v.consultation_id) : true));
    }
    if (name === 'get_patient_access_history') return send([]);
    if (name === 'log_patient_access') {
      if (state.failAccessLog) return send({ code: '42501', message: 'Not authorized to access this patient record.' }, 403);
      state.accessLogs = [...(state.accessLogs ?? []), body];
      return send(null, 204);
    }
    if (name === 'get_patient_access_events') {
      if (state.failAccessEvents) return send({ message: 'Access history unavailable' }, 500);
      const search = (body?.p_search ?? '').toLowerCase();
      const matched = state.accessEvents.filter((e) => !search || (e.doctor_name + e.doctor_display_id).toLowerCase().includes(search));
      return send(matched.map((e) => ({ ...e, total_count: matched.length })));
    }
    if (name === 'get_patient_visit_details') {
      const visit = state.visits.find((v) => v.consultation_id === body.p_consultation_id);
      if (!visit) return send({ message: 'Visit not found' }, 403);
      return send({
        consultation_id: visit.consultation_id, visit_id: visit.visit_id, consultation_date: visit.consultation_date,
        status: visit.status, is_shared_with_patient: visit.is_shared_with_patient, is_visible: visit.is_shared_with_patient,
        follow_up_date: visit.follow_up_date,
        doctor: { doctor_id: DOCTOR, doctor_name: doctor.full_name, doctor_display_id: doctor.display_id, specialization: 'Cardiology', hospital_name: hospitals[0].name },
        reason: visit.reason, complaints: { main_complaint: visit.reason, chest_pain: 'typical' },
        observations: { heart_sounds: 'Synthetic normal' }, preliminary_diagnosis: null,
        final_diagnosis: visit.final_diagnosis, doctor_notes: visit.doctor_notes,
        prescriptions: visit.prescription_count ? [{ id: 'rx-1', issued_at: at, doctor_name: doctor.full_name, instructions: 'Synthetic instructions', medicines: [{ name: 'Synthetic medicine', dosage: '5 mg', frequency: 'Once daily', duration: '7 days' }] }] : [],
        documents: visit.document_count ? [{ id: 'lab-doc', file_name: 'synthetic-lab.pdf', file_url: `${PATIENT}/synthetic-lab.pdf`, category: 'blood_report', report_date: '2026-01-10', uploaded_at: at }] : [],
      });
    }
    if (name === 'delete_medical_report') {
      const doc = state.documents.find((d) => d.id === body.p_report_id);
      if (!doc || doc.uploaded_by !== profile.id) return send({ code: '42501', message: 'Only the account that uploaded this document can delete it.' }, 403);
      state.documents = state.documents.filter((d) => d.id !== doc.id);
      return send(doc.file_url);
    }

    let rows = [];
    switch (name) {
      case 'profiles': rows = [url.searchParams.get('id') === `eq.${PATIENT}` ? patient : profile]; break;
      case 'hospitals': rows = hospitals; break;
      case 'doctor_profiles': rows = [doctorDetails]; break;
      case 'doctor_patient_assignments': rows = [{ doctor_id: DOCTOR, patient_id: PATIENT, is_active: true, assigned_at: at, profiles: patient }]; break;
      case 'patient_profiles': rows = [{ id: PATIENT, blood_group: 'O+', height_cm: 175, weight_kg: 75, known_conditions: {}, allergies: 'Synthetic allergy' }]; break;
      case 'cad_assessments': rows = [state.assessment]; break;
      case 'medical_reports': rows = state.documents; break;
      case 'consultations': rows = state.consultations.filter((d) => !url.searchParams.get('status') || url.searchParams.get('status') === `eq.${d.status}` || (url.searchParams.get('status') === 'neq.pending' && d.status !== 'pending')); if (url.searchParams.get('id')) rows = rows.filter((d) => url.searchParams.get('id') === `eq.${d.id}`); break;
      case 'prescriptions': rows = [{ id: 'rx-1', consultation_id: FINAL, patient_id: PATIENT, issued_at: at, profiles: doctor, doctor, consultations: { visit_id: 'MEDIS-V-000002' }, medicines: [{ name: 'Synthetic medicine', dosage: '5 mg', frequency: 'Once daily', duration: '7 days' }], instructions: 'Synthetic instructions' }]; break;
      case 'appointments':
        if (state.failAppointments) return send({ message: 'Appointments unavailable' }, 500);
        rows = [{ id: 'upcoming-1', doctor_id: DOCTOR, patient_id: PATIENT, scheduled_at: new Date(Date.now() + 86400000).toISOString(), duration_minutes: 30, status: 'scheduled', profiles: doctor, reason: 'Synthetic follow-up' }, { id: 'past-1', doctor_id: DOCTOR, patient_id: PATIENT, scheduled_at: '2025-01-01T10:00:00Z', duration_minutes: 30, status: 'completed', profiles: doctor, reason: 'Synthetic previous visit' }]; break;
      case 'ecg_analyses': rows = [{ id: 'ecg-1', patient_id: PATIENT, document_id: 'ecg-doc', created_at: at, file_name: 'synthetic-ecg.pdf', status: 'blocked', classification: null, result: { status: 'blocked', input_format: 'pdf', blocked_reason: 'Printout classification is not validated.' } }]; break;
      case 'audit_logs': rows = [{ target_id: PATIENT, metadata: { source: 'search' }, created_at: at }]; break;
      case 'notifications':
        if (method === 'PATCH') state.notifications = state.notifications.map((n) => ({ ...n, is_read: true }));
        rows = state.notifications.filter((n) => url.searchParams.get('is_read') !== 'eq.false' || !n.is_read); break;
    }
    if (method === 'HEAD') return route.fulfill({ status: 200, headers: { 'content-range': `*/${rows.length}`, 'access-control-expose-headers': 'content-range' } });
    if (method === 'POST' || method === 'PATCH') {
      if (!request.headers().prefer?.includes('return=representation')) return send(null, 201);
    }
    if (request.headers().accept?.includes('vnd.pgrst.object')) return send(rows[0] ?? null);
    return send(rows);
  });
  await page.route('http://127.0.0.1:5181/**', async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    state.requests.push({ name: new URL(request.url()).pathname, method: request.method(), body });
    const result = request.url().includes('/longitudinal/')
      ? { assessment_id: 'assessment-2', report: state.assessment.report, pce: body?.pce_inputs ? { status: body.pce_inputs.known_ascvd ? 'NOT_APPLICABLE' : 'CALCULATED', risk_percent: body.pce_inputs.known_ascvd ? null : 8.2, category: 'INTERMEDIATE', reason: body.pce_inputs.known_ascvd ? 'Not applicable: patient has known ASCVD.' : '' } : null }
      : request.url().includes('/extract-report/') ? { fields: [{ column: 'ldl_cholesterol', value: 120, unit: 'mg/dL', source_text: 'Synthetic LDL 120' }] }
        : { analysis: { status: 'blocked', classification: null, created_at: at }, result: { status: 'blocked', input_format: 'pdf' } };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
  });
  return state;
}
