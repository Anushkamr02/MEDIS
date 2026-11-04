import { useMemo, useState } from 'react';
import { CalendarClock, Pill, Search, Stethoscope, X } from 'lucide-react';
import { formatDate, formatDateTime } from '../lib/format';
import { Button, Input, Label, SimpleSelect } from './ui';
import { DetailsDialog, EmptyState, Field, IDChip, ScrollPanel } from './medis';
import PrescriptionPdfButton from './ai/PrescriptionPdfButton';

function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Normalises the two shapes the prescription rows arrive in. */
function doctorNameOf(rx) {
  return rx.profiles?.full_name ?? rx.doctor?.full_name ?? null;
}

function durationOf(medicine) {
  if (medicine.duration) return medicine.duration;
  if (medicine.duration_days) return `${medicine.duration_days} day${Number(medicine.duration_days) === 1 ? '' : 's'}`;
  return null;
}

function MedicineRows({ medicines }) {
  if (!medicines?.length) return <p className="text-sm text-muted-foreground">No medicines recorded on this prescription.</p>;
  return (
    <ul className="space-y-2">
      {medicines.map((m, i) => (
        <li key={i} className="rounded-lg border bg-muted/40 p-2.5">
          <p className="break-words text-sm font-medium">{m.name || 'Unnamed medicine'}</p>
          <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
            <Field label="Dosage" value={m.dosage} />
            <Field label="Frequency" value={m.frequency} />
            <Field label="Duration" value={durationOf(m)} />
            <Field label="Timing" value={m.timing} />
          </dl>
          {m.notes && <p className="mt-1 break-words text-xs text-muted-foreground">{m.notes}</p>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Every prescription issued to this patient: searchable, filterable by
 * date and by prescribing doctor, with the full prescription in an
 * accessible modal and a PDF download of the issued document.
 *
 * Read-only for patients — nothing here writes. A doctor edits a
 * prescription from the consultation it belongs to, which is where the
 * existing permissions allow it.
 *
 * Follow-up comes from the visit the prescription belongs to, matched
 * against the already-authorized visit rows rather than re-queried.
 */
export default function PrescriptionsPanel({ prescriptions, visits = [], title = 'Prescriptions', maxHeight = '32rem', className }) {
  const [term, setTerm] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [selected, setSelected] = useState(null);

  const visitById = useMemo(() => Object.fromEntries(visits.map((v) => [v.consultation_id, v])), [visits]);

  const doctors = useMemo(() => {
    const seen = new Map();
    for (const rx of prescriptions) {
      if (rx.doctor_id && !seen.has(rx.doctor_id)) seen.set(rx.doctor_id, doctorNameOf(rx) || 'Unnamed doctor');
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [prescriptions]);

  const filtered = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return prescriptions.filter((rx) => {
      const day = localDay(rx.issued_at);
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (doctorId && rx.doctor_id !== doctorId) return false;
      if (!needle) return true;
      const haystack = [
        doctorNameOf(rx),
        rx.instructions,
        rx.consultations?.visit_id ?? visitById[rx.consultation_id]?.visit_id,
        ...(rx.medicines ?? []).flatMap((m) => [m.name, m.dosage, m.frequency, durationOf(m), m.timing, m.notes]),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [prescriptions, term, from, to, doctorId, visitById]);

  const filtering = !!(term || from || to || doctorId);
  function clearFilters() {
    setTerm('');
    setFrom('');
    setTo('');
    setDoctorId('');
  }

  const selectedVisit = selected ? visitById[selected.consultation_id] : null;
  const selectedVisitId = selected?.consultations?.visit_id ?? selectedVisit?.visit_id;

  return (
    <>
      <ScrollPanel
        id="prescriptions"
        title={title}
        icon={<Pill className="h-4 w-4 text-primary" aria-hidden />}
        maxHeight={maxHeight}
        className={className}
        label={`${title}, scrollable list of ${filtered.length} prescription${filtered.length === 1 ? '' : 's'}`}
        footer={`Showing ${filtered.length} of ${prescriptions.length} prescription${prescriptions.length === 1 ? '' : 's'}.`}
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
              placeholder="Search by medicine, doctor or instructions"
              aria-label="Search prescriptions"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="rx-from" className="text-xs text-muted-foreground">
                From
              </Label>
              <Input id="rx-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rx-to" className="text-xs text-muted-foreground">
                To
              </Label>
              <Input id="rx-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Prescribing doctor</Label>
            <SimpleSelect
              value={doctorId}
              onChange={setDoctorId}
              placeholder="All doctors"
              ariaLabel="Filter prescriptions by doctor"
              options={doctors.map(([id, name]) => [id, `Dr. ${name}`])}
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            text={filtering ? 'No prescriptions match these filters.' : 'No prescriptions yet. They appear here once a doctor issues one.'}
            action={filtering && <Button size="sm" variant="outline" onClick={clearFilters}>Clear filters</Button>}
          />
        ) : (
          <ul className="space-y-2">
            {filtered.map((rx) => {
              const visit = visitById[rx.consultation_id];
              const visitId = rx.consultations?.visit_id ?? visit?.visit_id;
              return (
                <li key={rx.id} id={`rx-${rx.id}`} className="min-w-0 scroll-mt-24 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 text-sm font-medium">
                      <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      {formatDate(rx.issued_at)}
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Stethoscope className="h-3 w-3" aria-hidden />
                      Dr. {doctorNameOf(rx) ?? '—'}
                    </span>
                    {visitId && <IDChip id={visitId} />}
                  </div>
                  <p className="mt-1.5 break-words text-sm">
                    {(rx.medicines ?? []).length
                      ? (rx.medicines ?? []).map((m) => [m.name, m.dosage].filter(Boolean).join(' ')).join(', ')
                      : 'No medicines recorded.'}
                  </p>
                  {visit?.follow_up_date && (
                    <p className="mt-1 text-xs text-muted-foreground">Follow-up: review on {formatDate(visit.follow_up_date)}</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setSelected(rx)}>
                      View prescription
                    </Button>
                    <PrescriptionPdfButton prescriptionId={rx.id} label="Download" variant="ghost" />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollPanel>

      <DetailsDialog
        open={!!selected}
        onOpenChange={(next) => !next && setSelected(null)}
        title="Prescription"
        description={selected ? `Issued ${formatDateTime(selected.issued_at)}. Read-only copy of the issued prescription.` : ''}
        footer={selected && <PrescriptionPdfButton prescriptionId={selected.id} label="Download prescription" />}
      >
        {selected && (
          <div className="space-y-4">
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Prescription date" value={formatDateTime(selected.issued_at)} />
              <Field label="Prescribing doctor" value={doctorNameOf(selected) ? `Dr. ${doctorNameOf(selected)}` : null} />
              <Field label="Visit" value={selectedVisitId} />
              <Field
                label="Follow-up recommendation"
                value={selectedVisit?.follow_up_date ? `Review on ${formatDate(selectedVisit.follow_up_date)}` : 'No follow-up recorded'}
              />
            </dl>
            <section>
              <h3 className="mb-2 text-sm font-semibold">Medications</h3>
              <MedicineRows medicines={selected.medicines} />
            </section>
            <section>
              <h3 className="mb-1 text-sm font-semibold">Instructions</h3>
              <p className="break-words text-sm text-muted-foreground">{selected.instructions || 'No additional instructions were given.'}</p>
            </section>
          </div>
        )}
      </DetailsDialog>
    </>
  );
}
