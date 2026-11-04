import { Lock } from 'lucide-react';
import { formatDate } from '../lib/format';
import { EmptyState, IDChip } from './medis';

/**
 * Every doctor who has been granted access to a patient's record,
 * with when they first got access, when they last opened it, and how
 * many finalized visits they recorded (rows from the
 * get_patient_access_history() RPC). Shown to the patient and to
 * doctors, so record access is transparent.
 */
export default function AccessHistory({ rows, currentUserId }) {
  if (rows.length === 0) return <EmptyState text="No doctor has opened this record yet." />;

  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Lock className="h-3 w-3" />
        Doctors granted access, with their first access and latest recorded profile view.
      </p>
      <ul className="divide-y rounded-lg border">
        {rows.map((r) => (
          <li key={r.doctor_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
            <div>
              <p className="font-medium">
                Dr. {r.doctor_name || '—'}
                {r.doctor_id === currentUserId && <span className="font-normal text-muted-foreground"> (you)</span>}
              </p>
              <p className="text-xs text-muted-foreground">
                {r.hospital_name ?? '—'}
                {r.specialization && ` · ${r.specialization}`}
              </p>
            </div>
            <IDChip id={r.doctor_display_id} />
            <div className="text-xs text-muted-foreground">
              First {formatDate(r.first_access)} · Last {r.last_accessed ? formatDate(r.last_accessed) : '—'}
            </div>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
              {r.visit_count} visit{r.visit_count === 1 ? '' : 's'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
