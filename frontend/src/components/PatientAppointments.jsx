import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, ChevronDown, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';
import { formatDate, formatDateTime } from '../lib/format';
import { isAppointmentOpen } from '../lib/patientAccess';
import { Button } from './ui';
import { EmptyState, ErrorState, Section, SegmentedTabs, StatusPill, pillValue } from './medis';

export default function PatientAppointments({ patientId }) {
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('upcoming');
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError('');
    try {
      const { data, error: fetchError } = await supabase.from('appointments')
        .select('*, profiles:doctor_id(full_name)')
        .eq('patient_id', patientId).order('scheduled_at', { ascending: true });
      if (fetchError) throw fetchError;
      // Doctor details are optional and remain subject to the existing RLS policies.
      const ids = [...new Set((data ?? []).map((a) => a.doctor_id))];
      const { data: doctors } = ids.length
        ? await supabase.from('doctor_profiles').select('id, specialization, hospitals(name)').in('id', ids)
        : { data: [] };
      const byId = Object.fromEntries((doctors ?? []).map((d) => [d.id, d]));
      setAppointments((data ?? []).map((a) => ({ ...a, specialization: byId[a.doctor_id]?.specialization, hospitals: byId[a.doctor_id]?.hospitals })));
      setNow(new Date());
    } catch (err) {
      setError(err.message || 'Could not load appointments.');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    load();
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, [load]);

  const upcoming = appointments.filter((a) => isAppointmentOpen(a, now));
  const past = appointments.filter((a) => !isAppointmentOpen(a, now)).reverse();
  const visible = tab === 'upcoming' ? upcoming : past;

  return (
    <Section id="appointments" title="Appointments" icon={<CalendarDays className="h-4 w-4 text-primary" />}
      action={<Button size="sm" variant="outline" onClick={load} disabled={loading} aria-label="Refresh appointments"><RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh</Button>}>
      <SegmentedTabs label="Appointments" value={tab} onChange={setTab}
        options={[[ 'upcoming', `Upcoming appointments (${upcoming.length})` ], [ 'history', `Appointment history (${past.length})` ]]} />
      {error && <div className="mt-3"><ErrorState text={error} onRetry={load} /></div>}
      <div key={tab} className="content-enter mt-4 space-y-3" aria-live="polite" aria-busy={loading}>
        {loading ? <div role="status" aria-label="Loading appointments" className="space-y-3">{[1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-xl bg-muted" />)}</div>
          : visible.length ? visible.map((a) => (
            <details key={a.id} className="appointment-card group rounded-xl border bg-card transition-shadow hover:border-primary/40 hover:shadow-card">
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 p-4">
                <div className="rounded-lg bg-primary-soft p-2.5 text-primary"><CalendarDays className="h-5 w-5" /></div>
                <div className="min-w-0 flex-1 basis-36">
                  <p className="font-semibold">Dr. {a.profiles?.full_name || 'Doctor'}</p>
                  {a.specialization && <p className="text-xs text-muted-foreground">{a.specialization}</p>}
                  <p className="mt-1 text-sm">{formatDate(a.scheduled_at)} · {new Date(a.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                  <p className="text-xs text-muted-foreground">{a.hospitals?.name || 'Hospital not specified'}</p>
                </div>
                <StatusPill value={pillValue(a.status)} />
                <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
                <p className="w-full break-words text-sm text-muted-foreground">{a.reason || 'No reason provided'}</p>
              </summary>
              <dl className="grid gap-3 border-t bg-muted/30 p-4 text-sm sm:grid-cols-2">
                <div><dt className="text-xs text-muted-foreground">Duration</dt><dd>{a.duration_minutes ?? 30} minutes</dd></div>
                <div><dt className="text-xs text-muted-foreground">Scheduled for (your local time)</dt><dd>{formatDateTime(a.scheduled_at)}</dd></div>
                {a.notes && <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Appointment notes</dt><dd className="whitespace-pre-wrap break-words">{a.notes}</dd></div>}
              </dl>
            </details>
          )) : !error && <EmptyState text={tab === 'upcoming' ? 'No upcoming appointments. Your doctor will book your next visit.' : 'No appointments in your history yet.'} />}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Appointments are booked and managed by your doctor. Expand a card for details.</p>
    </Section>
  );
}
