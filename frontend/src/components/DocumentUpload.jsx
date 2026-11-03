import { useEffect, useState } from 'react';
import { ExternalLink, FileText, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../lib/supabaseClient';
import { openStoredDocument } from '../lib/patientAccess';
import { formatDate } from '../lib/format';
import { Button, Input, Label, SimpleSelect } from './ui';
import { EmptyState, StatusPill } from './medis';

const CATEGORIES = [
  { value: 'ecg', label: 'ECG' },
  { value: 'blood_report', label: 'Blood Report' },
  { value: 'lipid_profile', label: 'Lipid Profile' },
  { value: 'hba1c', label: 'HbA1c' },
  { value: 'prescription', label: 'Previous Prescription' },
  { value: 'ct_scan', label: 'CT Scan' },
  { value: 'mri', label: 'MRI' },
  { value: 'xray', label: 'X-ray' },
  { value: 'cardiac_report', label: 'Cardiac Report (2D Echo, TMT, etc.)' },
  { value: 'discharge_summary', label: 'Discharge Summary' },
  { value: 'medical_history', label: 'Medical History' },
  { value: 'other', label: 'Other' },
];

// medical_reports.review_status -> StatusPill value
const REVIEW_PILL = {
  pending_review: 'pending review',
  reviewed: 'reviewed',
  verified: 'verified',
  requires_clarification: 'needs clarification',
};

export function categoryLabel(value) {
  return CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

/**
 * Document upload form + list. Files go to Supabase Storage under
 * <patient_id>/<timestamp>-<filename>, then a matching row is written
 * to medical_reports so it shows up for both the patient and any
 * doctor who gains access to this patient's record.
 *
 * Patient upload: omit doctorId — lands as "Pending review".
 * Doctor upload: pass doctorId (and optionally consultationId to link
 * it to a visit) — lands as "Verified" by that doctor.
 */
export default function DocumentUpload({
  patientId,
  documents = [],
  hospitals,
  onUploaded,
  doctorId,
  consultationId,
  defaultHospitalId = '',
  showForm = true,
  showList = true,
  renderExtra, // optional (doc) => element shown under a document (AI actions)
}) {
  const [category, setCategory] = useState('');
  const [hospitalId, setHospitalId] = useState(defaultHospitalId);
  const [doctorNameNote, setDoctorNameNote] = useState('');
  const [reportDate, setReportDate] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  // The doctor's hospital may load after this form first renders
  useEffect(() => {
    if (defaultHospitalId) setHospitalId((prev) => prev || defaultHospitalId);
  }, [defaultHospitalId]);

  function resetForm() {
    setCategory('');
    setHospitalId(defaultHospitalId);
    setDoctorNameNote('');
    setReportDate('');
    setDescription('');
    setFile(null);
    setFileInputKey((k) => k + 1); // clears the native file input
  }

  async function handleUpload(e) {
    e.preventDefault();
    setError('');

    if (!category || !file) {
      setError('Choose a report type and a file.');
      return;
    }
    // Some browsers report no type for phone photos (HEIC), so the extension also counts
    if (!/pdf|image/.test(file.type) && !/\.(pdf|heic|heif|webp|png|jpe?g|gif|bmp|tiff?)$/i.test(file.name)) {
      setError('Only PDF or image files are allowed.');
      return;
    }

    setUploading(true);

    const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const path = `${patientId}/${Date.now()}-${safeName}`;

    const { error: storageError } = await supabase.storage.from('medical-reports').upload(path, file);

    if (storageError) {
      setError(storageError.message);
      setUploading(false);
      return;
    }

    const fileType = file.type === 'application/pdf' ? 'pdf' : 'image';

    const row = {
      patient_id: patientId,
      uploaded_by: doctorId ?? patientId,
      file_name: file.name,
      file_url: path, // storage path; resolved to a signed URL when viewing
      file_type: fileType,
      category,
      hospital_id: hospitalId || null,
      doctor_name_note: doctorNameNote || null,
      report_date: reportDate || null,
      description: description || null,
      ocr_status: 'pending',
      review_status: doctorId ? 'verified' : 'pending_review',
      reviewing_doctor_id: doctorId ?? null,
      is_verified: !!doctorId,
    };
    if (consultationId) row.consultation_id = consultationId;

    const { error: insertError } = await supabase.from('medical_reports').insert(row);

    setUploading(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    if (doctorId) {
      supabase.from('audit_logs').insert({
        user_id: doctorId,
        action: 'uploaded_report',
        target_id: patientId,
        target_type: 'patient',
        metadata: { category, consultation_id: consultationId ?? null },
      });
    }

    resetForm();
    toast.success('Report uploaded');
    onUploaded?.();
  }

  async function viewDocument(doc) {
    const { error: openError } = await openStoredDocument(doc.file_url);
    if (openError) toast.error(openError);
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      {showForm && (
        <form onSubmit={handleUpload} className="grid gap-3 rounded-lg border bg-muted/30 p-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Report type</Label>
            <SimpleSelect value={category} onChange={setCategory} placeholder="Select type" options={CATEGORIES.map((c) => [c.value, c.label])} />
          </div>
          <div className="space-y-1">
            <Label>Hospital (optional)</Label>
            <SimpleSelect value={hospitalId} onChange={setHospitalId} placeholder="Select hospital" options={hospitals.map((h) => [h.id, h.name])} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`rd-${patientId}`}>Report date</Label>
            <Input id={`rd-${patientId}`} type="date" value={reportDate} max={today} onChange={(e) => setReportDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`rf-${patientId}`}>File (PDF or image)</Label>
            <Input
              key={fileInputKey}
              id={`rf-${patientId}`}
              type="file"
              accept="application/pdf,image/*,.heic,.heif"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          {/* A doctor uploading is the doctor — the free-text name is for outside reports */}
          {!doctorId && (
            <div className="space-y-1">
              <Label htmlFor={`rdn-${patientId}`}>Doctor name (optional)</Label>
              <Input id={`rdn-${patientId}`} value={doctorNameNote} onChange={(e) => setDoctorNameNote(e.target.value)} />
            </div>
          )}
          <div className={doctorId ? 'space-y-1 sm:col-span-2' : 'space-y-1'}>
            <Label htmlFor={`rn-${patientId}`}>Note (optional)</Label>
            <Input id={`rn-${patientId}`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. fasting sample" />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">
              {error}
            </p>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={uploading}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Upload
            </Button>
          </div>
        </form>
      )}

      {showList &&
        (documents.length === 0 ? (
          <EmptyState text="No medical documents uploaded yet." />
        ) : (
          <ul className="space-y-2">
            {documents.map((d) => (
              <li key={d.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <FileText className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {categoryLabel(d.category)} <span className="font-normal text-muted-foreground">· {d.file_name}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {d.report_date ? formatDate(d.report_date) : formatDate(d.uploaded_at)}
                      {d.hospitals?.name && ` · ${d.hospitals.name}`}
                      {d.doctor_name_note && ` · ${d.doctor_name_note}`}
                      {d.description && ` · ${d.description}`}
                    </p>
                  </div>
                  <StatusPill value={REVIEW_PILL[d.review_status] ?? d.review_status} />
                  <Button size="sm" variant="ghost" onClick={() => viewDocument(d)}>
                    <ExternalLink className="h-3.5 w-3.5" />
                    View
                  </Button>
                </div>
                {renderExtra?.(d)}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
