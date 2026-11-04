import { Building2, CalendarClock, FileText, Pill, Stethoscope } from 'lucide-react';
import { formatDate, formatDateTime } from '../lib/format';
import { Button } from './ui';
import { EmptyState, IDChip, StatusPill, pillValue } from './medis';

/**
 * Chronological list of every visit for a patient, across all doctors
 * and hospitals (rows come from the get_patient_visits() RPC).
 *
 * viewer="doctor": rows are clickable (onOpen), own drafts are marked.
 * viewer="patient": read-only; unshared visits show no clinical detail.
 *
 * `onViewDetails` adds the "View details" action that opens the full
 * record of the visit in a modal.
 */
export default function VisitTimeline({ visits, viewer, currentUserId, onOpen, onViewDetails, emptyText }) {
  if (visits.length === 0) return <EmptyState text={emptyText ?? 'No visits recorded yet.'} />;
  const patientView = viewer === 'patient';

  return (
    <ol className="relative space-y-3 border-l-2 border-primary/20 pl-5">
      {visits.map((v) => {
        const isDraft = v.status === 'pending';
        const isMine = v.doctor_id === currentUserId;
        return (
          <li key={v.consultation_id} id={`visit-${v.visit_id}`} className="relative min-w-0 scroll-mt-24">
            <span className="absolute -left-[27px] top-3 h-3 w-3 rounded-full border-2 border-card bg-primary" aria-hidden />
            <div className="min-w-0 rounded-lg p-2 transition-colors hover:bg-muted/60">
              <div className="flex flex-wrap items-center gap-2">
                <IDChip id={v.visit_id} />
                <span className="inline-flex items-center gap-1 text-sm font-medium">
                  <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  {formatDateTime(v.consultation_date)}
                </span>
                <StatusPill value={pillValue(v.status, 'visit')} />
                {!patientView && !isDraft && <StatusPill value={v.is_shared_with_patient ? 'shared with patient' : 'not shared'} />}
              </div>

              <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                <Stethoscope className="h-3 w-3 shrink-0" aria-hidden />
                <span className="break-words">
                  Dr. {v.doctor_name || '—'}
                  {isMine && !patientView && ' (you)'}
                </span>
                <span aria-hidden>·</span>
                <span className="break-words">{v.specialization || 'Department not recorded'}</span>
                <span aria-hidden>·</span>
                <Building2 className="h-3 w-3 shrink-0" aria-hidden />
                <span className="break-words">{v.hospital_name ?? '—'}</span>
              </p>

              {v.reason && (
                <p className="mt-1 break-words text-sm">
                  <span className="text-muted-foreground">Reason:</span> {v.reason}
                </p>
              )}

              <p className="mt-1 break-words text-sm">
                {v.final_diagnosis ? (
                  <>
                    <span className="text-muted-foreground">Diagnosis:</span> {v.final_diagnosis}
                  </>
                ) : patientView && !isDraft ? (
                  <span className="italic text-muted-foreground">Results not shared yet</span>
                ) : isDraft && isMine ? (
                  <span className="text-muted-foreground">Unfinished draft. Open it to resume.</span>
                ) : (
                  <span className="text-muted-foreground">No diagnosis yet</span>
                )}
              </p>

              {v.doctor_notes && <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{v.doctor_notes}</p>}

              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {v.prescription_count > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <Pill className="h-3 w-3" aria-hidden />
                    {v.prescription_count} prescription{v.prescription_count === 1 ? '' : 's'}
                  </span>
                )}
                {v.document_count > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <FileText className="h-3 w-3" aria-hidden />
                    {v.document_count} document{v.document_count === 1 ? '' : 's'}
                  </span>
                )}
                {v.follow_up_date && <span>Follow-up {formatDate(v.follow_up_date)}</span>}
              </div>

              {(onViewDetails || (onOpen && !patientView)) && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {onViewDetails && (
                    <Button size="sm" variant="outline" onClick={() => onViewDetails(v)}>
                      View details
                    </Button>
                  )}
                  {onOpen && !patientView && (
                    <Button size="sm" variant="ghost" onClick={() => onOpen(v)}>
                      {isDraft && isMine ? 'Resume consultation' : 'Open consultation'}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
