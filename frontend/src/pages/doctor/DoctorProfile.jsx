import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabaseClient';
import { humanize } from '../../lib/format';
import { Button, Input, Label, SimpleSelect } from '../../components/ui';
import { Field, IDChip, Section } from '../../components/medis';

function formFromProfiles(profile, doctorProfile) {
  return {
    full_name: profile?.full_name ?? '',
    phone: profile?.phone ?? '',
    gender: profile?.gender ?? '',
    specialization: doctorProfile?.specialization ?? '',
    qualification: doctorProfile?.qualification ?? '',
    license_number: doctorProfile?.license_number ?? '',
    years_of_experience: doctorProfile?.years_of_experience ?? '',
    hospital_id: doctorProfile?.hospital_id ?? '',
  };
}

/**
 * The doctor's own profile: identity, professional details, hospital,
 * and a few activity counts. "Edit" switches the same page into a form.
 * These details appear on visits and prescriptions, so they're worth
 * keeping accurate.
 */
export default function DoctorProfile() {
  const { user, profile, refreshProfile } = useAuth();
  const { doctorProfile, reloadDoctorProfile } = useOutletContext() ?? {};

  const [hospitals, setHospitals] = useState([]);
  const [stats, setStats] = useState({ patients: null, visits: null, prescriptions: null });
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => formFromProfiles(profile, doctorProfile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user?.id) return;

    async function load() {
      const [hospitalsRes, patientsRes, visitsRes, rxRes] = await Promise.all([
        supabase.from('hospitals').select('id, name, address, city').order('name'),
        supabase
          .from('doctor_patient_assignments')
          .select('id', { count: 'exact', head: true })
          .eq('doctor_id', user.id)
          .eq('is_active', true),
        supabase
          .from('consultations')
          .select('id', { count: 'exact', head: true })
          .eq('doctor_id', user.id)
          .neq('status', 'pending'),
        supabase
          .from('prescriptions')
          .select('id', { count: 'exact', head: true })
          .eq('doctor_id', user.id),
      ]);

      setHospitals(hospitalsRes.data ?? []);
      setStats({
        patients: patientsRes.count,
        visits: visitsRes.count,
        prescriptions: rxRes.count,
      });
    }

    load();
  }, [user?.id]);

  function startEditing() {
    setForm(formFromProfiles(profile, doctorProfile));
    setError('');
    setEditing(true);
  }

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave(e) {
    e.preventDefault();
    setError('');
    setSaving(true);

    const { error: profileError } = await supabase
      .from('profiles')
      .update({
        full_name: form.full_name.trim(),
        phone: form.phone.trim() || null,
        gender: form.gender || null,
      })
      .eq('id', user.id);

    if (profileError) {
      setError(profileError.message);
      setSaving(false);
      return;
    }

    // Keep the v1 free-text hospital_name in sync with the linked hospital
    const hospital = hospitals.find((h) => h.id === form.hospital_id);
    const { error: doctorError } = await supabase.from('doctor_profiles').upsert({
      id: user.id,
      specialization: form.specialization.trim() || null,
      qualification: form.qualification.trim() || null,
      license_number: form.license_number.trim() || null,
      years_of_experience: form.years_of_experience === '' ? null : Number(form.years_of_experience),
      hospital_id: form.hospital_id || null,
      hospital_name: hospital?.name ?? null,
    });

    setSaving(false);

    if (doctorError) {
      setError(doctorError.message);
      return;
    }

    await Promise.all([refreshProfile(), reloadDoctorProfile?.()]);
    setEditing(false);
    toast.success('Profile saved');
  }

  const hospital = hospitals.find((h) => h.id === doctorProfile?.hospital_id);
  const statCards = [
    ['Patients with access', stats.patients],
    ['Finalized consultations', stats.visits],
    ['Prescriptions issued', stats.prescriptions],
  ];
  const input = (key, label, props = {}) => (
    <div className="space-y-1">
      <Label htmlFor={`d-${key}`}>{label}</Label>
      <Input id={`d-${key}`} value={form[key]} onChange={(e) => updateField(key, e.target.value)} {...props} />
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-hero p-5 text-navy-foreground shadow-card">
        <div>
          <h1 className="text-2xl font-bold">Dr. {profile?.full_name || ''}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm opacity-90">
            <IDChip id={profile?.display_id} className="text-foreground" />
            {[doctorProfile?.specialization, hospital?.name ?? doctorProfile?.hospital_name].filter(Boolean).join(' · ')}
          </div>
        </div>
        {!editing && (
          <Button variant="secondary" onClick={startEditing}>
            <Pencil className="h-4 w-4" />
            Edit profile
          </Button>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {statCards.map(([label, value]) => (
          <div key={label} className="rounded-xl border bg-card p-4 shadow-card">
            <p className="font-display text-2xl font-bold">{value ?? '—'}</p>
            <p className="text-xs text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>
      {editing ? (
        <Section title="Edit profile">
          <form onSubmit={handleSave}>
            <div className="grid gap-3 sm:grid-cols-2">
              {input('full_name', 'Full name', { required: true })}
              {input('phone', 'Phone', { type: 'tel' })}
              <div className="space-y-1">
                <Label>Gender</Label>
                <SimpleSelect
                  value={form.gender}
                  onChange={(v) => updateField('gender', v)}
                  options={[
                    ['male', 'Male'],
                    ['female', 'Female'],
                    ['other', 'Other'],
                  ]}
                />
              </div>
              <div className="space-y-1">
                <Label>Hospital</Label>
                <SimpleSelect
                  value={form.hospital_id}
                  onChange={(v) => updateField('hospital_id', v)}
                  placeholder="Select hospital"
                  options={hospitals.map((h) => [h.id, `${h.name}${h.city ? `, ${h.city}` : ''}`])}
                />
              </div>
              {input('specialization', 'Specialization', { placeholder: 'e.g. Cardiology' })}
              {input('qualification', 'Qualification', { placeholder: 'e.g. MBBS, MD' })}
              {input('license_number', 'License number')}
              {input('years_of_experience', 'Years of experience', { type: 'number', min: 0, max: 70 })}
            </div>
            {error && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="mt-4 flex gap-2">
              <Button type="submit" disabled={saving || !form.hospital_id}>
                {saving ? 'Saving...' : 'Save'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </Button>
            </div>
          </form>
        </Section>
      ) : (
        <div className="grid gap-5 lg:grid-cols-3">
          <Section title="Personal details">
            <dl className="space-y-3">
              <Field label="Full name" value={profile?.full_name && `Dr. ${profile.full_name}`} />
              <Field label="Email" value={profile?.email ?? user?.email} />
              <Field label="Phone" value={profile?.phone} />
              <Field label="Gender" value={humanize(profile?.gender)} />
            </dl>
          </Section>
          <Section title="Professional details">
            <dl className="space-y-3">
              <Field label="Specialization" value={doctorProfile?.specialization} />
              <Field label="Qualification" value={doctorProfile?.qualification} />
              <Field label="License number" value={doctorProfile?.license_number} />
              <Field label="Experience" value={doctorProfile?.years_of_experience != null ? `${doctorProfile.years_of_experience} years` : null} />
            </dl>
          </Section>
          <Section title="Hospital">
            {hospital ? (
              <dl className="space-y-3">
                <Field label="Name" value={hospital.name} />
                <Field label="City" value={hospital.city} />
                <Field label="Address" value={hospital.address} />
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                {doctorProfile?.hospital_name
                  ? `${doctorProfile.hospital_name} (not linked to a hospital record; edit to select it)`
                  : 'No hospital set. Edit your profile to choose one.'}
              </p>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}
