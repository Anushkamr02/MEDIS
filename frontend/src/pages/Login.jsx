import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';
import { Button, Input, Label } from '../components/ui';
import AuthLayout from '../components/AuthLayout';

export default function Login() {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const id = identifier.trim();
    if (!id || !password) {
      setError('Enter your email or MEDIS ID and password.');
      return;
    }
    setSubmitting(true);

    // A MEDIS ID is resolved to the account email; the lookup only succeeds with the right password.
    let email = id;
    if (!id.includes('@')) {
      const { data: resolved, error: resolveError } = await supabase.rpc('resolve_login_email', {
        p_medis_id: id,
        p_password: password,
      });
      if (resolveError || !resolved) {
        setSubmitting(false);
        setError(resolveError ? 'Could not sign in. Please try again.' : 'Invalid MEDIS ID or password.');
        return;
      }
      email = resolved;
    }

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
    <AuthLayout>
      <h2 className="mt-4 text-2xl font-bold tracking-normal">Welcome back</h2>
      <p className="mt-2 text-sm text-muted-foreground">Log in to MEDIS.</p>
      <form onSubmit={handleSubmit} className="mt-7 space-y-5" noValidate>
        <div className="space-y-2">
          <Label htmlFor="login-email">Email or MEDIS ID</Label>
          <Input
            id="login-email"
            type="text"
            placeholder="you@example.com or MEDIS-P-00001"
            autoComplete="username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
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
    </AuthLayout>
  );
}
