import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { calcAge, calcBmi, formatDate, humanize } from '../lib/format';
import { Button } from '../components/ui';
import { BackButton, ErrorState, Field, IDChip, Section, Spinner } from '../components/medis';

function formatConditionValue(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (value === null || value === undefined || value === '') return '—';
  return humanize(String(value));
}

/**
 * Patient's read-only view of their own profile. Editing happens on
 * the onboarding form (/patient/onboarding), which is prefilled.
 */
export default function MyProfile() {
  const { user, profile } = useAuth();
  const [details, setDetails] = useState(null);
  const [medications, setMedications] = useState([]);
  const [history, setHistory] = useState([]);
  const [familyHistory, setFamilyHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user?.id) return;

    async function load() {
      const [detailsRes, medsRes, historyRes, familyRes] = await Promise.all([
        supabase.from('patient_profiles').select('*').eq('id', user.id).maybeSingle(),
        supabase
          .from('current_medications')
          .select('*')
          .eq('patient_id', user.id)
          .eq('is_active', true)
          .order('created_at', { ascending: false }),
        supabase
          .from('patient_medical_history')
          .select('*')
          .eq('patient_id', user.id)
          .order('diagnosed_at', { ascending: false }),
        supabase
          .from('family_history')
          .select('*')
          .eq('patient_id', user.id)
          .order('created_at', { ascending: false }),
      ]);

      const firstError = detailsRes.error || medsRes.error || historyRes.error || familyRes.error;
      if (firstError) setError(firstError.message);

      setDetails(detailsRes.data ?? null);
      setMedications(medsRes.data ?? []);
      setHistory(historyRes.data ?? []);
      setFamilyHistory(familyRes.data ?? []);
      setLoading(false);
    }

    load();
  }, [user?.id]);

  if (loading) return <Spinner text="Loading your profile..." />;

  const age = calcAge(profile?.date_of_birth);
  const bmi = calcBmi(details?.height_cm, details?.weight_kg);
  const conditions = Object.entries(details?.known_conditions ?? {}).filter(([, v]) => v !== false && v !== null && v !== '');
  const initials = (profile?.full_name || '?')
    .split(' ')
    .map((x) => x[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="space-y-5">
      <BackButton to="/patient" />
      {error && <ErrorState text={`Some data failed to load: ${error}`} />}
      <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-hero p-5 text-navy-foreground shadow-card">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-sidebar-primary font-display text-xl font-bold text-sidebar-primary-foreground">
          {initials}
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{profile?.full_name || 'Patient'}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm opacity-90">
            <IDChip id={profile?.display_id} className="text-foreground" />
            <span>
              {age ?? '—'} y · {humanize(profile?.gender) || '—'} · Blood group {details?.blood_group || '—'}
            </span>
          </div>
          <p className="mt-1 text-xs opacity-80">Share this ID with any doctor at any MEDIS hospital so they can open your record. It never changes.</p>
        </div>
        <Button variant="secondary" asChild>
          <Link to="/patient/onboarding">
            <Pencil className="h-4 w-4" />
            Edit profile
          </Link>
        </Button>
      </div>

      {!details && (
        <div className="rounded-xl border border-dashed p-4 text-center">
          <p className="text-sm text-muted-foreground">Your profile is incomplete.</p>
          <Button asChild className="mt-2">
            <Link to="/patient/onboarding">Complete your profile</Link>
          </Button>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Personal details">
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Full name" value={profile?.full_name} />
            <Field label="Email" value={profile?.email ?? user?.email} />
            <Field label="Phone" value={profile?.phone} />
            <Field label="Gender" value={humanize(profile?.gender)} />
            <Field label="Date of birth" value={profile?.date_of_birth && formatDate(profile.date_of_birth)} />
            <Field label="Age" value={age} />
            <Field label="Emergency contact" value={details?.emergency_contact} />
          </dl>
        </Section>
        <Section title="Health details">
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Blood group" value={details?.blood_group} />
            <Field label="Height" value={details?.height_cm && `${details.height_cm} cm`} />
            <Field label="Weight" value={details?.weight_kg && `${details.weight_kg} kg`} />
            <Field label="BMI" value={bmi} />
            <Field label="Smoking" value={humanize(details?.smoking_status)} />
            <Field label="Alcohol" value={humanize(details?.alcohol_use)} />
            <Field label="Allergies" value={details?.allergies} />
          </dl>
        </Section>
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
            <ul className="space-y-1 text-sm">
              {medications.map((m) => (
                <li key={m.id}>
                  <b className="font-medium">{m.medicine_name}</b> {[m.dosage, m.frequency].filter(Boolean).join(' · ')}
                  {m.condition_name && ` · for ${m.condition_name}`}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">—</p>
          )}
        </Section>
        <Section title="Medical & family history" className="lg:col-span-2">
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
            {!history.length && !familyHistory.length && <li className="list-none text-muted-foreground">No history recorded yet. Your doctor can add this.</li>}
          </ul>
        </Section>
      </div>
    </div>
  );
}
