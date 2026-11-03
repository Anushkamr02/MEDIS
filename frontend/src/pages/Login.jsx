import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';
import { Button, Input, Label } from '../components/ui';
import { EcgLine, Logo } from '../components/medis';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!email || !password) {
      setError('Enter your email and password.');
      return;
    }
    setSubmitting(true);

    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setSubmitting(false);

    if (signInError) {
      setError(signInError.message);
      return;
    }

    // AuthContext loads or creates the profile after authentication.
    const { data: profileRow } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', data.user.id)
      .single();

    if (profileRow?.role === 'doctor') {
      navigate('/doctor');
    } else {
      navigate('/patient');
    }
  }

  return (
    <div className="grid min-h-svh bg-card md:grid-cols-2">
      <aside className="hidden min-w-0 flex-col justify-between gap-12 bg-primary-soft px-8 py-10 md:flex xl:px-14 xl:py-12">
        <Logo className="text-2xl tracking-normal" />
        <div className="max-w-lg py-6">
          <h1 className="font-display text-4xl font-bold leading-tight tracking-normal xl:text-5xl">
            One patient ID.
            <br />
            Every hospital.
          </h1>
          <p className="mt-4 text-2xl font-semibold leading-snug text-primary">
            Your heart-health history,
            <br className="hidden xl:block" /> all in one place.
          </p>
          <p className="mt-5 max-w-sm text-sm leading-relaxed text-muted-foreground">
            Your visits, prescriptions and reports stay connected across hospitals.
          </p>
          <EcgLine className="mt-8 h-14 text-primary" />
        </div>
        <p className="text-xs text-muted-foreground">Your health. Your record.</p>
      </aside>
      <main className="relative flex min-w-0 flex-col overflow-hidden px-6 py-8 sm:px-10 md:justify-center xl:px-16">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute inset-0 bg-gradient-to-br from-primary-soft/50 via-background to-secondary/80" />
          <div className="absolute -right-28 -top-28 h-72 w-72 rounded-full bg-primary/5 blur-3xl" />
          <div className="absolute -bottom-36 -left-28 h-80 w-80 rounded-full bg-ai-soft/40 blur-3xl" />
          <EcgLine className="absolute inset-x-0 bottom-10 h-12 text-primary/8" />
        </div>
        <Logo className="relative z-10 mb-14 text-2xl tracking-normal md:hidden" />
        <div className="relative z-10 my-auto w-full max-w-md self-center py-6 md:my-0">
          <div className="rounded-2xl border bg-card/85 p-7 shadow-card backdrop-blur-sm sm:p-9">
            <span className="inline-flex items-center gap-1.5 rounded-full border bg-primary-soft px-3 py-1 text-xs font-semibold text-primary">
              <ShieldCheck className="h-3.5 w-3.5" /> Secure sign-in
            </span>
            <h2 className="mt-4 text-2xl font-bold tracking-normal">Welcome back</h2>
            <p className="mt-2 text-sm text-muted-foreground">Log in to MEDIS.</p>
            <form onSubmit={handleSubmit} className="mt-7 space-y-5" noValidate>
              <div className="space-y-2">
                <Label htmlFor="login-email">Email</Label>
                <Input
                  id="login-email"
                  type="email"
                  placeholder="you@example.com"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-11 bg-background"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="login-password">Password</Label>
                <div className="relative">
                  <Input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Your password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="h-11 bg-background pr-12"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setShowPassword((s) => !s)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    title={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-1 top-1 h-9 w-9 text-muted-foreground"
                  >
                    {showPassword ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
              </div>
              {error && (
                <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" className="h-11 w-full" disabled={submitting}>
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Log in
              </Button>
            </form>
            <p className="mt-6 text-center text-sm text-muted-foreground">
              New to MEDIS?{' '}
              <Link to="/register" className="inline-block font-medium text-primary hover:underline">
                Create an account
              </Link>
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
