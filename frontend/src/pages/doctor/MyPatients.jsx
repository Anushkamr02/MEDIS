import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, Search } from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';
import { openPatientRecord } from '../../lib/patientAccess';
import { useAuth } from '../../context/AuthContext';
import { useAssignedPatients, useLatestPriorities } from '../../hooks/useDoctorData';
import { formatDate, calcAge, humanize } from '../../lib/format';
import { priorityInfo } from '../../lib/aiPriority';
import { Button, Input } from '../../components/ui';
import { BackButton, EmptyState, ErrorState, IDChip, PriorityPill, Section, SegmentedTabs, Spinner } from '../../components/medis';

// ?priority= values (links from the Overview cards)
const PRIORITY_FILTERS = {
  all: { label: 'All', matches: () => true },
  attention: { label: 'Critical + needs review', matches: (p) => p === 'URGENT_REVIEW' || p === 'REVIEW' },
  critical: { label: 'Critical', matches: (p) => p === 'URGENT_REVIEW' },
  review: { label: 'Needs review', matches: (p) => p === 'REVIEW' },
};

// One search filters accessible patients and looks up new patients by full ID.
export default function MyPatients() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { patients, loading, error } = useAssignedPatients(user?.id);
  const { latest } = useLatestPriorities(patients.map((p) => p.patient_id));
  const initial = searchParams.get('q') ?? '';
  const [filter, setFilter] = useState(initial);
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [openingId, setOpeningId] = useState(null);
  const requestId = useRef(0);

  const runSearch = useCallback(async (value) => {
    const currentRequest = ++requestId.current;
    const id = value.trim().toUpperCase();
    setSearchError('');
    setResults(null);
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
      setResults(data ?? []);
    } catch (error) {
      if (currentRequest === requestId.current) setSearchError(error.message || 'Could not search patients. Try again.');
    } finally {
      if (currentRequest === requestId.current) setSearching(false);
    }
  }, []);

  useEffect(() => {
    setFilter(initial);
    if (initial) runSearch(initial);
    return () => { requestId.current += 1; };
  }, [initial, runSearch]);

  function updateFilter(value) {
    requestId.current += 1;
    setFilter(value);
    setResults(null);
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

  async function openRecord(patient) {
    setSearchError('');
    setOpeningId(patient.patient_id);
    try {
      const { error } = await openPatientRecord(user.id, patient.patient_id, 'search', { display_id: patient.display_id });
      if (error) throw error;
      navigate(`/doctor/patients/${patient.patient_id}`);
    } catch (error) {
      setSearchError(error.message || 'Could not open the patient record. Try again.');
    } finally {
      setOpeningId(null);
    }
  }

  const priorityFilter = PRIORITY_FILTERS[searchParams.get('priority')] ? searchParams.get('priority') : 'all';
  const term = filter.trim().toLowerCase();
  const visible = patients
    .filter((p) => {
      const name = p.profiles?.full_name?.toLowerCase() ?? '';
      const id = p.profiles?.display_id?.toLowerCase() ?? '';
      return !term || name.includes(term) || id.includes(term);
    })
    .filter((p) => PRIORITY_FILTERS[priorityFilter].matches(latest[p.patient_id]?.review_priority))
    // Stable sort: keeps newest access first within each priority
    .sort((a, b) => priorityInfo(latest[a.patient_id]?.review_priority).rank - priorityInfo(latest[b.patient_id]?.review_priority).rank);

  const open = (p) => navigate(`/doctor/patients/${p.patient_id}`);

  return (
    <div className="space-y-5">
      <BackButton />
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
        {results?.map((patient) => (
          <div key={patient.patient_id} className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
            <div>
              <p className="font-semibold">{patient.full_name || 'Unnamed patient'}</p>
              <IDChip id={patient.display_id} />
            </div>
            <Button onClick={() => openRecord(patient)} disabled={openingId !== null}>
              {openingId === patient.patient_id && <Loader2 className="h-4 w-4 animate-spin" />}
              Open record
            </Button>
            <p className="w-full text-xs text-muted-foreground">Opening the record grants access and is logged in the patient's access history.</p>
          </div>
        ))}
      </Section>
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedTabs
          label="AI check filter"
          options={Object.entries(PRIORITY_FILTERS).map(([v, f]) => [v, f.label])}
          value={priorityFilter}
          onChange={(v) => setSearchParams((params) => {
            const next = new URLSearchParams(params);
            if (v === 'all') next.delete('priority');
            else next.set('priority', v);
            return next;
          })}
        />
      </div>
      {error && <ErrorState text={error} />}
      <Section title={`${visible.length} patient${visible.length === 1 ? '' : 's'}`}>
        {loading ? (
          <Spinner text="Loading patients..." />
        ) : visible.length === 0 ? (
          <EmptyState
            text={
              patients.length === 0
                ? 'No patients yet. Search a Patient ID to open a record.'
                : term
                  ? 'No patients match this search.'
                  : priorityFilter !== 'all'
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
                      onKeyDown={(e) => e.key === 'Enter' && open(p)}
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
                            <PriorityPill value={assessment.review_priority} />
                            <p className="mt-0.5 text-[10px] text-muted-foreground">Analysed {formatDate(assessment.created_at)}</p>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Not checked</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          "AI check" is the latest screening of each patient's trends across visits. It is not a diagnosis, and it only changes when someone runs
          the analysis again.
        </p>
      </Section>
    </div>
  );
}
