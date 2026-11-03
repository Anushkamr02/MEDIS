import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { CheckCircle2, Eye, EyeOff, Loader2, MailCheck } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';
import { cn } from '../lib/utils';
import { Button, Input, Label, SimpleSelect } from '../components/ui';
import { AuthAside, IDChip, Logo } from '../components/medis';

export default function Register() {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState('patient');
  const [hospitals, setHospitals] = useState([]);
  const [hospitalId, setHospitalId] = useState('');
  const [specialization, setSpecialization] = useState('');
  const [qualification, setQualification] = useState('');
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Set after a successful signup: { role, displayId, needsConfirmation }
  const [registered, setRegistered] = useState(null);
  const navigate = useNavigate();

  // Readable before login thanks to the anon policy in migration v3e
  useEffect(() => {
    supabase
      .from('hospitals')
      .select('id, name, city')
      .order('name')
      .then(({ data, error: hospitalsError }) => {
        if (hospitalsError) console.error('Failed to load hospitals:', hospitalsError.message);
        setHospitals(data ?? []);
      });
  }, []);

  function validate() {
    const found = {};
    if (!fullName.trim()) found.name = 'Full name is required.';
    if (!/^\S+@\S+\.\S+$/.test(email)) found.email = 'Enter a valid email.';
    if (password.length < 6) found.password = 'Use at least 6 characters.';
    if (role === 'doctor') {
      if (!hospitalId) found.hospital = 'Choose your hospital.';
      if (!specialization.trim()) found.specialization = 'Required.';
      if (!qualification.trim()) found.qualification = 'Required.';
    }
    setErrors(found);
    return Object.keys(found).length === 0;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!validate()) return;

    setSubmitting(true);

    // The `handle_new_user` trigger reads this metadata: it creates
    // public.profiles (which assigns the permanent MEDIS ID) and, for
    // doctors, public.doctor_profiles with the chosen hospital.
    const metadata = { full_name: fullName.trim(), role };
    if (role === 'doctor') {
      metadata.hospital_id = hospitalId;
      metadata.specialization = specialization;
      metadata.qualification = qualification;
    }

    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: metadata },
    });

    if (signUpError) {
      setError(signUpError.message);
      setSubmitting(false);
      return;
    }

    if (data.user && data.session) {
      const { error: profileError } = await supabase.from('profiles').upsert(
        {
          id: data.user.id,
          full_name: fullName.trim(),
          role,
        },
        { onConflict: 'id' }
      );

      if (profileError) {
        console.error('Failed to create profile:', profileError.message);
      }
    }

    // If email confirmation is enabled in Supabase Auth settings, there's
    // no session yet, so the profile (and its ID) can't be read until
    // the user confirms and logs in.
    if (!data.session) {
      setRegistered({ role, displayId: null, needsConfirmation: true });
      setSubmitting(false);
      return;
    }

    const { data: profileRow } = await supabase
      .from('profiles')
      .select('display_id')
      .eq('id', data.user.id)
      .maybeSingle();

    setSubmitting(false);
    setRegistered({ role, displayId: profileRow?.display_id ?? null, needsConfirmation: false });
  }

  const fieldError = (key) => errors[key] && <p className="text-xs text-destructive">{errors[key]}</p>;
  const isDoctor = registered?.role === 'doctor';

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <AuthAside />
      <main className="flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-md space-y-5">
          <Logo className="lg:hidden" />
          <div className="rounded-2xl border bg-card p-6 shadow-card">
            {registered ? (
              registered.needsConfirmation ? (
                <div className="space-y-4 text-center">
                  <MailCheck className="mx-auto h-12 w-12 text-primary" />
                  <h2 className="text-2xl font-bold">Check your email</h2>
                  <p className="text-sm text-muted-foreground">
                    Account created. Please confirm your email before logging in. Your permanent{' '}
                    {isDoctor ? 'Doctor' : 'Patient'} ID will be shown on your dashboard after you log in.
                  </p>
                  <Button className="w-full" asChild>
                    <Link to="/login">Go to login</Link>
                  </Button>
                </div>
              ) : (
                <div className="space-y-4 text-center">
                  <CheckCircle2 className="mx-auto h-12 w-12 text-success" />
                  <h2 className="text-2xl font-bold">Account created</h2>
                  {registered.displayId ? (
                    <>
                      <p className="text-sm text-muted-foreground">Your permanent {isDoctor ? 'Doctor' : 'Patient'} ID is</p>
                      <IDChip id={registered.displayId} className="text-base" />
                      <p className="text-xs text-muted-foreground">
                        {isDoctor
                          ? 'Patients will see this ID whenever you open their record.'
                          : 'Share this ID with your doctor so they can open your record. It never changes.'}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">Your account is ready. Your ID will be shown on your dashboard.</p>
                  )}
                  <Button className="w-full" onClick={() => navigate(isDoctor ? '/doctor' : '/patient/onboarding')}>
                    Continue to {isDoctor ? 'dashboard' : 'profile setup'}
                  </Button>
                </div>
              )
            ) : (
              <>
                <h2 className="text-2xl font-bold">Create your account</h2>
                <div role="radiogroup" aria-label="Account type" className="mt-4 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                  {['patient', 'doctor'].map((r) => (
                    <button
                      key={r}
                      type="button"
                      role="radio"
                      aria-checked={role === r}
                      onClick={() => setRole(r)}
                      className={cn('rounded-md py-2 text-sm font-medium transition-colors', role === r ? 'bg-card shadow-card' : 'text-muted-foreground hover:text-foreground')}
                    >
                      I'm a {r}
                    </button>
                  ))}
                </div>
                <form onSubmit={handleSubmit} className="mt-4 space-y-3" noValidate>
                  <div className="space-y-1">
                    <Label htmlFor="reg-name">Full name</Label>
                    <Input id="reg-name" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
                    {fieldError('name')}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="reg-email">Email</Label>
                    <Input id="reg-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                    {fieldError('email')}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="reg-password">Password</Label>
                    <div className="relative">
                      <Input
                        id="reg-password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="pr-16"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((s) => !s)}
                        className="absolute inset-y-0 right-2 flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                      >
                        {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        {showPassword ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    {fieldError('password')}
                  </div>
                  {role === 'doctor' && (
                    <>
                      <div className="space-y-1">
                        <Label>Hospital</Label>
                        <SimpleSelect
                          value={hospitalId}
                          onChange={setHospitalId}
                          placeholder="Select hospital"
                          options={hospitals.map((h) => [h.id, `${h.name}${h.city ? `, ${h.city}` : ''}`])}
                        />
                        {hospitals.length === 0 && (
                          <p className="text-xs text-warning">No hospitals found. Make sure migration v3e has been applied.</p>
                        )}
                        {fieldError('hospital')}
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label htmlFor="reg-spec">Specialization</Label>
                          <Input id="reg-spec" placeholder="e.g. Cardiology" value={specialization} onChange={(e) => setSpecialization(e.target.value)} />
                          {fieldError('specialization')}
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="reg-qual">Qualification</Label>
                          <Input id="reg-qual" placeholder="e.g. MBBS, MD" value={qualification} onChange={(e) => setQualification(e.target.value)} />
                          {fieldError('qualification')}
                        </div>
                      </div>
                    </>
                  )}
                  {error && (
                    <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive">
                      {error}
                    </p>
                  )}
                  <Button type="submit" className="w-full" disabled={submitting}>
                    {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                    Create account
                  </Button>
                </form>
                <p className="mt-4 text-center text-sm">
                  Already registered?{' '}
                  <Link to="/login" className="font-medium text-primary hover:underline">
                    Log in
                  </Link>
                </p>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
