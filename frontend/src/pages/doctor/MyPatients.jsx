import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
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

/**
 * Patients this doctor already has access to. New patients are added
 * through Search Patient, never from here — this list only filters
 * what the doctor can already see. Critical patients (latest AI check)
 * are listed first.
 */
export default function MyPatients() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { patients, loading, error } = useAssignedPatients(user?.id);
  const { latest } = useLatestPriorities(patients.map((p) => p.patient_id));
  const [filter, setFilter] = useState('');

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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">My patients</h1>
        <Button asChild>
          <Link to="/doctor/search">
            <Search className="h-4 w-4" />
            Search patient
          </Link>
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedTabs
          label="AI check filter"
          options={Object.entries(PRIORITY_FILTERS).map(([v, f]) => [v, f.label])}
          value={priorityFilter}
          onChange={(v) => setSearchParams(v === 'all' ? {} : { priority: v })}
        />
        <Input className="max-w-xs" placeholder="Filter by name or Patient ID" value={filter} onChange={(e) => setFilter(e.target.value)} />
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
