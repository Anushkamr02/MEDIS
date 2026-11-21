import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Loader2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../context/AuthContext';
import { respondToAccessRequest, revokeDoctorAccess } from '../../lib/patientAccess';
import { formatDateTime } from '../../lib/format';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle, Button } from '../../components/ui';
import { ErrorState, IDChip, Section, Spinner } from '../../components/medis';
import AccessEventsPanel from '../../components/AccessEventsPanel';
import AccessHistory from '../../components/AccessHistory';

/**
 * The patient's "Doctors Who Accessed Profile" section — and, since
 * migration v11, where they decide who may open the record.
 *
 * Requests waiting for an answer come first. Below them, the event list
 * is the audit record: real events the server wrote when a doctor opened
 * this record. Then the per-doctor summary shows who currently holds
 * access, each with a Revoke button, and who no longer does. A patient
 * can only ever reach their own history — every RPC checks the caller.
 */
export default function PatientAccess() {
  const { user } = useAuth();
  const { accessHistory, loading, error, refresh } = useOutletContext();
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState('');
  const [revoking, setRevoking] = useState(null);

  if (loading) return <Spinner text="Loading your access history..." />;

  const pending = accessHistory.filter((r) => r.access_status === 'pending');
  const current = accessHistory.filter((r) => r.is_active);
  const past = accessHistory.filter((r) => !r.is_active && r.access_status !== 'pending');

  async function respond(row, approve) {
    setBusyId(row.doctor_id);
    setActionError('');
    const { error: rpcError } = await respondToAccessRequest(row.doctor_id, approve);
    setBusyId(null);
    if (rpcError) {
      setActionError(rpcError);
      return;
    }
    toast.success(approve ? `Dr. ${row.doctor_name} can now open your record.` : `Declined Dr. ${row.doctor_name}'s request.`);
    refresh();
  }

  async function revoke() {
    const row = revoking;
    setBusyId(row.doctor_id);
    setActionError('');
    const { error: rpcError } = await revokeDoctorAccess(row.doctor_id);
    setBusyId(null);
    if (rpcError) {
      setActionError(rpcError);
      return;
    }
    setRevoking(null);
    toast.success(`Dr. ${row.doctor_name} no longer has access to your record.`);
    refresh();
  }

  return (
    <div className="content-enter space-y-5">
      {error && <ErrorState text={`Some data failed to load: ${error}`} onRetry={refresh} />}

      <div>
        <h1 className="text-2xl font-bold">Doctors who accessed your profile</h1>
        <p className="text-sm text-muted-foreground">
          Decide which doctors may open your record, and review every recorded access.
        </p>
      </div>

      {actionError && <ErrorState text={actionError} />}

      {pending.length > 0 && (
        <Section title={`${pending.length} access request${pending.length === 1 ? '' : 's'} waiting for you`} icon={<ShieldAlert className="h-4 w-4 text-warning" aria-hidden />}>
          <ul className="space-y-2" aria-label="Access requests">
            {pending.map((r) => (
              <li key={r.doctor_id} className="rounded-xl border border-warning/40 bg-warning-soft/40 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">Dr. {r.doctor_name || '—'}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.hospital_name ?? 'Hospital not recorded'}
                      {r.specialization && ` · ${r.specialization}`}
                    </p>
                    <IDChip id={r.doctor_display_id} className="mt-1" />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" disabled={busyId !== null} onClick={() => respond(r, false)}>
                      Decline
                    </Button>
                    <Button disabled={busyId !== null} onClick={() => respond(r, true)}>
                      {busyId === r.doctor_id && <Loader2 className="h-4 w-4 animate-spin" />}
                      Approve access
                    </Button>
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Requested {formatDateTime(r.requested_at)}
                  {r.access_reason && <> · Reason given: {r.access_reason}</>}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            Approving lets this doctor see your full record from every hospital until you revoke it. Declining tells them no; they can ask again.
          </p>
        </Section>
      )}

      <AccessEventsPanel
        patientId={user?.id}
        title="Access records"
        maxHeight="min(70dvh, 46rem)"
        intro="Every time a doctor opens your record, views one of your documents or runs an analysis on it, the server records the event with its own timestamp. Emergency access is listed here too."
      />

      <Section title="Doctors with access to your record">
        <AccessHistory
          rows={current}
          currentUserId={user?.id}
          emptyText="No doctor currently has access to your record."
          action={(r) => (
            <Button size="sm" variant="outline" disabled={busyId !== null} onClick={() => setRevoking(r)}>
              Revoke
            </Button>
          )}
        />
        <p className="mt-3 text-xs text-muted-foreground">
          Revoking takes effect immediately. The doctor keeps nothing they have not already recorded as a visit, and can request access again.
        </p>
      </Section>

      {past.length > 0 && (
        <Section title="Past requests and revoked access">
          <AccessHistory rows={past} currentUserId={user?.id} />
        </Section>
      )}

      <AlertDialog open={!!revoking} onOpenChange={(open) => { if (!open && !busyId) setRevoking(null); }}>
        <AlertDialogContent>
          <AlertDialogTitle>Revoke access?</AlertDialogTitle>
          <AlertDialogDescription>
            Dr. {revoking?.doctor_name ?? '—'} will lose access to your record right away, including any consultation they have not finished. They can ask for access again.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" disabled={!!busyId} onClick={() => setRevoking(null)}>Keep access</Button>
            <Button variant="destructive" disabled={!!busyId} onClick={revoke}>
              {busyId ? 'Revoking...' : 'Revoke access'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
