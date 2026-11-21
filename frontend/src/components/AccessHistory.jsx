import { Lock } from 'lucide-react';
import { formatDate } from '../lib/format';
import { AccessStatusPill, EmptyState, IDChip } from './medis';

function whenLine(r) {
  if (r.is_active) return `Since ${formatDate(r.first_access)} · Last ${r.last_accessed ? formatDate(r.last_accessed) : '—'}`;
  if (r.revoked_at) return `Revoked ${formatDate(r.revoked_at)}`;
  if (r.access_status === 'denied' && r.responded_at) return `Declined ${formatDate(r.responded_at)}`;
  if (r.requested_at) return `Requested ${formatDate(r.requested_at)}`;
  return `First ${formatDate(r.first_access)}`;
}

/**
 * Every doctor who holds, held or asked for access to a patient's record,
 * with their status, when they first got access, when they last opened
 * it, and how many finalized visits they recorded (rows from the
 * get_patient_access_history() RPC). Shown to the patient and to
 * doctors, so record access is transparent. `action` renders a control
 * for one row (the patient's Revoke button); doctors see it read-only.
 */
export default function AccessHistory({ rows, currentUserId, action, emptyText = 'No doctor has opened this record yet.' }) {
  if (rows.length === 0) return <EmptyState text={emptyText} />;

  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Lock className="h-3 w-3" />
        Doctors and their access status, with their first access and latest recorded profile view.
      </p>
      <ul className="divide-y rounded-lg border">
        {rows.map((r) => (
          <li key={r.doctor_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
            <div className="min-w-0">
              <p className="font-medium">
                Dr. {r.doctor_name || '—'}
                {r.doctor_id === currentUserId && <span className="font-normal text-muted-foreground"> (you)</span>}
              </p>
              <p className="text-xs text-muted-foreground">
                {r.hospital_name ?? '—'}
                {r.specialization && ` · ${r.specialization}`}
              </p>
              {r.is_emergency && r.access_reason && (
                <p className="break-words text-xs text-destructive">Emergency reason: {r.access_reason}</p>
              )}
            </div>
            <IDChip id={r.doctor_display_id} />
            <AccessStatusPill value={r.access_status} isActive={r.is_active} emergency={r.is_emergency} />
            <div className="text-xs text-muted-foreground">{whenLine(r)}</div>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
              {r.visit_count} visit{r.visit_count === 1 ? '' : 's'}
            </span>
            {action?.(r)}
          </li>
        ))}
      </ul>
    </div>
  );
}
