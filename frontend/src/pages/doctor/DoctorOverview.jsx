import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, CalendarClock, ClipboardCheck, FilePen, FileSearch, Search, ShieldAlert, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabaseClient';
import { aiRequest } from '../../lib/aiClient';
import { useAssignedPatients, useDueQueue, useEscalations, useFindingReviews, useLatestPriorities } from '../../hooks/useDoctorData';
import { assessmentFindings, ecgFindings } from '../../lib/findingReview';
import { ESCALATION_LEVEL, ESCALATION_REASON, overdueFindings } from '../../lib/escalation';
import FindingReview from '../../components/ai/FindingReview';
import { formatDate } from '../../lib/format';
import { TREATMENT_STATUS, TREND, TRIGGER_LABEL } from '../../lib/healthTrend';
import { cn } from '../../lib/utils';
import { isAppointmentNow, isAppointmentOpen, openPatientRecord } from '../../lib/patientAccess';
import { Button } from '../../components/ui';
import { EmptyState, ErrorState, IDChip, Section, TREND_PILL, TrendPill } from '../../components/medis';

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function MonitorList({ items, empty, children }) {
  if (items.length === 0) return <EmptyState text={empty} />;
  return (
    <ul className="divide-y">
      {items.map((item) => (
        <li key={item.key} className="flex items-start gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {item.patient.profiles?.full_name || 'Unnamed patient'}
              <IDChip id={item.patient.profiles?.display_id} />
            </p>
            {children(item)}
          </div>
          <Button size="sm" variant="outline" asChild>
            <Link to={`/doctor/patients/${item.patient.patient_id}`}>Open</Link>
          </Button>
        </li>
      ))}
    </ul>
  );
}

export default function DoctorOverview() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const { patients, loading: patientsLoading } = useAssignedPatients(user?.id);
  const { latest, loading: prioritiesLoading, monitoring, refresh: refreshLatest } = useLatestPriorities(patients.map((p) => p.patient_id));
  const { patientIds: queued, refresh: refreshQueue } = useDueQueue(user?.id);
  const reviews = useFindingReviews(patients.map((p) => p.patient_id));
  const escalations = useEscalations(patients.map((p) => p.patient_id));
  const [updating, setUpdating] = useState(0);
  const queueStarted = useRef(false);
  const countWith = (priority) =>
    patientsLoading || prioritiesLoading ? null : Object.values(latest).filter((a) => a.review_priority === priority).length;
  const critical = countWith('URGENT_REVIEW');
  const needsReview = countWith('REVIEW');

  const [stats, setStats] = useState({ todayConsultations: null, draftConsultations: null, pendingReviews: null });
  const [appointments, setAppointments] = useState([]);
  const [error, setError] = useState(null);
  const [openingId, setOpeningId] = useState(null);

  useEffect(() => {
    if (!user?.id) return;

    async function loadStats() {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(startOfDay);
      endOfDay.setDate(endOfDay.getDate() + 1);

      const [todayRes, draftRes, reviewRes, apptRes] = await Promise.all([
        supabase
          .from('consultations')
          .select('id', { count: 'exact', head: true })
          .eq('doctor_id', user.id)
          .gte('consultation_date', startOfDay.toISOString())
          .lt('consultation_date', endOfDay.toISOString()),
        supabase.from('consultations').select('id', { count: 'exact', head: true }).eq('doctor_id', user.id).eq('status', 'pending'),
        // RLS limits this to documents of patients assigned to this doctor
        supabase.from('medical_reports').select('id', { count: 'exact', head: true }).eq('review_status', 'pending_review'),
        // From the start of today, so an appointment already in progress
        // (scheduled 10 minutes ago) still shows up here.
        supabase
          .from('appointments')
          .select('id, scheduled_at, duration_minutes, reason, status, patient_id, profiles:patient_id(full_name, display_id)')
          .eq('doctor_id', user.id)
          .eq('status', 'scheduled')
          .gte('scheduled_at', startOfDay.toISOString())
          .order('scheduled_at', { ascending: true })
          .limit(20),
      ]);

      const firstError = todayRes.error || draftRes.error || reviewRes.error || apptRes.error;
      if (firstError) setError(firstError.message);

      setStats({ todayConsultations: todayRes.count, draftConsultations: draftRes.count, pendingReviews: reviewRes.count });
      setAppointments(apptRes.data ?? []);
    }

    loadStats();
  }, [user?.id]);

  // There is no background worker (that would need a service-role key), so
  // patients the database queued while the AI service was down are
  // re-checked here, when a doctor with access opens the dashboard.
  useEffect(() => {
    if (!queued.length || queueStarted.current) return;
    queueStarted.current = true;
    setUpdating(queued.length);
    aiRequest('/ai/monitor/queue').then(({ error: queueError }) => {
      setUpdating(0);
      if (queueError) return; // rows stay queued for the next visit
      refreshLatest();
      refreshQueue();
    });
  }, [queued, refreshLatest, refreshQueue]);

  // An appointment the patient booked themself counts as consent, so the
  // record opens at once and the appointment is carried along so the
  // patient page can offer "Start consultation" for it. Otherwise the
  // patient is asked first.
  async function openAppointment(a) {
    setError(null);
    setOpeningId(a.id);
    const { status, error: accessError } = await openPatientRecord(user.id, a.patient_id, 'appointment', { appointment_id: a.id });
    setOpeningId(null);
    if (accessError) {
      setError(accessError.message);
      return;
    }
    if (status !== 'active') {
      toast.info('Access requested. The patient has been asked to approve it; you will be notified when they respond.');
      return;
    }
    navigate(`/doctor/patients/${a.patient_id}`, {
      state: { appointment: { id: a.id, scheduled_at: a.scheduled_at, reason: a.reason } },
    });
  }

  const now = new Date();
  const openAppointments = appointments.filter((a) => isAppointmentOpen(a, now)).slice(0, 6);
  const recentPatients = patients.slice(0, 6);

  const monitored = patients.filter((p) => latest[p.patient_id]?.health_trend).map((p) => ({ patient: p, a: latest[p.patient_id] }));
  const withTrend = (trend) => monitored.filter((m) => m.a.health_trend === trend).map((m) => ({ ...m, key: m.patient.patient_id }));
  // With v13, significant findings (assessment or ECG) without a recorded review;
  // before it, worsening patients.
  const toReview = reviews.available
    ? patients.flatMap((p) => {
        const a = latest[p.patient_id];
        const ecg = reviews.ecgs[p.patient_id];
        const findings = assessmentFindings(a);
        const ecgFound = ecgFindings(ecg);
        return [
          a?.id && findings.length && !reviews.reviewed.has(a.id) && { key: a.id, patient: p, a, findings },
          ecgFound.length && !reviews.reviewed.has(ecg.id) && { key: ecg.id, patient: p, ecg, findings: ecgFound },
        ].filter(Boolean);
      })
    : withTrend('WORSENING');
  // Urgent findings unreviewed past the SQL time limit (migration v15), pinned above everything else.
  const overdue = overdueFindings(escalations, reviews.reviewed)
    .map((e) => ({ ...e, patient: patients.find((p) => p.patient_id === e.patient_id) }))
    .filter((e) => e.patient);
  const today = now.toISOString().slice(0, 10);
  const followUps = monitored
    .flatMap((m) =>
      (m.a.treatments ?? [])
        .filter((t) => t.status === 'awaiting_follow_up' && t.due_from <= today)
        .map((t) => ({ ...t, patient: m.patient, key: `${m.patient.patient_id}:${t.medicine}:${t.metric}` }))
    )
    .sort((x, y) => x.due_from.localeCompare(y.due_from));

  const cards = [
    { label: 'Patients with access', value: patientsLoading ? null : patients.length, icon: Users, to: '/doctor/patients' },
    { label: "Today's consultations", value: stats.todayConsultations, icon: ClipboardCheck },
    { label: 'Draft consultations', value: stats.draftConsultations, icon: FilePen, to: '/doctor/drafts' },
    { label: 'Reports awaiting review', value: stats.pendingReviews, icon: FileSearch },
    { label: 'Upcoming appointments', value: openAppointments.length, icon: CalendarClock, to: '/doctor/appointments' },
    { label: 'Critical patients', value: critical, icon: ShieldAlert, to: '/doctor/patients?priority=critical', ai: true, tone: 'urgent' },
    { label: 'Patients needing review', value: needsReview, icon: AlertTriangle, to: '/doctor/patients?priority=review', ai: true, tone: 'review' },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">Good day, Dr. {profile?.full_name || ''}</h1>
        <p className="text-sm text-muted-foreground">
          {now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        </p>
      </div>
      {error && <ErrorState text={`Some data failed to load: ${error}`} />}
      {overdue.length > 0 && (
        <section aria-label="Overdue urgent reviews" className="rounded-xl border-2 border-destructive/50 bg-destructive-soft p-4">
          <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <b>
                {overdue.length} overdue urgent review{overdue.length === 1 ? '' : 's'}.
              </b>{' '}
              These urgent findings have not been reviewed in time. Review them now; escalation stops once a review is recorded.
            </span>
          </p>
          <div className="mt-2 rounded-lg bg-card px-3">
            <MonitorList items={overdue} empty="">
              {(e) => (
                <div className="mt-1 space-y-1">
                  <p className="text-xs">
                    <span className="font-semibold text-destructive">{ESCALATION_LEVEL[e.level]}</span> · {ESCALATION_REASON[e.reason]} · found{' '}
                    {formatDate(e.finding_at)} {timeOf(e.finding_at)}
                  </p>
                  <FindingReview
                    review={null}
                    patientId={e.patient_id}
                    assessmentId={e.assessment_id ?? undefined}
                    ecgAnalysisId={e.ecg_analysis_id ?? undefined}
                    findings={[ESCALATION_REASON[e.reason]]}
                  />
                </div>
              )}
            </MonitorList>
          </div>
        </section>
      )}
      {critical > 0 && (
        <Link
          to="/doctor/patients?priority=critical"
          className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive-soft px-4 py-3 text-sm text-destructive transition-colors hover:border-destructive"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <b>
              {critical} critical patient{critical === 1 ? '' : 's'}.
            </b>{' '}
            Their latest AI check found a worsening trend that needs your review soon. View them →
          </span>
        </Link>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {cards.map((st) => {
          const highlighted = st.tone && st.value > 0;
          const inner = (
            <>
              <st.icon
                className={cn(
                  'h-5 w-5',
                  highlighted ? (st.tone === 'urgent' ? 'text-destructive' : 'text-warning') : st.ai ? 'text-ai' : 'text-primary'
                )}
              />
              <p className={cn('mt-2 font-display text-2xl font-bold', highlighted && (st.tone === 'urgent' ? 'text-destructive' : 'text-warning'))}>
                {st.value ?? '—'}
              </p>
              <p className="text-xs text-muted-foreground">
                {st.label}
                {st.ai && ' · AI'}
              </p>
            </>
          );
          const cls = cn(
            'rounded-xl border bg-card p-4 shadow-card',
            highlighted && (st.tone === 'urgent' ? 'border-destructive/40 bg-destructive-soft' : 'border-warning/40 bg-warning-soft')
          );
          return st.to ? (
            <Link key={st.label} to={st.to} className={cn(cls, 'transition-all hover:-translate-y-0.5 hover:border-primary')}>
              {inner}
            </Link>
          ) : (
            <div key={st.label} className={cls}>
              {inner}
            </div>
          );
        })}
      </div>
      {critical === 0 && needsReview === 0 && (
        <p className="text-xs text-muted-foreground">Critical and review counts appear after you run the AI analysis on a patient's profile.</p>
      )}
      {monitoring && (
        <Section
          title="Patient monitoring · AI"
          action={updating > 0 && <span className="text-xs text-muted-foreground" role="status">Updating {updating} patient{updating === 1 ? '' : 's'}…</span>}
        >
          <p className="mb-3 text-xs text-muted-foreground">
            Whether recorded values moved toward or away from target since the last check. Decision support, not a diagnosis.
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Object.entries(TREND).map(([value, info]) => {
              const count = patientsLoading || prioritiesLoading ? null : monitored.filter((m) => m.a.health_trend === value).length;
              return (
                <Link
                  key={value}
                  to={`/doctor/patients?trend=${info.filter}`}
                  className={cn('rounded-xl border p-4 transition-all hover:-translate-y-0.5 hover:border-primary', count > 0 && TREND_PILL[info.cls])}
                >
                  <p className="font-display text-2xl font-bold">{count ?? '—'}</p>
                  <p className="text-xs">
                    <span aria-hidden>{info.arrow}</span> {info.label}
                  </p>
                </Link>
              );
            })}
          </div>
          <div className="mt-5 grid gap-5 lg:grid-cols-3">
            <div>
              <h3 className="mb-1 text-sm font-semibold">{reviews.available ? 'Needs review' : 'Needs attention'}</h3>
              <MonitorList items={toReview}empty={reviews.available ? 'No significant finding is waiting for review.' : 'No patient is worsening.'}>
                {(item) => (
                  <>
                    {item.a ? (
                      <>
                        <p className="text-xs text-muted-foreground">
                          <TrendPill value={item.a.health_trend} /> Checked {formatDate(item.a.created_at)}
                          {item.a.trigger_event && ` · ${TRIGGER_LABEL[item.a.trigger_event] ?? item.a.trigger_event}`}
                        </p>
                        <ul className="mt-1 list-disc pl-4 text-xs">
                          {(item.a.reasons ?? []).slice(0, 2).map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                        {(item.a.treatments ?? []).map((t) => (
                          <p key={`${t.medicine}:${t.metric}`} className="text-xs text-muted-foreground">
                            {t.medicine}: {TREATMENT_STATUS[t.status]?.label ?? t.status}
                          </p>
                        ))}
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">ECG analysed {formatDate(item.ecg.created_at)}</p>
                    )}
                    {item.findings && (
                      <div className="mt-1 space-y-1">
                        <p className="text-xs font-medium">{item.findings.join(' · ')}</p>
                        <FindingReview
                          review={null}
                          patientId={item.patient.patient_id}
                          assessmentId={item.a?.id}
                          ecgAnalysisId={item.ecg?.id}
                          findings={item.findings}
                          evidence={item.a?.reasons ?? []}
                        />
                      </div>
                    )}
                  </>
                )}
              </MonitorList>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold">Improving</h3>
              <MonitorList items={withTrend('IMPROVING')} empty="No patient is improving yet.">
                {({ a }) => (
                  <p className="text-xs text-muted-foreground">
                    Checked {formatDate(a.created_at)}
                    {a.reasons?.[0] && ` · ${a.reasons[0]}`}
                  </p>
                )}
              </MonitorList>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold">Follow-ups due</h3>
              <MonitorList items={followUps} empty="No follow-up test is due.">
                {(t) => (
                  <p className={cn('text-xs', t.overdue ? 'text-destructive' : 'text-muted-foreground')}>
                    {t.medicine}: {t.metric_label} due {formatDate(t.due_from)}–{formatDate(t.due_by)}
                    {t.overdue && ' · overdue'}
                  </p>
                )}
              </MonitorList>
            </div>
          </div>
        </Section>
      )}
      <div className="grid gap-5 lg:grid-cols-[1fr_1.4fr]">
        <div className="rounded-xl bg-hero p-5 text-navy-foreground shadow-card">
          <h2 className="text-lg font-semibold">Start with a Patient ID</h2>
          <p className="mt-1 text-sm opacity-85">
            Ask the patient for their MEDIS ID (e.g. MEDIS-P-2026-00125). Opening the record is logged and visible to them.
          </p>
          <Button variant="secondary" className="mt-4" asChild>
            <Link to="/doctor/search">
              <Search className="h-4 w-4" />
              Search patient
            </Link>
          </Button>
        </div>
        <Section title="Upcoming appointments">
          {openAppointments.length === 0 ? (
            <EmptyState text="No upcoming appointments." />
          ) : (
            <ul className="divide-y">
              {openAppointments.map((a) => {
                const isNow = isAppointmentNow(a, now);
                return (
                  <li key={a.id} className="flex flex-wrap items-center gap-3 py-2.5">
                    <div className="w-20 text-sm">
                      <p className="font-semibold">{timeOf(a.scheduled_at)}</p>
                      <p className="text-xs text-muted-foreground">{formatDate(a.scheduled_at)}</p>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {a.profiles?.full_name ?? 'Patient'}{' '}
                        {isNow && <span className="ml-1 rounded-full bg-destructive px-2 py-0.5 text-[10px] font-bold text-destructive-foreground">NOW</span>}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {a.profiles?.display_id}
                        {a.reason && ` · ${a.reason}`}
                      </p>
                    </div>
                    <Button size="sm" variant={isNow ? 'default' : 'outline'} disabled={openingId === a.id} onClick={() => openAppointment(a)}>
                      {openingId === a.id ? 'Opening...' : 'Open'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>
      <Section title="Recently accessed patients">
        {patientsLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : recentPatients.length === 0 ? (
          <EmptyState text="You haven't opened any records yet." />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {recentPatients.map((p) => (
              <li key={p.patient_id}>
                <Link
                  to={`/doctor/patients/${p.patient_id}`}
                  className="flex items-center justify-between gap-2 rounded-lg border p-3 transition-colors hover:border-primary hover:bg-muted/50"
                >
                  <div>
                    <p className="text-sm font-medium">{p.profiles?.full_name || 'Unnamed patient'}</p>
                    <p className="text-xs text-muted-foreground">Access since {formatDate(p.assigned_at)}</p>
                  </div>
                  <IDChip id={p.profiles?.display_id} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
