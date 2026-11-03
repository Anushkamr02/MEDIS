import { Link } from 'react-router-dom';
import { CalendarDays, ClipboardList, FileText, History, Pill, ShieldCheck, Stethoscope } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { usePatientData } from '../hooks/usePatientData';
import { formatDate, humanize } from '../lib/format';
import DocumentUpload from '../components/DocumentUpload';
import VisitTimeline from '../components/VisitTimeline';
import AccessHistory from '../components/AccessHistory';
import PrescriptionPdfButton, { PrescriptionCard } from '../components/ai/PrescriptionPdfButton';
import HeartHealthCheck from '../components/HeartHealthCheck';
import { EmptyState, ErrorState, IDChip, Section, Spinner, StatusPill, WarningState, pillValue } from '../components/medis';

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function PatientDashboard() {
  const { user, profile } = useAuth();
  const { vitals, medications, history, prescriptions, appointments, documents, hospitals, visits, accessHistory, loading, error, refresh } =
    usePatientData(user?.id);

  if (loading) return <Spinner text="Loading your dashboard..." />;

  const firstName = (profile?.full_name || 'there').split(' ')[0];

  return (
    <div className="space-y-5">
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

      <div className="grid gap-5 lg:grid-cols-2">
        <Section id="appointments" title="Appointments" icon={<CalendarDays className="h-4 w-4 text-primary" />}>
          {appointments.length === 0 ? (
            <EmptyState text="No appointments booked." />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2">Date</th>
                  <th className="pb-2">Doctor</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {appointments.map((a) => (
                  <tr key={a.id}>
                    <td className="py-2">
                      {formatDate(a.scheduled_at)}
                      <span className="block text-xs text-muted-foreground">{timeOf(a.scheduled_at)}</span>
                    </td>
                    <td className="py-2">
                      Dr. {a.profiles?.full_name ?? '—'}
                      {a.reason && <span className="block text-xs text-muted-foreground">{a.reason}</span>}
                    </td>
                    <td className="py-2">
                      <StatusPill value={pillValue(a.status)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-xs text-muted-foreground">Appointments are booked by your doctor.</p>
        </Section>
        <Section title="Current medications" icon={<Pill className="h-4 w-4 text-primary" />}>
          {medications.length === 0 ? (
            <EmptyState text="No ongoing medications logged." />
          ) : (
            <ul className="space-y-2">
              {medications.map((m) => (
                <li key={m.id} className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
                  <p className="font-medium">{m.medicine_name}</p>
                  <p className="text-xs text-muted-foreground">
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

      <Section title="Shared results" icon={<ClipboardList className="h-4 w-4 text-primary" />}>
        <div className="space-y-3">
          <HeartHealthCheck patientId={user?.id} />
          {history.length === 0 ? (
            <EmptyState text="Your doctors haven't shared any results yet." />
          ) : (
            history.map((h) => (
              <article key={h.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-primary-soft px-2 py-0.5 text-xs font-semibold text-primary">
                    {(h.final_diagnosis || humanize(h.disease_type) || 'Visit').split(',')[0]}
                  </span>
                  <StatusPill value={pillValue(h.status, 'visit')} />
                  <IDChip id={h.visit_id} />
                  <span className="text-xs text-muted-foreground">
                    {formatDate(h.consultation_date)} · Dr. {h.profiles?.full_name ?? '—'}
                  </span>
                </div>
                {h.final_diagnosis && <p className="mt-2 text-sm">{h.final_diagnosis}</p>}
                {h.doctor_notes && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    <b className="font-medium text-foreground">Doctor's notes:</b> {h.doctor_notes}
                  </p>
                )}
              </article>
            ))
          )}
        </div>
      </Section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Visit history" icon={<History className="h-4 w-4 text-primary" />}>
          <VisitTimeline visits={visits} viewer="patient" currentUserId={user?.id} />
        </Section>
        <Section title="Prescriptions" icon={<Stethoscope className="h-4 w-4 text-primary" />}>
          {prescriptions.length === 0 ? (
            <EmptyState text="No prescriptions yet." />
          ) : (
            <div className="space-y-2">
              {prescriptions.map((p) => (
                <PrescriptionCard key={p.id} rx={p} />
              ))}
            </div>
          )}
        </Section>
      </div>

      <Section id="documents" title="Medical documents" icon={<FileText className="h-4 w-4 text-primary" />}>
        <DocumentUpload patientId={user?.id} documents={documents} hospitals={hospitals} onUploaded={refresh} />
      </Section>

      <Section id="access" title="Doctors who accessed your record" icon={<ShieldCheck className="h-4 w-4 text-primary" />}>
        <AccessHistory rows={accessHistory} currentUserId={user?.id} />
      </Section>
    </div>
  );
}
