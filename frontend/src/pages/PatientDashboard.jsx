import { useMemo } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import {
  Activity,
  CalendarDays,
  ClipboardList,
  FileText,
  History,
  HeartPulse,
  Pill,
  ShieldCheck,
  Stethoscope,
  UserPen,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { formatDate, formatDateTime, calcAge, humanize } from '../lib/format';
import { categoryLabel } from '../components/DocumentUpload';
import PatientAppointments from '../components/PatientAppointments';
import HeartHealthCheck from '../components/HeartHealthCheck';
import EcgResult from '../components/ai/EcgResult';
import PrescriptionPdfButton from '../components/ai/PrescriptionPdfButton';
import {
  EmptyState,
  ErrorState,
  Field,
  IDChip,
  ScrollPanel,
  Section,
  Spinner,
  StatusPill,
  WarningState,
  pillValue,
} from '../components/medis';
import { Button } from '../components/ui';

/** Initials stand in for a profile picture: the record stores no photo. */
function initialsOf(name) {
  return (name || 'P')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

// Each action goes somewhere real: either another section of the
// dashboard, or a panel further down this page.
const QUICK_ACTIONS = [
  { to: '/patient/prescriptions', label: 'View Prescriptions', icon: Pill },
  { to: '/patient/documents', label: 'View Medical Documents', icon: FileText },
  { to: '/patient/visits', label: 'View Visit History', icon: History },
  { anchor: 'appointments', label: 'View Appointments', icon: CalendarDays },
  { anchor: 'ecg', label: 'View ECG Reports', icon: HeartPulse },
];

/** Scrolls to a panel on this page and moves focus there for keyboard users. */
function revealPanel(id) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const heading = target.querySelector('h2');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
}

/**
 * The patient's Dashboard section: who they are, a health overview drawn
 * from their own record, quick links into the other four sections, and a
 * timeline of their real recorded activity.
 *
 * Everything here comes from the record loaded once in PatientLayout, so
 * no widget invents a value: where there is nothing recorded it says so.
 */
export default function PatientDashboard() {
  const { user, profile } = useAuth();
  const {
    vitals,
    medications,
    prescriptions,
    appointments,
    documents,
    visits,
    accessHistory,
    ecgAnalyses,
    loading,
    error,
    refresh,
  } = useOutletContext();

  const upcoming = useMemo(
    () => appointments.filter((a) => a.status === 'scheduled' && new Date(a.scheduled_at) >= new Date()),
    [appointments]
  );

  // One timeline from everything that actually happened on this record.
  const activity = useMemo(() => {
    const events = [
      ...visits.map((v) => ({
        key: `visit-${v.consultation_id}`,
        at: v.consultation_date,
        icon: Stethoscope,
        title: v.status === 'pending' ? 'Consultation started' : 'Visit recorded',
        detail: [v.doctor_name && `Dr. ${v.doctor_name}`, v.hospital_name, v.final_diagnosis].filter(Boolean).join(' · '),
      })),
      ...prescriptions.map((p) => ({
        key: `rx-${p.id}`,
        at: p.issued_at,
        icon: Pill,
        title: 'Prescription issued',
        detail: [p.profiles?.full_name && `Dr. ${p.profiles.full_name}`, (p.medicines ?? []).map((m) => m.name).filter(Boolean).join(', ')]
          .filter(Boolean)
          .join(' · '),
      })),
      ...documents.map((d) => ({
        key: `doc-${d.id}`,
        at: d.uploaded_at,
        icon: FileText,
        title: `${categoryLabel(d.category)} uploaded`,
        detail: [d.file_name, d.hospitals?.name].filter(Boolean).join(' · '),
      })),
      ...appointments.map((a) => ({
        key: `appt-${a.id}`,
        at: a.scheduled_at,
        icon: CalendarDays,
        title: a.status === 'scheduled' ? 'Appointment scheduled' : `Appointment ${humanize(a.status).toLowerCase()}`,
        detail: [a.profiles?.full_name && `Dr. ${a.profiles.full_name}`, a.reason].filter(Boolean).join(' · '),
      })),
      ...ecgAnalyses.map((e) => ({
        key: `ecg-${e.id}`,
        at: e.created_at,
        icon: HeartPulse,
        title: 'ECG analysed',
        detail: [e.file_name, e.classification && humanize(e.classification)].filter(Boolean).join(' · '),
      })),
    ];
    return events
      .filter((e) => e.at && !Number.isNaN(new Date(e.at).getTime()))
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, 30);
  }, [visits, prescriptions, documents, appointments, ecgAnalyses]);

  if (loading) return <Spinner text="Loading your dashboard..." />;

  const firstName = (profile?.full_name || 'there').split(' ')[0];
  const lastVisit = visits.find((v) => v.status !== 'pending');
  const latestEcg = ecgAnalyses[0];
  const age = calcAge(profile?.date_of_birth);

  return (
    <div className="content-enter space-y-5">
      {error && <ErrorState text={`Some data failed to load: ${error}`} onRetry={refresh} />}
      {!vitals && (
        <WarningState>
          You haven't completed your profile yet.{' '}
          <Link to="/patient/onboarding" className="font-semibold underline">
            Fill it in now
          </Link>{' '}
          so your doctors have the full picture.
        </WarningState>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Hello, {firstName}</h1>
          <p className="text-sm text-muted-foreground">Here's everything your doctors have shared with you.</p>
        </div>
        <PrescriptionPdfButton path={`/pdf/history/${user?.id}`} label="Download my history (PDF)" size="default" busyLabel="Generating…" />
      </div>

      {/* ---------- Patient information ---------- */}
      <section className="rounded-xl border bg-card p-4 shadow-card sm:p-5">
        <div className="flex flex-wrap items-start gap-4">
          <span
            aria-hidden
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-primary-soft font-display text-xl font-bold text-primary"
          >
            {initialsOf(profile?.full_name)}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-xl font-bold">{profile?.full_name || 'Patient'}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <IDChip id={profile?.display_id} />
              <span className="text-sm text-muted-foreground">Your permanent MEDIS Patient ID</span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Age" value={age !== null && age !== undefined ? `${age} years` : null} />
              <Field label="Gender" value={humanize(profile?.gender)} />
              <Field label="Blood group" value={vitals?.blood_group} />
              <Field label="Phone" value={profile?.phone} />
              <Field label="Email" value={profile?.email} />
              <Field label="Emergency contact" value={vitals?.emergency_contact} />
              <Field label="Allergies" value={vitals?.allergies} />
              <Field label="Ongoing medicines" value={medications.length ? `${medications.length}` : 'None recorded'} />
            </dl>
          </div>
          <div className="flex flex-col gap-2">
            <Button asChild>
              <Link to="/patient/onboarding">
                <UserPen className="h-4 w-4" />
                Edit profile
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/patient/profile">View full profile</Link>
            </Button>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Your record holds no profile photo, so your initials are shown here.
        </p>
      </section>

      {/* ---------- Quick actions ---------- */}
      <Section title="Quick actions" icon={<Activity className="h-4 w-4 text-primary" />}>
        <div className="flex flex-wrap gap-2">
          {QUICK_ACTIONS.map((action) =>
            action.to ? (
              <Button key={action.label} asChild variant="outline" size="sm">
                <Link to={action.to}>
                  <action.icon className="h-3.5 w-3.5" />
                  {action.label}
                </Link>
              </Button>
            ) : (
              <Button key={action.label} variant="outline" size="sm" onClick={() => revealPanel(action.anchor)}>
                <action.icon className="h-3.5 w-3.5" />
                {action.label}
              </Button>
            )
          )}
          <Button asChild variant="outline" size="sm">
            <Link to="/patient/access">
              <ShieldCheck className="h-3.5 w-3.5" />
              Who accessed my profile
            </Link>
          </Button>
        </div>
      </Section>

      {/* ---------- Health overview ---------- */}
      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <ScrollPanel title="Health overview" icon={<HeartPulse className="h-4 w-4 text-primary" />} maxHeight="30rem">
          <div className="space-y-3">
            <div className="rounded-lg border p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent ECG analysis</p>
              {latestEcg ? (
                <div className="mt-2">
                  <EcgResult
                    status={latestEcg.status}
                    classification={latestEcg.classification}
                    result={latestEcg.result}
                    fileName={latestEcg.file_name}
                    createdAt={latestEcg.created_at}
                  />
                </div>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">No ECG has been analysed for you yet.</p>
              )}
            </div>

            <div className="rounded-lg border p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Latest medical records</p>
              {documents.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">No documents in your record yet.</p>
              ) : (
                <ul className="mt-1.5 space-y-1.5">
                  {documents.slice(0, 3).map((d) => (
                    <li key={d.id} className="break-words text-sm">
                      {categoryLabel(d.category)} <span className="text-muted-foreground">· {formatDate(d.uploaded_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <Button asChild size="sm" variant="ghost" className="mt-1.5 -ml-2">
                <Link to="/patient/documents">All documents</Link>
              </Button>
            </div>

            <div className="rounded-lg border p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent prescriptions</p>
              {prescriptions.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">No prescriptions yet.</p>
              ) : (
                <ul className="mt-1.5 space-y-1.5">
                  {prescriptions.slice(0, 3).map((p) => (
                    <li key={p.id} className="break-words text-sm">
                      {formatDate(p.issued_at)}
                      <span className="text-muted-foreground">
                        {p.profiles?.full_name && ` · Dr. ${p.profiles.full_name}`}
                        {(p.medicines ?? []).length ? ` · ${(p.medicines ?? []).map((m) => m.name).filter(Boolean).join(', ')}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Button asChild size="sm" variant="ghost" className="mt-1.5 -ml-2">
                <Link to="/patient/prescriptions">All prescriptions</Link>
              </Button>
            </div>

            <div className="rounded-lg border p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Last hospital visit</p>
              {lastVisit ? (
                <p className="mt-1 break-words text-sm">
                  {formatDateTime(lastVisit.consultation_date)}
                  <span className="block text-muted-foreground">
                    Dr. {lastVisit.doctor_name || '—'} · {lastVisit.hospital_name || 'Hospital not recorded'}
                    {lastVisit.final_diagnosis && ` · ${lastVisit.final_diagnosis}`}
                  </span>
                </p>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">No completed visit recorded yet.</p>
              )}
              <Button asChild size="sm" variant="ghost" className="mt-1.5 -ml-2">
                <Link to="/patient/visits">All visits</Link>
              </Button>
            </div>

            <div className="rounded-lg border p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Upcoming appointments</p>
              {upcoming.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">No upcoming appointments.</p>
              ) : (
                <ul className="mt-1.5 space-y-1.5">
                  {upcoming.slice(0, 3).map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2 break-words text-sm">
                      {formatDateTime(a.scheduled_at)}
                      <span className="text-muted-foreground">Dr. {a.profiles?.full_name ?? '—'}</span>
                      <StatusPill value={pillValue(a.status)} />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-lg border p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Doctors with access</p>
              <p className="mt-1 text-sm">
                {accessHistory.length === 0
                  ? 'No doctor has opened your record yet.'
                  : `${accessHistory.length} doctor${accessHistory.length === 1 ? '' : 's'} can see your record.`}
              </p>
              <Button asChild size="sm" variant="ghost" className="mt-1.5 -ml-2">
                <Link to="/patient/access">See every access</Link>
              </Button>
            </div>
          </div>
        </ScrollPanel>

        {/* ---------- Recent activity ---------- */}
        <ScrollPanel
          title="Recent activity"
          icon={<ClipboardList className="h-4 w-4 text-primary" />}
          maxHeight="30rem"
          footer={activity.length ? `Your ${activity.length} most recent recorded events.` : undefined}
        >
          {activity.length === 0 ? (
            <EmptyState text="Nothing has been recorded on your profile yet." />
          ) : (
            <ol className="relative space-y-3 border-l-2 border-primary/20 pl-5">
              {activity.map((event) => (
                <li key={event.key} className="relative min-w-0">
                  <span className="absolute -left-[27px] top-1.5 h-3 w-3 rounded-full border-2 border-card bg-primary" aria-hidden />
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <event.icon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                    {event.title}
                  </p>
                  <p className="text-xs text-muted-foreground">{formatDateTime(event.at)}</p>
                  {event.detail && <p className="break-words text-sm text-muted-foreground">{event.detail}</p>}
                </li>
              ))}
            </ol>
          )}
        </ScrollPanel>
      </div>

      {/* ---------- ECG reports and shared screening ---------- */}
      <Section id="ecg" title="ECG and heart health" icon={<HeartPulse className="h-4 w-4 text-primary" />}>
        <div className="space-y-3">
          <HeartHealthCheck patientId={user?.id} />
          {ecgAnalyses.length === 0 ? (
            <EmptyState text="No ECG reports analysed yet. Your doctor runs the analysis during a consultation." />
          ) : (
            <div className="space-y-2">
              {ecgAnalyses.map((e) => (
                <EcgResult
                  key={e.id}
                  status={e.status}
                  classification={e.classification}
                  result={e.result}
                  fileName={e.file_name}
                  createdAt={e.created_at}
                />
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            ECG reports you upload are stored with your{' '}
            <Link to="/patient/documents" className="font-medium underline">
              medical documents
            </Link>
            .
          </p>
        </div>
      </Section>

      {/* ---------- Appointments ---------- */}
      <PatientAppointments patientId={user?.id} />

      {/* ---------- Current medications ---------- */}
      <Section title="Current medications" icon={<Pill className="h-4 w-4 text-primary" />}>
        {medications.length === 0 ? (
          <EmptyState text="No ongoing medications logged." />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {medications.map((m) => (
              <li key={m.id} className="min-w-0 rounded-lg bg-muted/60 px-3 py-2 text-sm">
                <p className="break-words font-medium">{m.medicine_name}</p>
                <p className="break-words text-xs text-muted-foreground">
                  {[m.dosage, m.frequency].filter(Boolean).join(' · ') || '—'}
                  {m.condition_name && (
                    <>
                      {' '}
                      · for <i>{m.condition_name}</i>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
