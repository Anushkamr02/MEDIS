import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { isMissingColumn } from '../lib/dashboardCompatibility';
import { REVIEWED_EVENT } from '../lib/findingReview';

/**
 * Patients this doctor currently has access to (active assignment rows),
 * newest first, with the patient's basic identity joined in.
 */
export function useAssignedPatients(doctorId) {
  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchPatients = useCallback(async () => {
    if (!doctorId) return;
    setLoading(true);
    setError(null);

    const { data, error: fetchError } = await supabase
      .from('doctor_patient_assignments')
      .select('patient_id, assigned_at, profiles:patient_id(full_name, display_id, gender, date_of_birth, phone)')
      .eq('doctor_id', doctorId)
      .eq('is_active', true)
      .order('assigned_at', { ascending: false });

    if (fetchError) setError(fetchError.message);
    setPatients(data ?? []);
    setLoading(false);
  }, [doctorId]);

  useEffect(() => {
    fetchPatients();
  }, [fetchPatients]);

  return { patients, loading, error, refresh: fetchPatients };
}

/**
 * This doctor's access requests that are not (or no longer) granted:
 * pending, declined or revoked, newest first. Empty on a database
 * without migration v11, where opening a record grants access at once.
 */
export function useAccessRequests(doctorId) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchRequests = useCallback(async () => {
    if (!doctorId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('doctor_patient_assignments')
      .select('patient_id, access_status, requested_at, responded_at, revoked_at, profiles:patient_id(full_name, display_id)')
      .eq('doctor_id', doctorId)
      .in('access_status', ['pending', 'denied', 'revoked'])
      .order('requested_at', { ascending: false, nullsFirst: false });
    setRequests(error ? [] : data ?? []);
    setLoading(false);
  }, [doctorId]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  return { requests, loading, refresh: fetchRequests };
}

/**
 * Latest AI screening result per patient: { [patientId]: { review_priority,
 * health_trend, reasons, created_at } }. Only the newest assessment counts, so a patient whose
 * latest run found no concern is not listed as critical for an older run.
 * RLS limits cad_assessments to patients assigned to this doctor.
 * `monitoring` is false on a database without migration v12 (no trend yet).
 */
export function useLatestPriorities(patientIds) {
  const [latest, setLatest] = useState({});
  const [loading, setLoading] = useState(true);
  const [monitoring, setMonitoring] = useState(true);
  const [version, setVersion] = useState(0);
  const key = [...patientIds].sort().join(',');

  useEffect(() => {
    if (!key) {
      setLatest({});
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const query = (columns) => supabase
      .from('cad_assessments')
      .select(columns)
      .in('patient_id', key.split(','))
      .order('created_at', { ascending: false })
      .limit(1000);
    (async () => {
      let result = await query(
        'id, patient_id, review_priority, created_at, health_trend, trigger_event, reasons:monitoring->reasons, treatments:monitoring->treatment_responses'
      );
      const legacy = isMissingColumn(result.error);
      if (legacy) result = await query('id, patient_id, review_priority, created_at');
      if (cancelled) return;
      const byPatient = {};
      for (const row of result.data ?? []) byPatient[row.patient_id] ??= row; // newest first
      setMonitoring(!legacy);
      setLatest(byPatient);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [key, version]);

  return { latest, loading, monitoring, refresh: useCallback(() => setVersion((v) => v + 1), []) };
}

/**
 * Patients the database queued for a re-check (migration v12) that are due now.
 * RLS limits monitoring_queue to this doctor's patients; empty without v12.
 */
export function useDueQueue(doctorId) {
  const [patientIds, setPatientIds] = useState([]);

  const fetchQueue = useCallback(async () => {
    if (!doctorId) return;
    const { data, error } = await supabase
      .from('monitoring_queue')
      .select('patient_id')
      .is('processed_at', null)
      .lte('due_at', new Date().toISOString())
      .limit(200);
    setPatientIds(error ? [] : [...new Set((data ?? []).map((r) => r.patient_id))]);
  }, [doctorId]);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  return { patientIds, refresh: fetchQueue };
}

/**
 * Inputs for the Overview's "Needs review" list (migration v13): the ids of
 * findings that already have a review, and each patient's latest ECG.
 * `available` is false on a database without v13. Reloads after any review.
 */
export function useFindingReviews(patientIds) {
  const [state, setState] = useState({ available: false, reviewed: new Set(), ecgs: {} });
  const [version, setVersion] = useState(0);
  const key = [...patientIds].sort().join(',');

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(REVIEWED_EVENT, bump);
    return () => window.removeEventListener(REVIEWED_EVENT, bump);
  }, []);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const ids = key.split(',');
    (async () => {
      const [reviews, ecgs] = await Promise.all([
        supabase.from('finding_reviews').select('assessment_id, ecg_analysis_id').in('patient_id', ids).limit(1000),
        supabase
          .from('ecg_analyses')
          .select('id, patient_id, created_at, status, classification, intervals:result->cardiac_intervals, valid:result->validation->overall_valid')
          .in('patient_id', ids)
          .order('created_at', { ascending: false })
          .limit(1000),
      ]);
      if (cancelled) return;
      const latestEcg = {};
      for (const r of ecgs.data ?? []) {
        latestEcg[r.patient_id] ??= { ...r, result: { cardiac_intervals: r.intervals ?? {}, validation: { overall_valid: r.valid } } };
      }
      setState({
        available: !reviews.error,
        reviewed: new Set((reviews.data ?? []).flatMap((r) => [r.assessment_id, r.ecg_analysis_id]).filter(Boolean)),
        ecgs: latestEcg,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [key, version]);

  return state;
}

/**
 * Escalation steps for urgent findings of these patients (migration v15),
 * newest first. RLS limits them to patients this doctor has access to;
 * empty without v15. Reloads after any review, which stops escalation.
 */
export function useEscalations(patientIds) {
  const [events, setEvents] = useState([]);
  const [version, setVersion] = useState(0);
  const key = [...patientIds].sort().join(',');

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(REVIEWED_EVENT, bump);
    return () => window.removeEventListener(REVIEWED_EVENT, bump);
  }, []);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    supabase
      .from('escalation_events')
      .select('id, patient_id, assessment_id, ecg_analysis_id, level, reason, finding_at, created_at')
      .in('patient_id', key.split(','))
      .order('created_at', { ascending: false })
      .limit(500)
      .then(({ data, error }) => !cancelled && setEvents(error ? [] : data ?? []));
    return () => {
      cancelled = true;
    };
  }, [key, version]);

  return events;
}

/**
 * Everything the doctor's "360 view" of one patient needs. RLS decides
 * what comes back: if the doctor has no active assignment for this
 * patient, `profile` is null and every list is empty.
 *
 * `visits` and `accessHistory` come from RPCs (migration v3f) and span
 * every doctor and hospital, not just the logged-in doctor.
 */
export function usePatientRecord(patientId) {
  const [record, setRecord] = useState({
    profile: null,
    details: null,
    medications: [],
    history: [],
    familyHistory: [],
    visits: [],
    accessHistory: [],
    prescriptions: [],
    documents: [],
    hospitals: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchAll = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);

    try {
      const [
        profileRes,
        detailsRes,
        medsRes,
        historyRes,
        familyRes,
        visitsRes,
        accessRes,
        rxRes,
        docsRes,
        hospitalsRes,
      ] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, full_name, display_id, email, phone, gender, date_of_birth')
          .eq('id', patientId)
          .maybeSingle(),
        supabase.from('patient_profiles').select('*').eq('id', patientId).maybeSingle(),
        supabase
          .from('current_medications')
          .select('*')
          .eq('patient_id', patientId)
          .eq('is_active', true)
          .order('created_at', { ascending: false }),
        supabase
          .from('patient_medical_history')
          .select('*')
          .eq('patient_id', patientId)
          .order('diagnosed_at', { ascending: false }),
        supabase
          .from('family_history')
          .select('*')
          .eq('patient_id', patientId)
          .order('created_at', { ascending: false }),
        supabase.rpc('get_patient_visits', { p_patient_id: patientId }),
        supabase.rpc('get_patient_access_history', { p_patient_id: patientId }),
        supabase
          .from('prescriptions')
          .select('id, consultation_id, doctor_id, medicines, instructions, issued_at, doctor:doctor_id(full_name), consultations(visit_id)')
          .eq('patient_id', patientId)
          .order('issued_at', { ascending: false }),
        supabase
          .from('medical_reports')
          .select('*, hospitals(name)')
          .eq('patient_id', patientId)
          .order('uploaded_at', { ascending: false }),
        supabase.from('hospitals').select('id, name, city').order('name'),
      ]);

      // No profile row means no access; the RPCs then raise "Not authorized",
      // which is expected, not a load error worth showing.
      const hasAccess = !!profileRes.data;
      const firstError =
        profileRes.error ||
        detailsRes.error ||
        medsRes.error ||
        historyRes.error ||
        familyRes.error ||
        (hasAccess && visitsRes.error) ||
        (hasAccess && accessRes.error) ||
        rxRes.error ||
        docsRes.error ||
        hospitalsRes.error;
      if (firstError) setError(firstError.message);

      setRecord({
        profile: profileRes.data ?? null,
        details: detailsRes.data ?? null,
        medications: medsRes.data ?? [],
        history: historyRes.data ?? [],
        familyHistory: familyRes.data ?? [],
        visits: visitsRes.data ?? [],
        accessHistory: accessRes.data ?? [],
        prescriptions: rxRes.data ?? [],
        documents: docsRes.data ?? [],
        hospitals: hospitalsRes.data ?? [],
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  return { ...record, loading, error, refresh: fetchAll };
}
