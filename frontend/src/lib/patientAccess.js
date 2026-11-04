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

  await logPatientAccess(patientId, 'opened_patient_record', { source, ...metadata });

  return { error: null };
}

/**
 * Records one access event against a patient's record.
 *
 * Goes through the log_patient_access() function (migration v8) rather
 * than inserting into audit_logs directly: the database sets the
 * timestamp and the actor, checks that this caller really has access to
 * the patient, and rejects any action outside its whitelist. The patient
 * then sees the event in their access history.
 *
 * Logging is a side effect of an action the user already performed, so a
 * failure is reported to the console and never blocks that action.
 */
export async function logPatientAccess(patientId, action, metadata = null) {
  if (!patientId || !action) return { error: 'Nothing to log' };
  const { error } = await supabase.rpc('log_patient_access', {
    p_patient_id: patientId,
    p_action: action,
    p_metadata: metadata,
  });
  if (error) console.warn(`Could not record "${action}" access:`, error.message);
  return { error: error?.message ?? null };
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

/**
 * Downloads a file from the private medical-reports bucket through a
 * short-lived signed URL with a download disposition, so the browser
 * saves it under its original name instead of rendering it.
 */
export async function downloadStoredDocument(path, fileName) {
  const { data, error } = await supabase.storage
    .from('medical-reports')
    .createSignedUrl(path, 60, { download: fileName || true });

  if (error || !data?.signedUrl) {
    return { error: error?.message ?? 'Could not download this document.' };
  }

  const link = document.createElement('a');
  link.href = data.signedUrl;
  link.download = fileName || '';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  return { error: null };
}
