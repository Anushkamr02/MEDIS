import { useMemo, useState } from 'react';
import { History, Search, X } from 'lucide-react';
import { Button, Input, Label, SimpleSelect } from './ui';
import { EmptyState, ScrollPanel } from './medis';
import VisitTimeline from './VisitTimeline';
import VisitDetails from './VisitDetails';

function matches(visit, term) {
  if (!term) return true;
  const haystack = [
    visit.visit_id,
    visit.doctor_name,
    visit.specialization,
    visit.hospital_name,
    visit.reason,
    visit.final_diagnosis,
    visit.doctor_notes,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(term.toLowerCase());
}

// A date-only comparison against the visit's local calendar date, so a
// filter of "today" matches a visit recorded today in the user's timezone.
function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Visit History as a self-contained panel: search, date range and
 * doctor filters in a header that stays put, and the records scrolling
 * inside a height-capped body (see ScrollPanel). Shared by the doctor's
 * patient record and the patient's own dashboard so both read the same
 * rows from get_patient_visits() and open the same details modal.
 */
export default function VisitHistoryPanel({
  visits,
  viewer,
  currentUserId,
  onOpen,
  title = 'Visit history',
  maxHeight = '32rem',
  className,
  footer,
}) {
  const [term, setTerm] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [selected, setSelected] = useState(null);

  const doctors = useMemo(() => {
    const seen = new Map();
    for (const v of visits) if (v.doctor_id && !seen.has(v.doctor_id)) seen.set(v.doctor_id, v.doctor_name || 'Unnamed doctor');
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [visits]);

  const filtered = useMemo(
    () =>
      visits.filter((v) => {
        const day = localDay(v.consultation_date);
        if (from && day < from) return false;
        if (to && day > to) return false;
        if (doctorId && v.doctor_id !== doctorId) return false;
        return matches(v, term.trim());
      }),
    [visits, term, from, to, doctorId]
  );

  const filtering = !!(term || from || to || doctorId);

  function clearFilters() {
    setTerm('');
    setFrom('');
    setTo('');
    setDoctorId('');
  }

  return (
    <>
      <ScrollPanel
        id="visits"
        title={title}
        icon={<History className="h-4 w-4 text-primary" aria-hidden />}
        maxHeight={maxHeight}
        className={className}
        label={`${title}, scrollable list of ${filtered.length} visit${filtered.length === 1 ? '' : 's'}`}
        footer={footer ?? `Showing ${filtered.length} of ${visits.length} visit${visits.length === 1 ? '' : 's'}.`}
        action={
          filtering && (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              <X className="h-3.5 w-3.5" />
              Clear filters
            </Button>
          )
        }
      >
        <div className="mb-3 grid gap-2 sm:grid-cols-2">
          <div className="relative sm:col-span-2">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
            <Input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              className="pl-8"
              placeholder="Search visits by doctor, diagnosis, reason or visit ID"
              aria-label="Search visits"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="visit-from" className="text-xs text-muted-foreground">
                From
              </Label>
              <Input id="visit-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="visit-to" className="text-xs text-muted-foreground">
                To
              </Label>
              <Input id="visit-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Doctor</Label>
            <SimpleSelect
              value={doctorId}
              onChange={setDoctorId}
              placeholder="All doctors"
              ariaLabel="Filter visits by doctor"
              options={doctors.map(([id, name]) => [id, `Dr. ${name}`])}
            />
          </div>
        </div>

        {filtered.length === 0 && filtering ? (
          <EmptyState text="No visits match these filters." action={<Button size="sm" variant="outline" onClick={clearFilters}>Clear filters</Button>} />
        ) : (
          <VisitTimeline
            visits={filtered}
            viewer={viewer}
            currentUserId={currentUserId}
            onOpen={onOpen}
            onViewDetails={setSelected}
            emptyText={viewer === 'patient' ? 'No visits recorded yet. Visits appear here after a consultation.' : 'No visits recorded yet.'}
          />
        )}
      </ScrollPanel>
      <VisitDetails visit={selected} open={!!selected} onOpenChange={(next) => !next && setSelected(null)} />
    </>
  );
}
