// Only a missing RPC permits a fallback. Permission and server failures must
// remain visible rather than being mistaken for an older database.
export function isMissingRpc(error) {
  return error?.code === 'PGRST202';
}

export async function loadVisitDetails(client, visit) {
  const result = await client.rpc('get_patient_visit_details', {
    p_consultation_id: visit.consultation_id,
  });
  if (!isMissingRpc(result.error)) return result;

  // These tables and relationships exist in v3f. Every query uses the
  // signed-in client's RLS policies; no privileged endpoint is involved.
  const auth = await client.auth.getUser();
  if (auth.error) return { data: null, error: auth.error };
  if (!auth.data?.user) return { data: null, error: { message: 'Sign in to view this visit.' } };
  const consultation = await client.from('consultations')
    .select('*').eq('id', visit.consultation_id).maybeSingle();
  if (consultation.error) return consultation;
  const row = consultation.data;
  // RLS can hide an unshared consultation while the timeline RPC still
  // exposes its date and doctor. Never copy clinical fields from the timeline.
  const visible = !!row && (row.patient_id !== auth.data.user.id || row.is_shared_with_patient === true);
  if ((row?.patient_id === auth.data.user.id || !row) && visit.status === 'pending') {
    return { data: null, error: { message: 'This visit is not available.' } };
  }
  const [prescriptions, documents] = await Promise.all([
    visible ? client.from('prescriptions')
      .select('id, issued_at, medicines, instructions, profiles:doctor_id(full_name)')
      .eq('consultation_id', visit.consultation_id).order('issued_at', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    client.from('medical_reports')
      .select('id, file_name, file_url, category, report_date, uploaded_at')
      .eq('consultation_id', visit.consultation_id).order('uploaded_at', { ascending: false }),
  ]);
  if (prescriptions.error || documents.error) return { data: null, error: prescriptions.error || documents.error };
  return { error: null, data: {
    consultation_id: visit.consultation_id,
    visit_id: visit.visit_id,
    consultation_date: visit.consultation_date,
    status: visit.status,
    is_shared_with_patient: row?.is_shared_with_patient ?? false,
    is_visible: visible,
    doctor: {
      doctor_id: visit.doctor_id, doctor_name: visit.doctor_name,
      doctor_display_id: visit.doctor_display_id,
      specialization: visit.specialization, hospital_name: visit.hospital_name,
    },
    ...(visible ? {
      reason: row.complaints?.main_complaint, complaints: row.complaints,
      observations: row.observations, final_diagnosis: row.final_diagnosis,
      preliminary_diagnosis: row.preliminary_diagnosis, doctor_notes: row.doctor_notes,
      follow_up_date: row.follow_up_date,
    } : {}),
    prescriptions: (prescriptions.data ?? []).map((rx) => ({ ...rx, doctor_name: rx.profiles?.full_name })),
    documents: documents.data ?? [],
  } };
}
