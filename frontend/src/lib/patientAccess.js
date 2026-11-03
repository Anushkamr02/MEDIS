import { supabase } from './supabaseClient';

/**
 * Grants this doctor access to a patient's record (creates the
 * doctor_patient_assignments row every medical-table RLS policy checks)
 * and logs it. Used when opening a patient from search or from an
 * appointment. Re-opening a patient already assigned is a no-op.
 */
export async function openPatientRecord(doctorId, patientId, source, metadata = {}) {
  const { error } = await supabase.from('doctor_patient_assignments').upsert(
    { doctor_id: doctorId, patient_id: patientId, is_active: true },
    { onConflict: 'doctor_id,patient_id', ignoreDuplicates: true }
  );
  if (error) return { error };

  await supabase.from('audit_logs').insert({
    user_id: doctorId,
    action: 'opened_patient_record',
    target_id: patientId,
    target_type: 'patient',
    metadata: { source, ...metadata },
  });

  return { error: null };
}

// "Now" = from 15 minutes before the slot until the slot ends
export function isAppointmentNow(appointment, now = new Date()) {
  const start = new Date(appointment.scheduled_at).getTime();
  const end = start + (appointment.duration_minutes ?? 30) * 60000;
  return now.getTime() >= start - 15 * 60000 && now.getTime() <= end;
}

// Still worth showing as "upcoming": hasn't ended more than 30 minutes ago
export function isAppointmentOpen(appointment, now = new Date()) {
  const start = new Date(appointment.scheduled_at).getTime();
  const end = start + (appointment.duration_minutes ?? 30) * 60000;
  return appointment.status === 'scheduled' && now.getTime() <= end + 30 * 60000;
}

/**
 * Opens a file from the private medical-reports bucket in a new tab
 * via a short-lived signed URL. The tab is opened synchronously so
 * popup blockers allow it, then pointed at the URL.
 */
export async function openStoredDocument(path) {
  const tab = window.open('', '_blank');
  const { data, error } = await supabase.storage
    .from('medical-reports')
    .createSignedUrl(path, 60);

  if (error || !data?.signedUrl) {
    tab?.close();
    return { error: error?.message ?? 'Could not open this document.' };
  }
  if (tab) tab.location.href = data.signedUrl;
  return { error: null };
}
