import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabaseClient';
import { usePatientRecord } from '../../hooks/useDoctorData';
import PrescriptionForm from '../../components/PrescriptionForm';
import DocumentUpload from '../../components/DocumentUpload';
import AiInsights from '../../components/ai/AiInsights';
import DocumentAiActions from '../../components/ai/DocumentAiActions';
import { calcAge, calcBmi, formatDate, formatDateTime, humanize } from '../../lib/format';
import { cn } from '../../lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Checkbox,
  Input,
  Label,
  SimpleSelect,
  Switch,
  Textarea,
} from '../../components/ui';
import { BackButton, ErrorState, Field, IDChip, Section, Spinner, StatusPill, pillValue } from '../../components/medis';

const CONSULTATION_SELECT = '*, hospitals(name), doctor:doctor_id(full_name, display_id)';

const COMPLAINT_FLAGS = [
  { key: 'breathlessness', label: 'Breathlessness' },
  { key: 'palpitations', label: 'Palpitations' },
  { key: 'dizziness', label: 'Dizziness' },
  { key: 'sweating', label: 'Sweating' },
  { key: 'fatigue', label: 'Fatigue' },
];

// Structured symptom options. The AI engine reads these through
// backend/adapters.py (_symptoms), which maps them to its own values.
const CHEST_PAIN_TYPES = {
  typical: 'Typical angina',
  atypical: 'Atypical angina',
  non_anginal: 'Non-anginal',
};
const PAIN_RADIATION = {
  none: 'Does not radiate',
  left_arm: 'Left arm',
  jaw: 'Jaw / neck',
  back: 'Back',
  both_arms: 'Both arms',
};
const NYHA_CLASSES = {
  I: 'Class I: only on more than ordinary activity',
  II: 'Class II: on ordinary activity',
  III: 'Class III: on less than ordinary activity',
  IV: 'Class IV: at rest',
};

// min/max/step are sanity limits enforced by the browser on save,
// so obvious typos (e.g. BP 1200) never reach the database.
const VITAL_FIELDS = [
  { key: 'systolic_bp', label: 'Systolic BP', unit: 'mmHg', min: 50, max: 300, step: 1 },
  { key: 'diastolic_bp', label: 'Diastolic BP', unit: 'mmHg', min: 30, max: 200, step: 1 },
  { key: 'heart_rate', label: 'Heart rate', unit: 'bpm', min: 20, max: 250, step: 1 },
  { key: 'respiratory_rate', label: 'Respiratory rate', unit: '/min', min: 4, max: 80, step: 1 },
  { key: 'spo2', label: 'Oxygen saturation', unit: '%', min: 50, max: 100, step: 0.1 },
  { key: 'temperature_c', label: 'Temperature', unit: '°C', min: 30, max: 45, step: 0.1 },
  { key: 'height_cm', label: 'Height', unit: 'cm', min: 30, max: 250, step: 0.1 },
  { key: 'weight_kg', label: 'Weight', unit: 'kg', min: 2, max: 400, step: 0.1 },
];

// Numeric labs (migration v4). Keys and units match the AI engine's
// metrics (backend/medis/ai/trajectories.py), which reads them as-is.
const LAB_FIELDS = [
  { key: 'total_cholesterol', label: 'Total cholesterol', unit: 'mg/dL', min: 1, max: 1500, step: 0.1 },
  { key: 'ldl_cholesterol', label: 'LDL', unit: 'mg/dL', min: 1, max: 1000, step: 0.1 },
  { key: 'hdl_cholesterol', label: 'HDL', unit: 'mg/dL', min: 1, max: 250, step: 0.1 },
  { key: 'triglycerides', label: 'Triglycerides', unit: 'mg/dL', min: 1, max: 10000, step: 0.1 },
  { key: 'fasting_glucose', label: 'Fasting glucose', unit: 'mg/dL', min: 10, max: 1500, step: 0.1 },
  { key: 'hba1c', label: 'HbA1c', unit: '%', min: 2, max: 25, step: 0.1 },
  { key: 'serum_creatinine', label: 'Creatinine', unit: 'mg/dL', min: 0.1, max: 30, step: 0.01 },
  { key: 'egfr', label: 'eGFR', unit: 'mL/min/1.73m²', min: 1, max: 200, step: 0.1 },
];

const OBSERVATION_FIELDS = [
  { key: 'general', label: 'General examination' },
  { key: 'cardiovascular', label: 'Cardiovascular examination' },
  { key: 'respiratory', label: 'Respiratory examination' },
  { key: 'ecg', label: 'ECG observations' },
  { key: 'blood_report', label: 'Blood report observations' },
  { key: 'physical', label: 'Physical examination' },
];

const ASSESSMENT_FIELDS = [
  { key: 'clinical_assessment', label: 'Clinical assessment' },
  { key: 'suspected_conditions', label: 'Suspected conditions' },
  { key: 'cad_risk_assessment', label: 'CAD risk assessment' },
  { key: 'supporting_findings', label: 'Supporting findings' },
  { key: 'recommended_investigations', label: 'Recommended investigations' },
];

function emptyForm() {
  return {
    complaints: {
      main_complaint: '',
      chest_pain: '',
      chest_pain_duration: '',
      pain_location: '',
      pain_severity: '',
      chest_pain_type: '',
      pain_radiation: '',
      pain_at_rest: '',
      syncope: '',
      nyha_class: '',
      ...Object.fromEntries(COMPLAINT_FLAGS.map((f) => [f.key, false])),
      other_symptoms: '',
    },
    vitals: Object.fromEntries(VITAL_FIELDS.map((f) => [f.key, ''])),
    labs: Object.fromEntries(LAB_FIELDS.map((f) => [f.key, ''])),
    labs_source: '',
    observations: {
      ...Object.fromEntries(OBSERVATION_FIELDS.map((f) => [f.key, ''])),
      additional: '',
    },
    assessment: Object.fromEntries(ASSESSMENT_FIELDS.map((f) => [f.key, ''])),
    preliminary_diagnosis: '',
    final_diagnosis: '',
    doctor_notes: '',
    follow_up_date: '',
  };
}

function formFromRow(row) {
  const base = emptyForm();
  return {
    complaints: { ...base.complaints, ...(row.complaints ?? {}) },
    vitals: Object.fromEntries(VITAL_FIELDS.map((f) => [f.key, row[f.key] ?? ''])),
    labs: Object.fromEntries(LAB_FIELDS.map((f) => [f.key, row[f.key] ?? ''])),
    labs_source: row.labs_source ?? '',
    observations: { ...base.observations, ...(row.observations ?? {}) },
    assessment: { ...base.assessment, ...(row.assessment ?? {}) },
    preliminary_diagnosis: row.preliminary_diagnosis ?? '',
    final_diagnosis: row.final_diagnosis ?? '',
    doctor_notes: row.doctor_notes ?? '',
    follow_up_date: row.follow_up_date ?? '',
  };
}

function toNumber(value) {
  return value === '' || value === null || value === undefined ? null : Number(value);
}

function rowFromForm(form) {
  const vitals = Object.fromEntries(VITAL_FIELDS.map((f) => [f.key, toNumber(form.vitals[f.key])]));
  const labs = Object.fromEntries(LAB_FIELDS.map((f) => [f.key, toNumber(form.labs[f.key])]));
  const hasLabs = Object.values(labs).some((v) => v !== null);
  return {
    complaints: form.complaints,
    observations: form.observations,
    assessment: form.assessment,
    ...vitals,
    ...labs,
    labs_source: hasLabs ? form.labs_source || 'manual' : null,
    bmi: calcBmi(vitals.height_cm, vitals.weight_kg),
    preliminary_diagnosis: form.preliminary_diagnosis.trim() || null,
    final_diagnosis: form.final_diagnosis.trim() || null,
    doctor_notes: form.doctor_notes.trim() || null,
    follow_up_date: form.follow_up_date || null,
  };
}

/**
 * Red-flag checks that must not wait for longitudinal analysis
 * (MEDIS spec 12.5). These are prompts for the doctor, not diagnoses.
 */
function clinicalAlerts(form) {
  const alerts = [];
  const c = form.complaints;
  const v = form.vitals;

  if (
    c.chest_pain === 'yes' &&
    (Number(c.pain_severity) >= 7 || c.pain_at_rest === 'yes' || c.sweating || c.breathlessness)
  ) {
    alerts.push(
      'Chest pain at rest, of high severity, or with sweating or breathlessness: possible acute coronary syndrome. ' +
        'Consider urgent assessment (ECG, cardiac biomarkers) rather than routine follow-up.'
    );
  }
  if (c.syncope === 'yes') {
    alerts.push('Syncope recorded: assess for arrhythmia or structural heart disease before routine follow-up.');
  }
  if (c.breathlessness && c.nyha_class === 'IV') {
    alerts.push('Breathlessness at rest (NYHA class IV).');
  }
  if (Number(v.systolic_bp) >= 180 || Number(v.diastolic_bp) >= 120) {
    alerts.push('Blood pressure at or above 180/120 mmHg: hypertensive crisis range.');
  }
  if (v.spo2 !== '' && v.spo2 !== null && Number(v.spo2) < 90) {
    alerts.push('Oxygen saturation below 90%.');
  }
  return alerts;
}

/**
 * Handles two routes:
 *  - /doctor/patients/:patientId/consult — starts a visit (or resumes this
 *    doctor's open draft for the patient), then redirects to the route below
 *    so a page refresh never creates a second visit.
 *  - /doctor/consultations/:consultationId — edits a draft, or shows a
 *    finalized visit read-only.
 */
export default function NewConsultation() {
  const { patientId: newPatientId, consultationId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const formRef = useRef(null);
  const startedRef = useRef(false);
  const prefilledRef = useRef(false);

  const [consultation, setConsultation] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [prescriptions, setPrescriptions] = useState([]);
  const [visitDocuments, setVisitDocuments] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [prescriptionEditing, setPrescriptionEditing] = useState(false);

  const { profile: patient, details, medications, history, hospitals } = usePatientRecord(
    consultation?.patient_id
  );

  // ---- Start (or resume) a visit -------------------------------------
  useEffect(() => {
    if (consultationId || !newPatientId || !user?.id || startedRef.current) return;
    startedRef.current = true;

    // Passed from the patient page: the appointment this visit is for,
    // and which section to scroll to ("prescription").
    const appointmentId = location.state?.appointmentId ?? null;
    const focus = location.state?.focus ?? null;

    // The patient has been seen, so the appointment is done
    function completeAppointment() {
      if (!appointmentId) return;
      supabase
        .from('appointments')
        .update({ status: 'completed' })
        .eq('id', appointmentId)
        .eq('status', 'scheduled')
        .then(() => {});
    }

    async function startConsultation() {
      const { data: draft } = await supabase
        .from('consultations')
        .select('id')
        .eq('doctor_id', user.id)
        .eq('patient_id', newPatientId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (draft) {
        completeAppointment();
        navigate(`/doctor/consultations/${draft.id}`, {
          replace: true,
          state: { resumed: true, focus },
        });
        return;
      }

      const { data: doctorProfile } = await supabase
        .from('doctor_profiles')
        .select('hospital_id')
        .eq('id', user.id)
        .maybeSingle();

      // visit_id is assigned by the trg_assign_visit_id trigger, and
      // trg_ensure_assignment grants this doctor access to the patient.
      const { data, error } = await supabase
        .from('consultations')
        .insert({
          patient_id: newPatientId,
          doctor_id: user.id,
          disease_type: 'cad',
          status: 'pending',
          hospital_id: doctorProfile?.hospital_id ?? null,
        })
        .select('id, visit_id')
        .single();

      if (error) {
        setLoadError(error.message);
        return;
      }

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action: 'started_consultation',
        target_id: data.id,
        target_type: 'consultation',
        metadata: { visit_id: data.visit_id, appointment_id: appointmentId },
      });

      completeAppointment();
      navigate(`/doctor/consultations/${data.id}`, { replace: true, state: { focus } });
    }

    startConsultation();
  }, [consultationId, newPatientId, user?.id, navigate, location.state]);

  // ---- Load an existing visit ----------------------------------------
  const loadPrescriptions = useCallback(async () => {
    if (!consultationId) return;
    const { data } = await supabase
      .from('prescriptions')
      .select('*')
      .eq('consultation_id', consultationId)
      .order('issued_at', { ascending: false });
    setPrescriptions(data ?? []);
  }, [consultationId]);

  const loadVisitDocuments = useCallback(async () => {
    if (!consultationId) return;
    const { data } = await supabase
      .from('medical_reports')
      .select('*, hospitals(name)')
      .eq('consultation_id', consultationId)
      .order('uploaded_at', { ascending: false });
    setVisitDocuments(data ?? []);
  }, [consultationId]);

  useEffect(() => {
    if (!consultationId) return;
    let cancelled = false;

    async function loadConsultation() {
      const { data, error } = await supabase
        .from('consultations')
        .select(CONSULTATION_SELECT)
        .eq('id', consultationId)
        .maybeSingle();

      if (cancelled) return;
      if (error || !data) {
        setLoadError(error?.message ?? 'Consultation not found, or it belongs to another doctor.');
        return;
      }
      setConsultation(data);
      setForm(formFromRow(data));
    }

    loadConsultation();
    loadPrescriptions();
    loadVisitDocuments();
    return () => {
      cancelled = true;
    };
  }, [consultationId, loadPrescriptions, loadVisitDocuments]);

  // "Write prescription" from the patient page lands here scrolled to it
  useEffect(() => {
    if (!consultation || location.state?.focus !== 'prescription') return;
    document.getElementById('prescription')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [consultation, location.state]);

  // Prefill height/weight from the patient's profile on a fresh draft
  useEffect(() => {
    if (!consultation || !details || prefilledRef.current || consultation.status !== 'pending') return;
    prefilledRef.current = true;
    setForm((prev) => ({
      ...prev,
      vitals: {
        ...prev.vitals,
        height_cm: prev.vitals.height_cm === '' ? details.height_cm ?? '' : prev.vitals.height_cm,
        weight_kg: prev.vitals.weight_kg === '' ? details.weight_kg ?? '' : prev.vitals.weight_kg,
      },
    }));
  }, [consultation, details]);

  // ---- Form updates --------------------------------------------------
  function updateSection(section, key, value) {
    setForm((prev) => ({ ...prev, [section]: { ...prev[section], [key]: value } }));
    setDirty(true);
  }

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  // Lab values the doctor verified from an uploaded report (AI extraction)
  function applyExtractedLabs(values) {
    setForm((prev) => {
      const labs = { ...prev.labs };
      const vitals = { ...prev.vitals };
      for (const [key, value] of Object.entries(values)) {
        if (key in labs) labs[key] = value;
        else if (key in vitals) vitals[key] = value;
      }
      return { ...prev, labs, vitals, labs_source: 'extracted_verified' };
    });
    setDirty(true);
  }

  // ---- Save / finalize / share ---------------------------------------
  // Finalizing asks for confirmation first (dialog), then calls save(true, true)
  async function save(finalize = false, confirmed = false) {
    setSaveError('');
    if (finalize && prescriptionEditing) {
      setSaveError('Save or cancel prescription changes before finalizing.');
      return;
    }
    if (!formRef.current?.reportValidity()) return;

    if (finalize) {
      if (!form.final_diagnosis.trim()) {
        setSaveError('Enter a final diagnosis before finalizing.');
        return;
      }
      if (!confirmed) {
        setConfirmFinalize(true);
        return;
      }
      setConfirmFinalize(false);
    }

    const payload = rowFromForm(form);
    if (finalize) {
      payload.status = 'completed';
      payload.finalized_at = new Date().toISOString();
    }

    setSaving(true);
    const { data, error } = await supabase
      .from('consultations')
      .update(payload)
      .eq('id', consultation.id)
      .select(CONSULTATION_SELECT)
      .single();
    setSaving(false);

    if (error) {
      setSaveError(error.message);
      return;
    }

    setConsultation(data);
    setDirty(false);
    setSavedAt(new Date());
    toast.success(finalize ? 'Consultation finalized' : 'Draft saved');

    supabase.from('audit_logs').insert({
      user_id: user.id,
      action: finalize ? 'finalized_consultation' : 'saved_consultation',
      target_id: consultation.id,
      target_type: 'consultation',
    });
  }

  async function toggleShare() {
    setSaveError('');
    const next = !consultation.is_shared_with_patient;

    // Flipping to true fires notify_consultation_shared → patient notification
    const { data, error } = await supabase
      .from('consultations')
      .update({ is_shared_with_patient: next })
      .eq('id', consultation.id)
      .select(CONSULTATION_SELECT)
      .single();

    if (error) {
      setSaveError(error.message);
      return;
    }
    setConsultation(data);

    supabase.from('audit_logs').insert({
      user_id: user.id,
      action: next ? 'shared_result' : 'unshared_result',
      target_id: consultation.id,
      target_type: 'consultation',
    });
  }

  function bookFollowUp() {
    const params = new URLSearchParams({
      patient: consultation.patient_id,
      consultation: consultation.id,
    });
    if (form.follow_up_date) params.set('date', form.follow_up_date);
    navigate(`/doctor/appointments?${params.toString()}`);
  }

  // ---- Render --------------------------------------------------------
  if (loadError) {
    return (
      <div className="space-y-3">
        <BackButton />
        <ErrorState text={`Couldn't open consultation: ${loadError}`} />
      </div>
    );
  }

  if (!consultation) return <Spinner text={consultationId ? 'Loading consultation...' : 'Starting consultation...'} />;

  // Another doctor's finalized visit (readable via the v3f policy) is view-only
  const isOwner = consultation.doctor_id === user.id;
  const readOnly = !isOwner || consultation.status !== 'pending';
  const c = form.complaints;
  const bmi = calcBmi(form.vitals.height_cm, form.vitals.weight_kg);
  const alerts = clinicalAlerts(form);
  const age = calcAge(patient?.date_of_birth);
  const activeConditions = history.filter((h) => h.is_active).map((h) => h.condition_name);

  const select = (label, value, onChange, options, id) => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <SimpleSelect id={id} value={value} onChange={onChange} disabled={readOnly} placeholder="Not assessed" options={options} />
    </div>
  );
  const unitInput = (section, f) => (
    <div key={f.key} className="space-y-1">
      <Label htmlFor={`${section}-${f.key}`} className="text-xs">
        {f.label}
      </Label>
      <div className="relative">
        <Input
          id={`${section}-${f.key}`}
          type="number"
          min={f.min}
          max={f.max}
          step={f.step}
          value={form[section][f.key]}
          onChange={(e) => updateSection(section, f.key, e.target.value)}
          className="pr-16"
        />
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] text-muted-foreground">{f.unit}</span>
      </div>
    </div>
  );
  const textArea = (id, label, value, onChange, rows = 2, className) => (
    <div className={cn('space-y-1', className)}>
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Textarea id={id} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );

  return (
    <div className={cn('space-y-5', isOwner && !readOnly && 'pb-24')}>
      <BackButton />
      <div className="rounded-xl border bg-card p-4 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold">Consultation</h1>
              <IDChip id={consultation.visit_id} />
              <StatusPill value={pillValue(consultation.status, 'visit')} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {formatDateTime(consultation.consultation_date)}
              {consultation.hospitals?.name && ` · ${consultation.hospitals.name}`} · {patient?.full_name ?? 'Loading patient...'}{' '}
              <span className="font-mono text-xs">{patient?.display_id}</span>
              {age !== null && ` · ${age} y`}
              {patient?.gender && ` · ${humanize(patient.gender)}`}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to={`/doctor/patients/${consultation.patient_id}`}>Patient record</Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/doctor/drafts">See all drafts</Link>
            </Button>
          </div>
        </div>
        {location.state?.resumed && !readOnly && (
          <p className="mt-2 text-sm text-info">You already had an unfinished draft for this patient, so it has been reopened. Finalize it before starting another visit.</p>
        )}
        {!isOwner && (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Lock className="h-4 w-4" />
            Read-only: this visit belongs to Dr. {consultation.doctor?.full_name ?? '—'}
            {consultation.doctor?.display_id && ` (${consultation.doctor.display_id})`}
          </p>
        )}
        {isOwner && readOnly && (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Lock className="h-4 w-4" />
            Final, cannot be edited (finalized {formatDateTime(consultation.finalized_at)}). You can still issue prescriptions, attach reports, share the
            result and book a follow-up.
          </p>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
        <div className="min-w-0 space-y-5">
          <form
            ref={formRef}
            onSubmit={(e) => {
              e.preventDefault();
              save(false);
            }}
          >
            <fieldset disabled={readOnly} className="min-w-0 space-y-5">
              <Section title="1. Patient complaints">
                {textArea('c-main', 'Main complaint', c.main_complaint, (v) => updateSection('complaints', 'main_complaint', v))}
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {COMPLAINT_FLAGS.map((f) => (
                    <label key={f.key} className="flex items-center gap-2 text-sm">
                      <Checkbox disabled={readOnly} checked={!!c[f.key]} onCheckedChange={(on) => updateSection('complaints', f.key, !!on)} />
                      {f.label}
                    </label>
                  ))}
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  {select('Chest pain', c.chest_pain, (v) => updateSection('complaints', 'chest_pain', v), [
                    ['yes', 'Yes'],
                    ['no', 'No'],
                  ])}
                  {select('Fainting (syncope)', c.syncope, (v) => updateSection('complaints', 'syncope', v), [
                    ['yes', 'Yes'],
                    ['no', 'No'],
                  ])}
                  {c.breathlessness &&
                    select('Breathlessness class (NYHA)', c.nyha_class, (v) => updateSection('complaints', 'nyha_class', v), Object.entries(NYHA_CLASSES))}
                </div>
                {c.chest_pain === 'yes' && (
                  <div className="mt-3 grid gap-3 rounded-lg border bg-muted/30 p-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label htmlFor="c-duration" className="text-xs">
                        Duration
                      </Label>
                      <Input
                        id="c-duration"
                        placeholder="e.g. 2 weeks"
                        value={c.chest_pain_duration}
                        onChange={(e) => updateSection('complaints', 'chest_pain_duration', e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="c-location" className="text-xs">
                        Location
                      </Label>
                      <Input
                        id="c-location"
                        placeholder="e.g. Retrosternal"
                        value={c.pain_location}
                        onChange={(e) => updateSection('complaints', 'pain_location', e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="c-severity" className="text-xs">
                        Severity (0–10)
                      </Label>
                      <Input
                        id="c-severity"
                        type="number"
                        min="0"
                        max="10"
                        step="1"
                        value={c.pain_severity}
                        onChange={(e) => updateSection('complaints', 'pain_severity', e.target.value)}
                      />
                    </div>
                    {select('Pain type', c.chest_pain_type, (v) => updateSection('complaints', 'chest_pain_type', v), Object.entries(CHEST_PAIN_TYPES))}
                    {select('Radiates to', c.pain_radiation, (v) => updateSection('complaints', 'pain_radiation', v), Object.entries(PAIN_RADIATION))}
                    {select('Occurs at rest', c.pain_at_rest, (v) => updateSection('complaints', 'pain_at_rest', v), [
                      ['yes', 'Yes'],
                      ['no', 'No (on exertion only)'],
                    ])}
                  </div>
                )}
                <div className="mt-3">
                  {textArea('c-other', 'Other symptoms (duration and details)', c.other_symptoms, (v) => updateSection('complaints', 'other_symptoms', v))}
                </div>
              </Section>

              <Section title="2. Clinical examination (vitals)">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {VITAL_FIELDS.map((f) => unitInput('vitals', f))}
                  <div className="space-y-1">
                    <span className="text-xs font-medium">BMI (calculated)</span>
                    <p className="flex h-9 items-center rounded-md bg-muted px-3 text-sm font-semibold">
                      {bmi ?? '—'} <span className="ml-1 text-[11px] font-normal text-muted-foreground">kg/m²</span>
                    </p>
                  </div>
                </div>
                {alerts.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2" aria-live="polite">
                    {alerts.map((a) => (
                      <span
                        key={a}
                        className="inline-flex items-start gap-1 rounded-full border border-destructive/30 bg-destructive-soft px-2.5 py-1 text-xs font-medium text-destructive"
                      >
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        {a}
                      </span>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="2b. Lab values">
                <p className="mb-3 text-xs text-muted-foreground">
                  Used for trend graphs across visits. Use <b className="text-ai">Extract values (AI)</b> on a lab report under "Test reports for this
                  visit" to fill these from the document.
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{LAB_FIELDS.map((f) => unitInput('labs', f))}</div>
                {form.labs_source === 'extracted_verified' && <p className="mt-2 text-[11px] text-ai">Includes values read from a report and verified by you.</p>}
              </Section>

              <Section title="3. Clinical observations">
                <div className="grid gap-3 sm:grid-cols-2">
                  {OBSERVATION_FIELDS.map((f) =>
                    textArea(`o-${f.key}`, f.label, form.observations[f.key], (v) => updateSection('observations', f.key, v))
                  )}
                  {textArea('o-additional', 'Additional notes', form.observations.additional, (v) => updateSection('observations', 'additional', v), 2)}
                </div>
              </Section>

              <Section title="4. Diagnosis and assessment">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="dx-preliminary" className="text-xs">
                      Preliminary diagnosis
                    </Label>
                    <Input id="dx-preliminary" value={form.preliminary_diagnosis} onChange={(e) => updateField('preliminary_diagnosis', e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="dx-final" className="text-xs">
                      Final diagnosis (required to finalize)
                    </Label>
                    <Input id="dx-final" value={form.final_diagnosis} onChange={(e) => updateField('final_diagnosis', e.target.value)} />
                  </div>
                  {ASSESSMENT_FIELDS.map((f) =>
                    textArea(`dx-${f.key}`, f.label, form.assessment[f.key], (v) => updateSection('assessment', f.key, v), 2, 'sm:col-span-2')
                  )}
                  {textArea('dx-notes', "Doctor's notes (summary for the patient, visible once you share this visit)", form.doctor_notes, (v) => updateField('doctor_notes', v), 2, 'sm:col-span-2')}
                  <div className="space-y-1">
                    <Label htmlFor="dx-fu" className="text-xs">
                      Follow-up date
                    </Label>
                    <Input id="dx-fu" type="date" value={form.follow_up_date} onChange={(e) => updateField('follow_up_date', e.target.value)} />
                  </div>
                </div>
              </Section>
            </fieldset>
          </form>

          <AiInsights
            compact
            patientId={consultation.patient_id}
            patientAge={age}
            consultationId={consultation.id}
            getDraftValues={readOnly ? undefined : () => rowFromForm(form)}
          />

          <Section title="Test reports for this visit">
            <DocumentUpload
              patientId={consultation.patient_id}
              doctorId={user.id}
              consultationId={consultation.id}
              hospitals={hospitals}
              defaultHospitalId={consultation.hospital_id ?? ''}
              documents={visitDocuments}
              showForm={isOwner}
              onUploaded={loadVisitDocuments}
              renderExtra={(d) => <DocumentAiActions doc={d} consultationId={consultation.id} onApplyLabs={readOnly ? undefined : applyExtractedLabs} />}
            />
          </Section>

          <Section id="prescription" title="Prescription">
            <PrescriptionForm
              consultationId={consultation.id}
              patientId={consultation.patient_id}
              doctorId={user.id}
              prescriptions={prescriptions}
              canIssue={isOwner}
              canEdit={!readOnly && !consultation.finalized_at}
              disabled={saving}
              onEditingChange={setPrescriptionEditing}
              startOpen={location.state?.focus === 'prescription'}
              onSaved={loadPrescriptions}
            />
          </Section>

          {isOwner && readOnly && (
            <Section title="Share & follow-up">
              <label className="flex items-center gap-3 text-sm font-medium">
                <Switch checked={!!consultation.is_shared_with_patient} onCheckedChange={toggleShare} />
                {consultation.is_shared_with_patient ? 'Shared with patient — switch off to stop sharing' : 'Share with patient'}
              </label>
              <p className="mt-1 text-xs text-muted-foreground">Sharing shows the diagnosis and summary in the patient's portal and notifies them.</p>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                Suggested follow-up date: <b>{consultation.follow_up_date ? formatDate(consultation.follow_up_date) : '—'}</b>
                <Button size="sm" variant="outline" onClick={bookFollowUp}>
                  Book follow-up
                </Button>
              </div>
              {saveError && <p className="mt-2 text-sm text-destructive">{saveError}</p>}
            </Section>
          )}
        </div>

        <aside className="space-y-3 lg:sticky lg:top-20 lg:self-start">
          <Section title="Patient context">
            <dl className="grid grid-cols-2 gap-3">
              <Field label="Age" value={age} />
              <Field label="BMI" value={calcBmi(details?.height_cm, details?.weight_kg)} />
              <Field label="Smoking" value={humanize(details?.smoking_status)} />
              <Field label="Alcohol" value={humanize(details?.alcohol_use)} />
            </dl>
            <dl className="mt-3 space-y-2 text-sm">
              <Field label="Allergies" value={details?.allergies || 'None recorded'} />
              <Field label="Known conditions" value={activeConditions.join(', ') || 'None recorded'} />
              <Field label="Current medications" value={medications.map((m) => [m.medicine_name, m.dosage].filter(Boolean).join(' ')).join(', ') || 'None recorded'} />
            </dl>
          </Section>
        </aside>
      </div>

      {isOwner && !readOnly && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur lg:left-[240px]">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
            <span className={cn('text-sm', saveError ? 'text-destructive' : 'text-muted-foreground')}>
              {saveError || (dirty ? 'Unsaved changes' : savedAt ? `Draft saved at ${savedAt.toLocaleTimeString()}` : 'Draft')}
            </span>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" onClick={() => save(false)} disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Save draft
              </Button>
              <Button onClick={() => save(true)} disabled={saving || prescriptionEditing}>
                Finalize consultation
              </Button>
            </div>
            {prescriptionEditing && <p className="w-full text-xs text-muted-foreground">Save or cancel prescription changes before finalizing.</p>}
          </div>
        </div>
      )}

      <AlertDialog open={confirmFinalize} onOpenChange={setConfirmFinalize}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Finalize consultation?</AlertDialogTitle>
            <AlertDialogDescription>
              Finalizing locks this visit. It becomes part of the permanent record and can no longer be edited. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction disabled={saving || prescriptionEditing} onClick={() => save(true, true)}>Finalize</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
