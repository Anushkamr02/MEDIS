import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

const AuthContext = createContext(undefined);

/**
 * Wrap the app in <AuthProvider>. It tracks:
 *  - session: the raw Supabase auth session (null if logged out)
 *  - profile: the matching row from public.profiles (has .role)
 *  - loading: true until the initial session + profile fetch resolves
 *
 * Role-based routing reads `profile.role` ('patient' | 'doctor').
 */
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  async function fetchProfile(user) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if (!error && data) {
      setProfile(data);
      return;
    }

    if (error) {
      console.error('Failed to load profile:', error.message);
    }

    const metadata = user.user_metadata ?? {};
    const fallbackProfile = {
      id: user.id,
      full_name: metadata.full_name || user.email?.split('@')[0] || 'User',
      role: metadata.role === 'doctor' ? 'doctor' : 'patient',
    };

    const { data: createdProfile, error: createError } = await supabase
      .from('profiles')
      .upsert(fallbackProfile, { onConflict: 'id' })
      .select()
      .single();

    if (createError) {
      console.error('Failed to create profile:', createError.message);
      // Keep the authenticated user usable even if profile INSERT RLS is not configured.
      setProfile(fallbackProfile);
      return;
    }

    setProfile(createdProfile);
  }

  useEffect(() => {
    let isMounted = true;

    // 1. Get whatever session already exists (page refresh case)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!isMounted) return;
      setSession(session);
      if (session?.user) {
        fetchProfile(session.user).finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    // 2. Listen for login/logout/token-refresh events
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession);
        if (newSession?.user) {
          fetchProfile(newSession.user);
        } else {
          setProfile(null);
        }
      }
    );

    return () => {
      isMounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
  }

  // Re-read public.profiles after the user edits their own details
  async function refreshProfile() {
    if (session?.user) await fetchProfile(session.user);
  }

  const value = {
    session,
    user: session?.user ?? null,
    profile,
    role: profile?.role ?? null,
    loading,
    signOut,
    refreshProfile,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (ctx === undefined) {
    throw new Error('useAuth must be used inside an <AuthProvider>');
  }
  return ctx;
}
