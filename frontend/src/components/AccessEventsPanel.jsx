import { useCallback, useEffect, useMemo, useState } from 'react';
import { Lock, Search, ShieldCheck, X } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';
import { formatDate, formatDateTime } from '../lib/format';
import { Button, Input, Label } from './ui';
import { DetailsDialog, EmptyState, ErrorState, Field, IDChip, ScrollPanel, Spinner } from './medis';

const PAGE_SIZE = 20;

/** Start of the chosen local day, as an instant the server can compare. */
function startOfLocalDay(value) {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}
function endOfLocalDay(value) {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * The record of every doctor access to this patient's profile, one row
 * per real event.
 *
 * The rows come from get_patient_access_events() (migration v8), which
 * reads public.audit_logs — events written by the server when a doctor
 * actually opened the record, a document or ran an analysis. Nothing on
 * this screen is simulated: with no recorded activity it shows an empty
 * state rather than sample rows, and a patient can only ever reach their
 * own history, because the function checks auth.uid() before returning
 * anything.
 *
 * Search, date filtering and paging are all done by the function, so a
 * filter covers the whole history rather than one loaded page.
 */
export default function AccessEventsPanel({
  patientId,
  title = 'Doctors who accessed this profile',
  maxHeight = '32rem',
  className,
  intro,
}) {
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);

  // Typing should not fire a query per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(timer);
  }, [term]);

  // Any filter change starts again at the first page.
  useEffect(() => {
    setPage(0);
  }, [debounced, from, to]);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError('');
    const { data, error: rpcError } = await supabase.rpc('get_patient_access_events', {
      p_patient_id: patientId,
      p_search: debounced || null,
      p_from: startOfLocalDay(from),
      p_to: endOfLocalDay(to),
      p_limit: PAGE_SIZE,
      p_offset: page * PAGE_SIZE,
    });
    if (rpcError) {
      setError(rpcError.message);
      setRows([]);
      setTotal(0);
    } else {
      setRows(data ?? []);
      setTotal(data?.[0]?.total_count ? Number(data[0].total_count) : 0);
    }
    setLoading(false);
  }, [patientId, debounced, from, to, page]);

  useEffect(() => {
    load();
  }, [load]);

  const filtering = !!(debounced || from || to);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const shown = useMemo(() => (total === 0 ? '0' : `${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + rows.length}`), [page, rows.length, total]);

  function clearFilters() {
    setTerm('');
    setFrom('');
    setTo('');
  }

  return (
    <>
      <ScrollPanel
        id="access"
        title={title}
        icon={<ShieldCheck className="h-4 w-4 text-primary" aria-hidden />}
        maxHeight={maxHeight}
        className={className}
        label={`${title}, scrollable list of access records`}
        action={
          filtering && (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              <X className="h-3.5 w-3.5" />
              Clear filters
            </Button>
          )
        }
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {total === 0 ? 'No access records' : `Showing ${shown} of ${total} access record${total === 1 ? '' : 's'}`}
              {pages > 1 && ` · page ${page + 1} of ${pages}`}
            </span>
            {pages > 1 && (
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" disabled={page === 0 || loading} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                  Previous
                </Button>
                <Button size="sm" variant="ghost" disabled={page + 1 >= pages || loading} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </span>
            )}
          </div>
        }
      >
        <p className="mb-3 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          {intro ?? 'Every time a doctor opens this record, a document or an analysis, the server records it here with its own timestamp.'}
        </p>

        <div className="mb-3 grid gap-2 sm:grid-cols-2">
          <div className="relative sm:col-span-2">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
            <Input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              className="pl-8"
              placeholder="Search by doctor name or doctor ID"
              aria-label="Search access history by doctor"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="access-from" className="text-xs text-muted-foreground">
              From
            </Label>
            <Input id="access-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="access-to" className="text-xs text-muted-foreground">
              To
            </Label>
            <Input id="access-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>

        {error && <ErrorState text={error} onRetry={load} />}
        {loading && <Spinner text="Loading access history..." />}

        {!loading && !error && rows.length === 0 && (
          <EmptyState
            text={
              filtering
                ? 'No recorded access matches these filters.'
                : 'No doctor access has been recorded for this profile yet. Records appear here as soon as a doctor opens it.'
            }
            action={filtering && <Button size="sm" variant="outline" onClick={clearFilters}>Clear filters</Button>}
          />
        )}

        {!loading && !error && rows.length > 0 && (
          <ul className="divide-y rounded-lg border" aria-live="polite">
            {rows.map((r) => (
              <li key={r.event_id} className="min-w-0 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="break-words text-sm font-medium">Dr. {r.doctor_name || '—'}</p>
                  <IDChip id={r.doctor_display_id} />
                  <span className="rounded-full border bg-muted px-2 py-0.5 text-xs">{r.access_type}</span>
                </div>
                <p className="mt-0.5 break-words text-xs text-muted-foreground">
                  {r.specialization || 'Specialization not recorded'}
                  {' · '}
                  {r.hospital_name || 'Hospital not recorded'}
                </p>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {formatDate(r.accessed_at)} at {timeOf(r.accessed_at)}
                  </p>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(r)}>
                    View access details
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </ScrollPanel>

      <DetailsDialog
        open={!!selected}
        onOpenChange={(next) => !next && setSelected(null)}
        title="Access record"
        description={selected ? `Recorded by the server on ${formatDateTime(selected.accessed_at)}.` : ''}
      >
        {selected && (
          <dl className="grid gap-3 sm:grid-cols-2">
            <Field label="Doctor" value={selected.doctor_name ? `Dr. ${selected.doctor_name}` : null} />
            <Field label="Doctor ID" value={selected.doctor_display_id} />
            <Field label="Specialization" value={selected.specialization} />
            <Field label="Hospital / department" value={selected.hospital_name} />
            <Field label="Access date" value={formatDate(selected.accessed_at)} />
            <Field label="Access time" value={timeOf(selected.accessed_at)} />
            <Field label="Access type" value={selected.access_type} />
            <Field label="Recorded event" value={selected.action} />
            {selected.metadata && Object.keys(selected.metadata).length > 0 && (
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Recorded details</dt>
                <dd className="mt-1 space-y-0.5 text-sm">
                  {Object.entries(selected.metadata).map(([key, value]) => (
                    <p key={key} className="break-words">
                      <span className="text-muted-foreground">{key.replace(/_/g, ' ')}:</span> {String(value)}
                    </p>
                  ))}
                </dd>
              </div>
            )}
          </dl>
        )}
      </DetailsDialog>
    </>
  );
}
