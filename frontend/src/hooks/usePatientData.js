import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

/**
 * Loads everything the patient dashboard needs for the logged-in patient.
 * Call `refresh()` after any write (e.g. after onboarding, or marking a
 * notification read) to re-pull fresh data without a full page reload.
 */
export function usePatientData(patientId) {
  const [data, setData] = useState({
    vitals: null,
    medications: [],
    history: [],
    prescriptions: [],
    appointments: [],
    notifications: [],
    documents: [],
    hospitals: [],
    visits: [],
    accessHistory: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchAll = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);

    try {
      const [
        vitalsRes,
        medsRes,
        historyRes,
        prescriptionsRes,
        appointmentsRes,
        notificationsRes,
        documentsRes,
        hospitalsRes,
        visitsRes,
        accessRes,
      ] = await Promise.all([
        supabase.from('patient_profiles').select('*').eq('id', patientId).maybeSingle(),
        supabase
          .from('current_medications')
          .select('*')
          .eq('patient_id', patientId)
          .eq('is_active', true)
          .order('created_at', { ascending: false }),
        // Only consultations the doctor has explicitly shared are visible —
        // enforced by RLS too, this select just matches that policy.
        supabase
          .from('consultations')
          .select('id, visit_id, disease_type, status, consultation_date, final_diagnosis, doctor_notes, doctor_id, profiles:doctor_id(full_name)')
          .eq('patient_id', patientId)
          .eq('is_shared_with_patient', true)
          .order('consultation_date', { ascending: false }),
        supabase
          .from('prescriptions')
          .select('id, medicines, instructions, issued_at, doctor_id, profiles:doctor_id(full_name)')
          .eq('patient_id', patientId)
          .order('issued_at', { ascending: false }),
        supabase
          .from('appointments')
          .select('id, scheduled_at, reason, status, doctor_id, profiles:doctor_id(full_name)')
          .eq('patient_id', patientId)
          .order('scheduled_at', { ascending: true }),
        supabase
          .from('notifications')
          .select('*')
          .eq('user_id', patientId)
          .order('created_at', { ascending: false })
          .limit(20),
        supabase
          .from('medical_reports')
          .select('*, hospitals(name)')
          .eq('patient_id', patientId)
          .order('uploaded_at', { ascending: false }),
        supabase.from('hospitals').select('id, name, city').order('name'),
        // Every visit across doctors/hospitals (diagnosis only if shared),
        // and every doctor who has accessed this record — migration v3f.
        supabase.rpc('get_patient_visits', { p_patient_id: patientId }),
        supabase.rpc('get_patient_access_history', { p_patient_id: patientId }),
      ]);

      // Surface the first error found, but still show whatever did load
      const firstError =
        vitalsRes.error ||
        medsRes.error ||
        historyRes.error ||
        prescriptionsRes.error ||
        appointmentsRes.error ||
        notificationsRes.error ||
        documentsRes.error ||
        hospitalsRes.error ||
        visitsRes.error ||
        accessRes.error;
      if (firstError) setError(firstError.message);

      setData({
        vitals: vitalsRes.data ?? null,
        medications: medsRes.data ?? [],
        history: historyRes.data ?? [],
        prescriptions: prescriptionsRes.data ?? [],
        appointments: appointmentsRes.data ?? [],
        notifications: notificationsRes.data ?? [],
        documents: documentsRes.data ?? [],
        hospitals: hospitalsRes.data ?? [],
        visits: visitsRes.data ?? [],
        accessHistory: accessRes.data ?? [],
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

  return { ...data, loading, error, refresh: fetchAll };
}