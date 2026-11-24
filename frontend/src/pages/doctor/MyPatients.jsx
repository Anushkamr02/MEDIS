import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, Search, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../../lib/supabaseClient';
import { getAccessStatus, openPatientRecord, requestEmergencyAccess } from '../../lib/patientAccess';
import { useAuth } from '../../context/AuthContext';
import { useAccessRequests, useAssignedPatients, useLatestPriorities } from '../../hooks/useDoctorData';
import { formatDate, formatDateTime, calcAge, humanize } from '../../lib/format';
import { priorityInfo } from '../../lib/aiPriority';
import { TREND_FILTERS, trendInfo } from '../../lib/healthTrend';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Textarea } from '../../components/ui';
import { AccessStatusPill, EmptyState, ErrorState, IDChip, PriorityPill, Section, SegmentedTabs, Spinner, TrendPill } from '../../components/medis';

// ?priority= values (links from the Overview cards)
const PRIORITY_FILTERS = {
  all: { label: 'All', matches: () => true },
  attention: { label: 'Critical + needs review', matches: (p) => p === 'URGENT_REVIEW' || p === 'REVIEW' },
  critical: { label: 'Critical', matches: (p) => p === 'URGENT_REVIEW' },
  review: { label: 'Needs review', matches: (p) => p === 'REVIEW' },
};

// The database enforces the same minimum for an emergency reason.
const EMERGENCY_REASON_MIN = 10;

// What the search result says under its button, by where the doctor stands.
function accessHint(info) {
  if (!info || info.legacy || info.status === 'active') {
    return "Opening the record is logged in the patient's access history.";
  }
  const row = info.row ?? {};
  switch (info.status) {
    case 'pending':
      return `Request sent ${formatDateTime(row.requested_at)}. Waiting for the patient to approve it; you will be notified.`;
    case 'denied':
      return `The patient declined your request on ${formatDate(row.responded_at)}. You can ask again.`;
    case 'revoked':
      return `The patient revoked your access on ${formatDate(row.revoked_at)}. You can ask again.`;
    default:
      return 'The patient approves access from their MEDIS account; you are notified when they respond. Emergency access opens the record now, needs a reason, and is flagged to the patient.';
  }
}

function requestLine(r) {
  if (r.access_status === 'pending') return `Requested ${formatDateTime(r.requested_at)}`;
  if (r.access_status === 'denied') return `Declined ${formatDate(r.responded_at)}`;
  if (r.access_status === 'revoked') return `Revoked ${formatDate(r.revoked_at)}`;
  return '';
}

// One search filters accessible patients and looks up new patients by full ID.
export default function MyPatients() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { patients, loading, error, refresh } = useAssignedPatients(user?.id);
  const { latest, monitoring } = useLatestPriorities(patients.map((p) => p.patient_id));
  const { requests, refresh: refreshRequests } = useAccessRequests(user?.id);
  const initial = searchParams.get('q') ?? '';
  const [filter, setFilter] = useState(initial);
  const [results, setResults] = useState(null);
  const [access, setAccess] = useState({});
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [openingId, setOpeningId] = useState(null);
  const [emergency, setEmergency] = useState(null);
  const [reason, setReason] = useState('');
  const [emergencyError, setEmergencyError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const requestId = useRef(0);

  const runSearch = useCallback(async (value) => {
    const currentRequest = ++requestId.current;
    const id = value.trim().toUpperCase();
    setSearchError('');
    setResults(null);
    setAccess({});
    setSearching(false);
    if (!/^MEDIS-P-(?:\d{4}-)?\d+$/i.test(id)) {
      setSearchError('Enter a full Patient ID to look up a new patient. You can filter your patients by name as you type.');
      return;
    }
    setSearching(true);
    try {
      const { data, error } = await supabase.rpc('search_patient_by_display_id', { p_display_id: id });
      if (currentRequest !== requestId.current) return;
      if (error) throw error;
      const rows = data ?? [];
      setResults(rows);
      // Where this doctor stands with each match decides which button shows.
      const statuses = await Promise.all(rows.map((p) => getAccessStatus(user.id, p.patient_id)));
      if (currentRequest !== requestId.current) return;
      setAccess(Object.fromEntries(rows.map((p, i) => [p.patient_id, statuses[i]])));
    } catch (error) {
      if (currentRequest === requestId.current) setSearchError(error.message || 'Could not search patients. Try again.');
    } finally {
      if (currentRequest === requestId.current) setSearching(false);
    }
  }, [user?.id]);

  useEffect(() => {
    setFilter(initial);
    if (initial) runSearch(initial);
    return () => { requestId.current += 1; };
  }, [initial, runSearch]);

  function updateFilter(value) {
    requestId.current += 1;
    setFilter(value);
    setResults(null);
    setAccess({});
    setSearchError('');
    setSearching(false);
  }

  function clearSearch() {
    updateFilter('');
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.delete('q');
      return next;
    });
  }

  // Opens the record when access is held (or the database predates v11);
  // otherwise sends the patient a request and shows it as pending.
  async function openRecord(patient) {
    setSearchError('');
    setOpeningId(patient.patient_id);
    try {
      const { status, error } = await openPatientRecord(user.id, patient.patient_id, 'search', { display_id: patient.display_id });
      if (error) throw error;
      if (status === 'active') {
        navigate(`/doctor/patients/${patient.patient_id}`);
        return;
      }
      setAccess((prev) => ({
        ...prev,
        [patient.patient_id]: { status: 'pending', legacy: false, row: { requested_at: new Date().toISOString() } },
      }));
      refreshRequests();
      toast.success('Access request sent. The patient will be asked to approve it.');
    } catch (error) {
      setSearchError(error.message || 'Could not open the patient record. Try again.');
    } finally {
      setOpeningId(null);
    }
  }

  function openEmergency(patient) {
    setReason('');
    setEmergencyError('');
    setEmergency(patient);
  }

  function closeEmergency() {
    if (submitting) return;
    setEmergency(null);
  }

  async function submitEmergency(e) {
    e.preventDefault();
    const text = reason.trim();
    if (text.length < EMERGENCY_REASON_MIN) {
      setEmergencyError(`Give a reason of at least ${EMERGENCY_REASON_MIN} characters. The patient will see it.`);
      return;
    }
    setSubmitting(true);
    setEmergencyError('');
    const { status, error } = await requestEmergencyAccess(user.id, emergency.patient_id, text, { display_id: emergency.display_id });
    setSubmitting(false);
    if (error || status !== 'active') {
      setEmergencyError(error?.message || 'Emergency access was not granted. Try again.');
      return;
    }
    const patientId = emergency.patient_id;
    setEmergency(null);
    refresh();
    navigate(`/doctor/patients/${patientId}`);
  }

  const priorityFilter = PRIORITY_FILTERS[searchParams.get('priority')] ? searchParams.get('priority') : 'all';
  const trendFilter = monitoring && TREND_FILTERS[searchParams.get('trend')] ? searchParams.get('trend') : 'all';
  const setParam = (name, value) => setSearchParams((params) => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete(name);
    else next.set(name, value);
    return next;
  });
  // Critical first, then worsening, then the rest by priority.
  const rank = (p) => {
    const a = latest[p.patient_id];
    const priority = priorityInfo(a?.review_priority).rank;
    return (priority === 0 ? 0 : a?.health_trend === 'WORSENING' ? 1 : 2) * 10 + priority;
  };
  const term = filter.trim().toLowerCase();
  const visible = patients
    .filter((p) => {
      const name = p.profiles?.full_name?.toLowerCase() ?? '';
      const id = p.profiles?.display_id?.toLowerCase() ?? '';
      return !term || name.includes(term) || id.includes(term);
    })
    .filter((p) => PRIORITY_FILTERS[priorityFilter].matches(latest[p.patient_id]?.review_priority))
    .filter((p) => TREND_FILTERS[trendFilter].matches(latest[p.patient_id]?.health_trend))
    // Stable sort: keeps newest access first within each group
    .sort((a, b) => rank(a) - rank(b));

  const open = (p) => navigate(`/doctor/patients/${p.patient_id}`);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">My patients</h1>
      <Section title="Find a patient">
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); runSearch(filter); }}>
          <Input
            className="min-w-0 flex-1 basis-56"
            aria-label="Patient ID"
            placeholder="Search by name or Patient ID"
            value={filter}
            onChange={(e) => updateFilter(e.target.value)}
          />
          <Button type="submit" disabled={searching || !filter.trim()}>
            {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Search
          </Button>
          {filter && <Button type="button" variant="outline" onClick={clearSearch}>Clear</Button>}
        </form>
        <p className="mt-2 text-xs text-muted-foreground">Type a name or ID to filter your patients. To find a new patient, enter their full MEDIS Patient ID and select Search.</p>
        {searchError && <div className="mt-3"><ErrorState text={searchError} /></div>}
        {results?.length === 0 && <p className="mt-3 text-sm" role="status">No patient with ID {filter.trim().toUpperCase()}. Check the ID and try again.</p>}
        {results?.map((patient) => {
          const info = access[patient.patient_id];
          const status = info?.status ?? 'none';
          const canOpen = !!info && (info.legacy || status === 'active');
          const busy = openingId === patient.patient_id;
          return (
            <div key={patient.patient_id} className="mt-3 rounded-xl border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">{patient.full_name || 'Unnamed patient'}</p>
                  <IDChip id={patient.display_id} />
                </div>
                {!info ? (
                  <Spinner text="Checking access..." />
                ) : canOpen ? (
                  <Button onClick={() => openRecord(patient)} disabled={openingId !== null}>
                    {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                    Open record
                  </Button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    {status === 'pending' ? (
                      <AccessStatusPill value="pending" />
                    ) : (
                      <Button onClick={() => openRecord(patient)} disabled={openingId !== null}>
                        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                        {status === 'none' ? 'Request access' : 'Request again'}
                      </Button>
                    )}
                    <Button variant="outline" onClick={() => openEmergency(patient)} disabled={openingId !== null}>
                      <ShieldAlert className="h-4 w-4 text-destructive" aria-hidden />
                      Emergency access
                    </Button>
                  </div>
                )}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{accessHint(info)}</p>
            </div>
          );
        })}
      </Section>

      {requests.length > 0 && (
        <Section title="Access requests">
          <ul className="divide-y rounded-lg border" aria-label="Access requests">
            {requests.map((r) => (
              <li key={r.patient_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                <div>
                  <p className="font-medium">{r.profiles?.full_name || 'Unnamed patient'}</p>
                  <IDChip id={r.profiles?.display_id} />
                </div>
                <AccessStatusPill value={r.access_status} />
                <span className="text-xs text-muted-foreground">{requestLine(r)}</span>
                {r.access_status !== 'pending' && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={openingId !== null}
                    onClick={() => openRecord({ patient_id: r.patient_id, display_id: r.profiles?.display_id })}
                  >
                    Request again
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            A patient decides who may open their record. You are notified when they respond, and an approved patient appears in the list below.
          </p>
        </Section>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <SegmentedTabs
          label="AI check filter"
          options={Object.entries(PRIORITY_FILTERS).map(([v, f]) => [v, f.label])}
          value={priorityFilter}
          onChange={(v) => setParam('priority', v)}
        />
        {monitoring && (
          <SegmentedTabs
            label="Trend filter"
            options={Object.entries(TREND_FILTERS).map(([v, f]) => [v, f.label])}
            value={trendFilter}
            onChange={(v) => setParam('trend', v)}
          />
        )}
      </div>
      {error && <ErrorState text={error} />}
      <Section title={`${visible.length} patient${visible.length === 1 ? '' : 's'}`}>
        {loading ? (
          <Spinner text="Loading patients..." />
        ) : visible.length === 0 ? (
          <EmptyState
            text={
              patients.length === 0
                ? 'No patients yet. Search a Patient ID to request access to a record.'
                : term
                  ? 'No patients match this search.'
                  : priorityFilter !== 'all' || trendFilter !== 'all'
                  ? 'No patients in this group. Run the AI analysis from a patient\'s profile to check them.'
                  : 'No patients match this filter.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2">Patient</th>
                  <th className="pb-2">Patient ID</th>
                  <th className="pb-2">Age / sex</th>
                  <th className="pb-2">Access since</th>
                  <th className="pb-2">AI check</th>
                  {monitoring && <th className="pb-2">Trend</th>}
                </tr>
              </thead>
              <tbody className="divide-y">
                {visible.map((p) => {
                  const assessment = latest[p.patient_id];
                  return (
                    <tr
                      key={p.patient_id}
                      tabIndex={0}
                      className="cursor-pointer transition-colors hover:bg-muted/60 focus:bg-muted/60"
                      onClick={() => open(p)}
                      onKeyDown={(e) => e.target === e.currentTarget && e.key === 'Enter' && open(p)}
                    >
                      <td className="py-2.5 font-medium">{p.profiles?.full_name || 'Unnamed patient'}</td>
                      <td>
                        <IDChip id={p.profiles?.display_id} />
                      </td>
                      <td className="text-muted-foreground">
                        {calcAge(p.profiles?.date_of_birth) ?? '—'} y · {humanize(p.profiles?.gender) || '—'}
                      </td>
                      <td>{formatDate(p.assigned_at)}</td>
                      <td>
                        {assessment ? (
                          <div>
                            <Link
                              to={`/doctor/patients/${p.patient_id}?review=ai#ai-review`}
                              onClick={(e) => e.stopPropagation()}
                              aria-label={`Review AI check for ${p.profiles?.full_name || 'patient'}: ${priorityInfo(assessment.review_priority).label}`}
                              className="inline-flex rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring hover:opacity-80"
                            >
                              <PriorityPill value={assessment.review_priority} />
                            </Link>
                            <p className="mt-0.5 text-[10px] text-primary">View reason &amp; review</p>
                            <p className="mt-0.5 text-[10px] text-muted-foreground">Analysed {formatDate(assessment.created_at)}</p>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Not checked</span>
                        )}
                      </td>
                      {monitoring && (
                        <td title={assessment?.reasons?.join('\n') || undefined}>
                          {assessment?.health_trend ? (
                            <span aria-label={`Trend: ${trendInfo(assessment.health_trend).label}`}>
                              <TrendPill value={assessment.health_trend} />
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          "AI check" is the latest screening of each patient's trends across visits. It is not a diagnosis.
          {monitoring
            ? ' It is re-checked when a visit is finalized or a prescription is issued. "Trend" shows whether recorded values moved toward or away from target since the previous check.'
            : ' It only changes when someone runs the analysis again.'}
        </p>
      </Section>

      <Dialog open={!!emergency} onOpenChange={(open) => { if (!open) closeEmergency(); }}>
        <DialogContent>
          <form onSubmit={submitEmergency} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Emergency access</DialogTitle>
              <DialogDescription>
                Open {emergency?.full_name || 'this patient'}'s record now, without waiting for their approval. The reason you give is
                shown to the patient, and the access is marked as emergency in their access history.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="emergency-reason">Reason (required)</Label>
              <Textarea
                id="emergency-reason"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Brought to emergency with acute chest pain; unable to respond"
              />
            </div>
            {emergencyError && <p role="alert" className="text-sm text-destructive">{emergencyError}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeEmergency} disabled={submitting}>Cancel</Button>
              <Button type="submit" variant="destructive" disabled={submitting}>
                {submitting ? 'Opening...' : 'Open record now'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
