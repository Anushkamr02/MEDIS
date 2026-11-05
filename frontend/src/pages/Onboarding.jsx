import { useEffect, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { Button, Input, Label, SimpleSelect } from '../components/ui';
import { BackButton, Section, Spinner } from '../components/medis';

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const MED_FIELDS = [
  ['medicine_name', 'Name'],
  ['dosage', 'Dosage'],
  ['frequency', 'Frequency'],
  ['condition_name', 'For (e.g. BP)'],
];

function emptyMedication() {
  return { medicine_name: '', condition_name: '', dosage: '', frequency: '' };
}

/**
 * First-time profile setup, and later "Edit profile". When a
 * patient_profiles row already exists the form is prefilled, so saving
 * never blanks out existing data. known_conditions is intentionally NOT
 * collected here yet — it stays as-is until the CAD model's exact input
 * fields are confirmed by the ML team.
 */
export default function Onboarding() {
  const { user, profile, refreshProfile } = useAuth();
  const navigate = useNavigate();
  const { refresh } = useOutletContext();

  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [dateOfBirth, setDateOfBirth] = useState(profile?.date_of_birth ?? '');
  const [gender, setGender] = useState(profile?.gender ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');

  const [bloodGroup, setBloodGroup] = useState('');
  const [heightCm, setHeightCm] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [smokingStatus, setSmokingStatus] = useState('never');
  const [alcoholUse, setAlcoholUse] = useState('never');
  const [allergies, setAllergies] = useState('');
  const [emergencyContact, setEmergencyContact] = useState('');

  // Medications already on record (shown, not re-inserted) + new rows to add
  const [existingMeds, setExistingMeds] = useState([]);
  const [medications, setMedications] = useState([]);

  const [isEditing, setIsEditing] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user?.id) return;

    async function loadExisting() {
      const [detailsRes, medsRes] = await Promise.all([
        supabase.from('patient_profiles').select('*').eq('id', user.id).maybeSingle(),
        supabase
          .from('current_medications')
          .select('id, medicine_name, dosage, frequency, condition_name')
          .eq('patient_id', user.id)
          .eq('is_active', true)
          .order('created_at', { ascending: false }),
      ]);

      const d = detailsRes.data;
      if (d) {
        setIsEditing(true);
        setBloodGroup(d.blood_group ?? '');
        setHeightCm(d.height_cm ?? '');
        setWeightKg(d.weight_kg ?? '');
        setSmokingStatus(d.smoking_status ?? 'never');
        setAlcoholUse(d.alcohol_use ?? 'never');
        setAllergies(d.allergies ?? '');
        setEmergencyContact(d.emergency_contact ?? '');
      }
      setExistingMeds(medsRes.data ?? []);
      setLoadingExisting(false);
    }

    loadExisting();
  }, [user?.id]);

  // profile can arrive after first render (page refresh)
  useEffect(() => {
    if (!profile) return;
    setFullName((prev) => prev || profile.full_name || '');
    setDateOfBirth((prev) => prev || profile.date_of_birth || '');
    setGender((prev) => prev || profile.gender || '');
    setPhone((prev) => prev || profile.phone || '');
  }, [profile]);

  function updateMedication(index, field, value) {
    setMedications((prev) =>
      prev.map((m, i) => (i === index ? { ...m, [field]: value } : m))
    );
  }

  function addMedicationRow() {
    setMedications((prev) => [...prev, emptyMedication()]);
  }

  function removeMedicationRow(index) {
    setMedications((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!fullName.trim() || !dateOfBirth || !gender) {
      setError('Name, date of birth and gender are required.');
      return;
    }
    if (medications.some((m) => Object.values(m).some((value) => value.trim()) && !m.medicine_name.trim())) {
      setError('Each new medication needs a name.');
      return;
    }
    setSubmitting(true);

    const { error: personalError } = await supabase
      .from('profiles')
      .update({
        full_name: fullName.trim(),
        date_of_birth: dateOfBirth || null,
        gender: gender || null,
        phone: phone.trim() || null,
      })
      .eq('id', user.id);

    if (personalError) {
      setError(personalError.message);
      setSubmitting(false);
      return;
    }

    // Upsert because a patient may be editing an existing row later,
    // not just creating one for the first time.
    const { error: profileError } = await supabase.from('patient_profiles').upsert({
      id: user.id,
      blood_group: bloodGroup || null,
      height_cm: heightCm ? Number(heightCm) : null,
      weight_kg: weightKg ? Number(weightKg) : null,
      smoking_status: smokingStatus,
      alcohol_use: alcoholUse,
      allergies: allergies || null,
      emergency_contact: emergencyContact || null,
    });

    if (profileError) {
      setError(profileError.message);
      setSubmitting(false);
      return;
    }

    // Only insert new medication rows that actually have a name filled in
    const rowsToInsert = medications
      .filter((m) => m.medicine_name.trim() !== '')
      .map((m) => ({ ...m, patient_id: user.id }));

    if (rowsToInsert.length > 0) {
      const { error: medsError } = await supabase
        .from('current_medications')
        .insert(rowsToInsert);

      if (medsError) {
        setError(medsError.message);
        setSubmitting(false);
        return;
      }
    }

    await refreshProfile();
    await refresh();
    setSubmitting(false);
    toast.success('Profile saved');
    navigate(isEditing ? '/patient/profile' : '/patient');
  }


  if (loadingExisting) return <Spinner text="Loading your profile..." />;

  const text = (id, label, value, onChange, props = {}) => (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} {...props} />
    </div>
  );
  const select = (label, value, onChange, options) => (
    <div className="space-y-1">
      <Label>{label}</Label>
      <SimpleSelect value={value} onChange={onChange} options={options} />
    </div>
  );

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-3xl space-y-5" noValidate>
      <BackButton to={isEditing ? '/patient/profile' : '/patient'} />
      <div>
        <h1 className="text-2xl font-bold">{isEditing ? 'Edit your profile' : 'Tell us about yourself'}</h1>
        <p className="text-sm text-muted-foreground">
          This helps your doctor make better decisions. You can update this anytime from your profile.
        </p>
      </div>
      <Section title="Personal">
        <div className="grid gap-3 sm:grid-cols-2">
          {text('f-name', 'Full name', fullName, setFullName)}
          {text('f-dob', 'Date of birth', dateOfBirth, setDateOfBirth, { type: 'date', max: new Date().toISOString().slice(0, 10) })}
          {select('Gender', gender, setGender, [
            ['female', 'Female'],
            ['male', 'Male'],
            ['other', 'Other'],
          ])}
          {text('f-phone', 'Phone', phone, setPhone, { type: 'tel', placeholder: '+91 98765 43210' })}
        </div>
      </Section>
      <Section title="Health">
        <div className="grid gap-3 sm:grid-cols-2">
          {select('Blood group', bloodGroup, setBloodGroup, BLOOD_GROUPS)}
          {text('f-height', 'Height (cm)', heightCm, setHeightCm, { type: 'number' })}
          {text('f-weight', 'Weight (kg)', weightKg, setWeightKg, { type: 'number' })}
          {select('Smoking', smokingStatus, setSmokingStatus, [
            ['never', 'Never'],
            ['former', 'Former'],
            ['current', 'Current'],
          ])}
          {select('Alcohol', alcoholUse, setAlcoholUse, [
            ['never', 'Never'],
            ['occasional', 'Occasional'],
            ['regular', 'Regular'],
          ])}
          {text('f-allergies', 'Allergies', allergies, setAllergies, { placeholder: 'e.g. Penicillin' })}
          {text('f-emergency', 'Emergency contact', emergencyContact, setEmergencyContact, { placeholder: 'Name and phone number' })}
        </div>
      </Section>
      <Section
        title="Current medications (optional)"
        action={
          <Button type="button" size="sm" variant="outline" onClick={addMedicationRow}>
            <Plus className="h-4 w-4" />
            Add medication
          </Button>
        }
      >
        <p className="mb-3 text-sm text-muted-foreground">You can leave this section blank if you take no medication or want to add it later.</p>
        {existingMeds.length > 0 && (
          <ul className="mb-3 space-y-1 text-sm">
            {existingMeds.map((m) => (
              <li key={m.id} className="rounded-md bg-muted/60 px-3 py-1.5">
                <b className="font-medium">{m.medicine_name}</b> {[m.dosage, m.frequency].filter(Boolean).join(' · ')}
                {m.condition_name && ` · for ${m.condition_name}`} <span className="text-xs text-muted-foreground">(saved)</span>
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-2">
          {medications.map((m, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border p-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
              {MED_FIELDS.map(([field, placeholder]) => (
                <Input
                  key={field}
                  aria-label={placeholder}
                  placeholder={placeholder}
                  value={m[field]}
                  onChange={(e) => updateMedication(i, field, e.target.value)}
                />
              ))}
              <Button type="button" variant="ghost" size="icon" aria-label="Remove medication" onClick={() => removeMedicationRow(i)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {medications.length === 0 && existingMeds.length === 0 && <p className="text-sm text-muted-foreground">No medications added.</p>}
        </div>
      </Section>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving...' : isEditing ? 'Save changes' : 'Save and continue'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => navigate(isEditing ? '/patient/profile' : '/patient')}>
          Back
        </Button>
      </div>
    </form>
  );
}
