import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../lib/supabaseClient';
import { loadVisitDetails } from '../lib/dashboardCompatibility';
import { openStoredDocument } from '../lib/patientAccess';
import { formatDate, formatDateTime, humanize } from '../lib/format';
import { Button } from './ui';
import { DetailsDialog, EmptyState, ErrorState, Field, IDChip, Spinner, StatusPill, pillValue } from './medis';
import { categoryLabel } from './DocumentUpload';

/** The complaint keys worth showing as "reason for visit" detail. */
const COMPLAINT_LABELS = {
  main_complaint: 'Main complaint',
  chest_pain: 'Chest pain',
  chest_pain_type: 'Chest pain type',
  chest_pain_duration: 'Duration',
  pain_location: 'Location',
  pain_severity: 'Severity',
  pain_radiation: 'Radiation',
  pain_at_rest: 'Pain at rest',
  syncope: 'Syncope',
  nyha_class: 'NYHA class',
  other_symptoms: 'Other symptoms',
};

function entriesOf(object, labels) {
  return Object.entries(object ?? {})
    .filter(([, value]) => value !== null && value !== undefined && value !== '' && value !== false)
    .map(([key, value]) => [labels?.[key] ?? humanize(key), value === true ? 'Yes' : String(value)]);
}

/**
 * One visit in full: the complete record of that consultation, loaded
 * through get_patient_visit_details(), or RLS-protected table queries on
 * older databases. A patient gets nothing clinical from a visit the
 * doctor has not shared, and never sees a draft.
 *
 * Used by the visit history panel on both the doctor and the patient
 * dashboard, so both show the same authorized record.
 */
export default function VisitDetails({ visit, open, onOpenChange, onViewDocument }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const consultationId = visit?.consultation_id;

  const load = useCallback(async () => {
    if (!consultationId) return;
    setLoading(true);
    setError('');
    const { data: row, error: rpcError } = await loadVisitDetails(supabase, visit);
    if (rpcError) {
      setError(rpcError.message);
      setData(null);
    } else {
      setData(row);
    }
    setLoading(false);
  }, [consultationId, visit]);

  useEffect(() => {
    if (open) load();
    else {
      setData(null);
      setError('');
    }
  }, [open, load]);

  async function viewDocument(doc) {
    if (onViewDocument) {
      await onViewDocument(doc);
      return;
    }
    const { error: openError } = await openStoredDocument(doc.file_url);
    if (openError) toast.error(openError);
  }

  const doctor = data?.doctor ?? {};
  const complaints = entriesOf(data?.complaints, COMPLAINT_LABELS).filter(([label]) => label !== 'Main complaint');
  const observations = entriesOf(data?.observations);
  const prescriptions = data?.prescriptions ?? [];
  const documents = data?.documents ?? [];

  return (
    <DetailsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Visit ${visit?.visit_id ?? ''}`}
      description={
        visit?.consultation_date
          ? `Recorded ${formatDateTime(visit.consultation_date)}. Everything this visit holds that you are allowed to see.`
          : 'Full record of this visit.'
      }
    >
      {loading && <Spinner text="Loading visit details..." />}
      {error && <ErrorState text={error} onRetry={load} />}
      {!loading && !error && data && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <IDChip id={data.visit_id} />
            <StatusPill value={pillValue(data.status, 'visit')} />
            {data.is_shared_with_patient && <StatusPill value="shared with patient" />}
          </div>

          <dl className="grid gap-3 sm:grid-cols-2">
            <Field label="Visit date and time" value={formatDateTime(data.consultation_date)} />
            <Field label="Doctor" value={doctor.doctor_name ? `Dr. ${doctor.doctor_name}` : null} />
            <Field label="Department / specialization" value={doctor.specialization} />
            <Field label="Hospital" value={doctor.hospital_name} />
            <Field label="Reason for visit" value={data.reason} />
            <Field label="Follow-up" value={data.follow_up_date ? `Review on ${formatDate(data.follow_up_date)}` : 'No follow-up recorded'} />
          </dl>

          {!data.is_visible && (
            <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
              Your doctor has not shared the clinical details of this visit yet. The visit date, doctor and hospital are shown above.
            </p>
          )}

          {data.is_visible && (
            <>
              <section>
                <h3 className="text-sm font-semibold">Diagnosis and clinical observations</h3>
                <dl className="mt-2 grid gap-3 sm:grid-cols-2">
                  <Field label="Final diagnosis" value={data.final_diagnosis} />
                  <Field label="Preliminary diagnosis" value={data.preliminary_diagnosis} />
                </dl>
                {data.doctor_notes && (
                  <p className="mt-2 text-sm">
                    <b className="font-medium">Doctor's notes:</b> <span className="text-muted-foreground">{data.doctor_notes}</span>
                  </p>
                )}
                {observations.length > 0 && (
                  <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                    {observations.map(([label, value]) => (
                      <Field key={label} label={label} value={value} />
                    ))}
                  </dl>
                )}
                {!data.final_diagnosis && !data.preliminary_diagnosis && !data.doctor_notes && observations.length === 0 && (
                  <p className="mt-2 text-sm text-muted-foreground">No diagnosis or observations recorded for this visit.</p>
                )}
              </section>

              {complaints.length > 0 && (
                <section>
                  <h3 className="text-sm font-semibold">Reported symptoms</h3>
                  <dl className="mt-2 grid gap-3 sm:grid-cols-2">
                    {complaints.map(([label, value]) => (
                      <Field key={label} label={label} value={value} />
                    ))}
                  </dl>
                </section>
              )}

              <section>
                <h3 className="text-sm font-semibold">Prescribed medications</h3>
                {prescriptions.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">No medication was prescribed at this visit.</p>
                ) : (
                  <div className="mt-2 space-y-2">
                    {prescriptions.map((rx) => (
                      <article key={rx.id} className="rounded-lg border p-3">
                        <p className="text-xs text-muted-foreground">
                          Issued {formatDate(rx.issued_at)}
                          {rx.doctor_name && ` · Dr. ${rx.doctor_name}`}
                        </p>
                        <ul className="mt-2 space-y-1.5">
                          {(rx.medicines ?? []).map((m, i) => (
                            <li key={i} className="rounded-md bg-muted/60 px-2.5 py-1.5 text-sm">
                              <span className="font-medium">
                                {m.name} {m.dosage}
                              </span>
                              <span className="text-muted-foreground">
                                {[m.frequency, m.duration ?? (m.duration_days && `${m.duration_days} days`), m.timing, m.notes]
                                  .filter(Boolean)
                                  .map((x) => ` · ${x}`)}
                              </span>
                            </li>
                          ))}
                        </ul>
                        {rx.instructions && <p className="mt-2 text-xs text-muted-foreground">{rx.instructions}</p>}
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}

          <section>
            <h3 className="text-sm font-semibold">Attached medical documents</h3>
            {documents.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No documents were attached to this visit.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {documents.map((doc) => (
                  <li key={doc.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5 text-sm">
                    <FileText className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0 flex-1 break-words">
                      {categoryLabel(doc.category)} <span className="text-muted-foreground">· {doc.file_name}</span>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => viewDocument(doc)}>
                      <ExternalLink className="h-3.5 w-3.5" />
                      View
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
      {!loading && !error && !data && <EmptyState text="This visit is no longer available." />}
    </DetailsDialog>
  );
}
