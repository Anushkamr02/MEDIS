import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { CalendarClock, FilePen, FileText, HeartPulse, History, LayoutDashboard, Pill, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabaseClient';
import { usePatientRecord } from '../../hooks/useDoctorData';
import { logPatientAccess } from '../../lib/patientAccess';
import { formatDate, formatDateTime, calcAge, calcBmi, humanize } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Button, SimpleSelect } from '../../components/ui';
import { EmptyState, ErrorState, Field, IDChip, Section, Spinner, WarningState } from '../../components/medis';
import DocumentUpload from '../../components/DocumentUpload';
import MedicalDocumentsPanel from '../../components/MedicalDocumentsPanel';
import MedicationForm from '../../components/MedicationForm';
import HistoryForm from '../../components/HistoryForm';
import VisitHistoryPanel from '../../components/VisitHistoryPanel';
import PrescriptionsPanel from '../../components/PrescriptionsPanel';
import AccessEventsPanel from '../../components/AccessEventsPanel';
import AccessHistory from '../../components/AccessHistory';
import AiInsights from '../../components/ai/AiInsights';
import EcgAnalysis from '../../components/ai/EcgAnalysis';
import DocumentAiActions from '../../components/ai/DocumentAiActions';
import PrescriptionPdfButton from '../../components/ai/PrescriptionPdfButton';

const REVIEW_OPTIONS = [
  { value: 'pending_review', label: 'Pending review' },
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'verified', label: 'Verified' },
  { value: 'requires_clarification', label: 'Needs clarification' },
];

const QUICK_ACTIONS = [
  { key: 'medication', label: 'Add medication' },
  { key: 'condition', label: 'Add condition' },
  { key: 'family', label: 'Add family history' },
  { key: 'report', label: 'Upload test report' },
];

/** The record's top navigation. `tab` is the ?tab= value, so links are shareable. */
const TABS = [
  { key: 'overview', label: 'Patient Overview', icon: LayoutDashboard },
  { key: 'ecg', label: 'ECG Analysis', icon: HeartPulse },
  { key: 'add-record', label: 'Add Record & Medical Documents', icon: FileText },
  { key: 'visits', label: 'Visit History', icon: History },
  { key: 'prescriptions', label: 'Prescriptions', icon: Pill },
];

function formatConditionValue(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The doctor's "360 view" of one patient — everything they should see
 * before starting a consultation, plus direct data entry (reports,
 * medications, history). Visits and access history span every doctor
 * and hospital. Access is enforced by RLS; without an assignment the
 * profile query comes back empty and we show a no-access message.
 *
 * The record is split into five sections by the top navigation. Only the
 * selected section is mounted, so opening a patient does not run the ECG
 * queries or the document list until that section is asked for.
 */
export default function PatientProfile() {
  const { patientId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { doctorProfile } = useOutletContext() ?? {};
  const {
    profile,
    details,
    medications,
    history,
    familyHistory,
    visits,
    accessHistory,
    prescriptions,
    documents,
    hospitals,
    loading,
    error,
    refresh,
  } = usePatientRecord(patientId);

  const [panel, setPanel] = useState(null);
  const [updatingDocId, setUpdatingDocId] = useState(null);
  const loggedView = useRef(false);

  const requested = searchParams.get('tab');
  const tab = TABS.some((t) => t.key === requested) ? requested : 'overview';

  // Set when the doctor arrived by clicking an appointment
  const appointment = location.state?.appointment ?? null;

  // One 'viewed_patient' audit entry per page open. It goes through
  // log_patient_access(), so the database sets the time and confirms this
  // doctor really has access before recording anything.
  useEffect(() => {
    if (!profile || !user?.id || loggedView.current) return;
    loggedView.current = true;
    logPatientAccess(profile.id, 'viewed_patient');
  }, [profile, user?.id]);

  function selectTab(key) {
    const next = new URLSearchParams(searchParams);
    if (key === 'overview') next.delete('tab');
    else next.set('tab', key);
    setSearchParams(next, { replace: false });
  }

  function startConsultation(focus) {
    navigate(`/doctor/patients/${patientId}/consult`, {
      state: { appointmentId: appointment?.id ?? null, focus: focus ?? null },
    });
  }

  function closePanelAndRefresh() {
    setPanel(null);
    refresh();
  }

  async function updateReviewStatus(doc, status) {
    setUpdatingDocId(doc.id);
    const { error: updateError } = await supabase
      .from('medical_reports')
      .update({
        review_status: status,
        reviewing_doctor_id: user.id,
        is_verified: status === 'verified',
      })
      .eq('id', doc.id);
    setUpdatingDocId(null);

    if (updateError) {
      toast.error(updateError.message);
      return;
    }
    logPatientAccess(patientId, 'updated_record', { document: doc.file_name, review_status: status });
    toast.success('Review status updated');
    refresh();
  }

  async function stopMedication(med) {
    if (!window.confirm(`Mark ${med.medicine_name} as no longer taken?`)) return;
    const { error: updateError } = await supabase
      .from('current_medications')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', med.id);
    if (updateError) {
      toast.error(updateError.message);
      return;
    }
    logPatientAccess(patientId, 'updated_record', { stopped_medication: med.medicine_name });
    refresh();
  }

  if (loading) return <Spinner text="Loading patient record..." />;

  if (!profile) {
    return (
      <div className="space-y-3">
        <EmptyState
          text="You don't have access to this record yet. You can only view patients whose record you've opened via their Patient ID or an appointment."
          action={
            <Button asChild size="sm">
              <Link to="/doctor/search">Search patient</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const age = calcAge(profile.date_of_birth);
  const bmi = calcBmi(details?.height_cm, details?.weight_kg);
  const conditions = Object.entries(details?.known_conditions ?? {}).filter(([, v]) => v !== false && v !== null && v !== '');
  const myDraft = visits.find((v) => v.status === 'pending' && v.doctor_id === user.id);

  return (
    <div className="min-w-0 space-y-5">
      {error && <ErrorState text={`Some data failed to load: ${error}`} onRetry={refresh} />}

      {appointment && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary-soft px-4 py-2.5 text-sm text-primary">
          <CalendarClock className="h-4 w-4" />
          <b>Appointment · {formatDateTime(appointment.scheduled_at)}:</b> {appointment.reason || 'No reason given'}
          <Button size="sm" className="ml-auto" onClick={() => startConsultation()}>
            {myDraft ? 'Resume consultation' : 'Start consultation'}
          </Button>
        </div>
      )}

      <div className="rounded-xl border bg-card p-4 shadow-card sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-bold">{profile.full_name || 'Unnamed patient'}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <IDChip id={profile.display_id} />
              {age ?? '—'} y · {humanize(profile.gender) || '—'} · Blood group {details?.blood_group || '—'}
              {profile.phone && ` · ${profile.phone}`}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => startConsultation('prescription')}>
              <Pill className="h-4 w-4" />
              Write prescription
            </Button>
            <Button onClick={() => startConsultation()}>
              <FilePen className="h-4 w-4" />
              {myDraft ? 'Resume consultation' : 'Start consultation'}
            </Button>
            <PrescriptionPdfButton path={`/pdf/history/${patientId}`} label="Download history PDF" size="default" />
          </div>
        </div>
        {myDraft && (
          <p className="mt-3 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
            You have a draft consultation for this patient ({myDraft.visit_id}, started {formatDateTime(myDraft.consultation_date)}).{' '}
            <button className="font-semibold underline" onClick={() => navigate(`/doctor/consultations/${myDraft.consultation_id}`)}>
              Resume it
            </button>
          </p>
        )}
      </div>

      {/* ---------- Record sections ---------- */}
      <div role="tablist" aria-label="Patient record" className="flex flex-wrap gap-1 rounded-xl border bg-card p-1.5 shadow-card">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            onClick={() => selectTab(item.key)}
            className={cn(
              'inline-flex min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              'hover:bg-primary-soft hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              tab === item.key ? 'bg-primary-soft text-primary shadow-card' : 'text-muted-foreground'
            )}
          >
            <item.icon className="h-4 w-4 shrink-0" aria-hidden />
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </div>

      <div key={tab} className="content-enter min-w-0 space-y-5">
        {/* ---------- Patient Overview ---------- */}
        {tab === 'overview' && (
          <>
            {!details && <WarningState>This patient hasn't completed their onboarding profile yet. Vitals and lifestyle details are missing.</WarningState>}

            <AiInsights
              patientId={patientId}
              reviewRequested={searchParams.get('review') === 'ai'}
              onOpenVisit={(visitId) => {
                const v = visits.find((x) => x.visit_id === visitId);
                if (v) navigate(`/doctor/consultations/${v.consultation_id}`);
              }}
            />

            <div className="grid min-w-0 gap-5 lg:grid-cols-2">
              <Section title="Vitals & lifestyle">
                <dl className="grid grid-cols-2 gap-3">
                  <Field label="Blood group" value={details?.blood_group} />
                  <Field label="Height" value={details?.height_cm && `${details.height_cm} cm`} />
                  <Field label="Weight" value={details?.weight_kg && `${details.weight_kg} kg`} />
                  <Field label="BMI" value={bmi} />
                  <Field label="Smoking" value={humanize(details?.smoking_status)} />
                  <Field label="Alcohol" value={humanize(details?.alcohol_use)} />
                  <Field label="Allergies" value={details?.allergies} />
                  <Field label="Emergency contact" value={details?.emergency_contact} />
                </dl>
              </Section>
              <div className="min-w-0 space-y-5">
                <Section title="Known conditions & risk factors">
                  {conditions.length ? (
                    <div className="flex flex-wrap gap-2">
                      {conditions.map(([key, value]) => (
                        <span key={key} className="rounded-full bg-primary-soft px-3 py-1 text-sm font-medium text-primary">
                          {humanize(key)}
                          {value !== true && `: ${formatConditionValue(value)}`}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">—</p>
                  )}
                </Section>
                <Section title="Current medications">
                  {medications.length ? (
                    <ul className="divide-y">
                      {medications.map((m) => (
                        <li key={m.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                          <span className="min-w-0 break-words">
                            <b className="font-medium">{m.medicine_name}</b> {[m.dosage, m.frequency].filter(Boolean).join(' · ')}
                            {m.condition_name && ` · for ${m.condition_name}`}
                          </span>
                          <Button size="sm" variant="ghost" className="shrink-0 text-destructive" onClick={() => stopMedication(m)}>
                            Stop
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyState text="No ongoing medications." />
                  )}
                </Section>
              </div>
            </div>

            <Section title="Medical & family history">
              {history.length === 0 && familyHistory.length === 0 ? (
                <p className="text-sm text-muted-foreground">No history recorded.</p>
              ) : (
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {history.map((h) => (
                    <li key={h.id}>
                      {h.condition_name}
                      {!h.is_active && <span className="text-muted-foreground"> (resolved)</span>}
                      <span className="text-muted-foreground">
                        {' '}
                        · diagnosed {formatDate(h.diagnosed_at)}
                        {h.notes && ` · ${h.notes}`}
                      </span>
                    </li>
                  ))}
                  {familyHistory.map((f) => (
                    <li key={f.id}>
                      {humanize(f.relation)}: {f.condition_name}
                      {f.notes && <span className="text-muted-foreground"> · {f.notes}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <div className="grid min-w-0 gap-5 lg:grid-cols-2">
              <AccessEventsPanel
                patientId={patientId}
                title="Record access log"
                maxHeight="30rem"
                intro="Every access to this record is recorded by the server, including your own, and the patient can see it."
              />
              <Section title="Doctors with access to this record">
                <AccessHistory rows={accessHistory} currentUserId={user.id} />
              </Section>
            </div>
          </>
        )}

        {/* ---------- ECG Analysis ---------- */}
        {tab === 'ecg' && (
          <Section title="ECG analysis" icon={<HeartPulse className="h-4 w-4 text-primary" />}>
            <EcgAnalysis patientId={patientId} documents={documents} />
          </Section>
        )}

        {/* ---------- Add Record & Medical Documents ---------- */}
        {tab === 'add-record' && (
          <>
            <Section title="Add to record">
              <div className="flex flex-wrap gap-2">
                {QUICK_ACTIONS.map((a) => (
                  <Button
                    key={a.key}
                    size="sm"
                    variant={panel === a.key ? 'default' : 'outline'}
                    aria-expanded={panel === a.key}
                    onClick={() => setPanel(panel === a.key ? null : a.key)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {a.label}
                  </Button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Prescriptions belong to a visit, so "Write prescription" opens (or resumes) a consultation.
              </p>
              {panel && (
                <div className="mt-3">
                  {panel === 'report' && (
                    <DocumentUpload
                      patientId={patientId}
                      doctorId={user.id}
                      hospitals={hospitals}
                      defaultHospitalId={doctorProfile?.hospital_id ?? ''}
                      showList={false}
                      onUploaded={closePanelAndRefresh}
                    />
                  )}
                  {panel === 'medication' && (
                    <MedicationForm patientId={patientId} doctorId={user.id} onSaved={closePanelAndRefresh} onCancel={() => setPanel(null)} />
                  )}
                  {(panel === 'condition' || panel === 'family') && (
                    <HistoryForm
                      key={panel}
                      type={panel === 'family' ? 'family' : 'medical'}
                      patientId={patientId}
                      doctorId={user.id}
                      onSaved={closePanelAndRefresh}
                      onCancel={() => setPanel(null)}
                    />
                  )}
                </div>
              )}
            </Section>

            <MedicalDocumentsPanel
              patientId={patientId}
              documents={documents}
              hospitals={hospitals}
              doctorId={user.id}
              defaultHospitalId={doctorProfile?.hospital_id ?? ''}
              onChanged={refresh}
              maxHeight="min(70dvh, 46rem)"
              renderExtra={(d) => (
                <div className="mt-2 space-y-2 border-t pt-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">Review status</span>
                    <div className="w-48">
                      <SimpleSelect
                        value={d.review_status ?? 'pending_review'}
                        onChange={(v) => updateReviewStatus(d, v)}
                        disabled={updatingDocId === d.id}
                        ariaLabel={`Review status for ${d.file_name}`}
                        options={REVIEW_OPTIONS.map((o) => [o.value, o.label])}
                      />
                    </div>
                  </div>
                  <DocumentAiActions doc={d} />
                </div>
              )}
            />
          </>
        )}

        {/* ---------- Visit History ---------- */}
        {tab === 'visits' && (
          <VisitHistoryPanel
            visits={visits}
            viewer="doctor"
            currentUserId={user.id}
            onOpen={(v) => navigate(`/doctor/consultations/${v.consultation_id}`)}
            title="Visit history (all doctors and hospitals)"
            maxHeight="min(70dvh, 48rem)"
          />
        )}

        {/* ---------- Prescriptions ---------- */}
        {tab === 'prescriptions' && (
          <PrescriptionsPanel
            prescriptions={prescriptions.map((p) => ({ ...p, profiles: p.doctor ?? p.profiles }))}
            visits={visits}
            title="Prescriptions (all visits)"
            maxHeight="min(70dvh, 48rem)"
          />
        )}
      </div>
    </div>
  );
}
