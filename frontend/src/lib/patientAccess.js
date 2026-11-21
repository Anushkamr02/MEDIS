import { supabase } from './supabaseClient';
import { isMissingRpc } from './dashboardCompatibility';

// A database without migration v11 has no access_status column (42703)
// and none of the request functions (PGRST202). There, opening a record
// still grants access at once, as it did before.
export function isLegacyAccessSchema(error) {
  return isMissingRpc(error) || error?.code === '42703';
}

/**
 * Where this doctor stands with one patient: 'none', 'pending', 'active',
 * 'denied' or 'revoked'. Reads the doctor's own assignment row, which RLS
 * lets a doctor see. `legacy` is true when the database predates v11.
 */
export async function getAccessStatus(doctorId, patientId) {
  const { data, error } = await supabase
    .from('doctor_patient_assignments')
    .select('access_status, is_emergency, requested_at, responded_at, revoked_at, assigned_at')
    .eq('doctor_id', doctorId)
    .eq('patient_id', patientId)
    .maybeSingle();
  if (isLegacyAccessSchema(error)) return { status: 'none', row: null, legacy: true, error: null };
  if (error) return { status: 'none', row: null, legacy: false, error: error.message };
  return { status: data?.access_status ?? 'none', row: data, legacy: false, error: null };
}

/**
 * Opens a patient's record if this doctor has access, otherwise asks the
 * patient for it. Resolves to { status, error }: 'active' means the record
 * can be opened now (the access event is logged), 'pending' means the
 * patient has to approve first.
 *
 * Used when opening a patient from search or from an appointment.
 * `metadata.appointment_id` lets the database treat an appointment the
 * patient booked themself as consent, so that path still opens at once.
 */
export async function openPatientRecord(doctorId, patientId, source, metadata = {}) {
  return requestAccess(doctorId, patientId, source, metadata, { reason: null, emergency: false });
}

/**
 * Opens the record now, without the patient's approval. The reason is
 * required: the database stores it, shows it to the patient and marks
 * the access as emergency in their access history.
 */
export async function requestEmergencyAccess(doctorId, patientId, reason, metadata = {}) {
  return requestAccess(doctorId, patientId, 'emergency', metadata, { reason, emergency: true });
}

async function requestAccess(doctorId, patientId, source, metadata, { reason, emergency }) {
  const { data, error } = await supabase.rpc('request_patient_access', {
    p_patient_id: patientId,
    p_reason: reason,
    p_emergency: emergency,
    p_appointment_id: metadata.appointment_id ?? null,
  });

  let status = data;
  if (isMissingRpc(error)) {
    // Pre-v11 database: the upsert every medical-table RLS policy checks.
    const legacy = await supabase.from('doctor_patient_assignments').upsert(
      { doctor_id: doctorId, patient_id: patientId, is_active: true },
      { onConflict: 'doctor_id,patient_id', ignoreDuplicates: true }
    );
    if (legacy.error) return { status: null, error: legacy.error };
    status = 'active';
  } else if (error) {
    return { status: null, error };
  }

  if (status === 'active') {
    await logPatientAccess(patientId, 'opened_patient_record', { source, ...metadata });
  }
  return { status, error: null };
}

/** The patient's answer to a pending request. Resolves to { status, error }. */
export async function respondToAccessRequest(doctorId, approve) {
  const { data, error } = await supabase.rpc('respond_access_request', {
    p_doctor_id: doctorId,
    p_approve: approve,
  });
  return { status: data ?? null, error: error?.message ?? null };
}

/** Takes a doctor's access away. Their drafts and queries on this record stop working at once. */
export async function revokeDoctorAccess(doctorId) {
  const { error } = await supabase.rpc('revoke_doctor_access', { p_doctor_id: doctorId });
  return { error: error?.message ?? null };
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
