import { formatDate } from '../lib/format';
import { EmptyState, IDChip, StatusPill, pillValue } from './medis';

/**
 * Chronological list of every visit for a patient, across all doctors
 * and hospitals (rows come from the get_patient_visits() RPC).
 *
 * viewer="doctor": rows are clickable (onOpen), own drafts are marked.
 * viewer="patient": read-only; unshared visits show no diagnosis.
 */
export default function VisitTimeline({ visits, viewer, currentUserId, onOpen }) {
  if (visits.length === 0) return <EmptyState text="No visits recorded yet." />;
  const patientView = viewer === 'patient';

  return (
    <ol className="relative space-y-3 border-l-2 border-primary/20 pl-5">
      {visits.map((v) => {
        const isDraft = v.status === 'pending';
        const isMine = v.doctor_id === currentUserId;
        const body = (
          <>
            <span className="absolute -left-[27px] top-3 h-3 w-3 rounded-full border-2 border-card bg-primary" />
            <div className="flex flex-wrap items-center gap-2">
              <IDChip id={v.visit_id} />
              <span className="text-sm font-medium">{formatDate(v.consultation_date)}</span>
              <StatusPill value={pillValue(v.status, 'visit')} />
              {!patientView && !isDraft && <StatusPill value={v.is_shared_with_patient ? 'shared with patient' : 'not shared'} />}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {v.hospital_name ?? '—'} · Dr. {v.doctor_name || '—'}
              {isMine && !patientView && ' (you)'}
            </p>
            <p className="mt-1 text-sm">
              {v.final_diagnosis ? (
                v.final_diagnosis
              ) : patientView && !isDraft ? (
                <span className="italic text-muted-foreground">Results not shared yet</span>
              ) : isDraft && isMine ? (
                <span className="text-muted-foreground">Unfinished draft. Click to resume.</span>
              ) : (
                <span className="text-muted-foreground">No diagnosis yet</span>
              )}
            </p>
          </>
        );
        return (
          <li key={v.consultation_id} id={`visit-${v.visit_id}`} className="relative scroll-mt-24">
            {onOpen && !patientView ? (
              <button className="w-full rounded-lg p-2 text-left transition-colors hover:bg-muted" onClick={() => onOpen(v)}>
                {body}
              </button>
            ) : (
              <div className="p-2">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
