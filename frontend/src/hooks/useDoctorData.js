import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

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
 * Latest AI screening result per patient: { [patientId]: { review_priority,
 * created_at } }. Only the newest assessment counts, so a patient whose
 * latest run found no concern is not listed as critical for an older run.
 * RLS limits cad_assessments to patients assigned to this doctor.
 */
export function useLatestPriorities(patientIds) {
  const [latest, setLatest] = useState({});
  const [loading, setLoading] = useState(true);
  const key = [...patientIds].sort().join(',');

  useEffect(() => {
    if (!key) {
      setLatest({});
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    supabase
      .from('cad_assessments')
      .select('patient_id, review_priority, created_at')
      .in('patient_id', key.split(','))
      .order('created_at', { ascending: false })
      .limit(1000)
      .then(({ data }) => {
        if (cancelled) return;
        const byPatient = {};
        for (const row of data ?? []) byPatient[row.patient_id] ??= row; // newest first
        setLatest(byPatient);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return { latest, loading };
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
