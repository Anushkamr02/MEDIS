import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { CalendarDays, FilePen, LayoutDashboard, LogOut, Menu, UserRound, Users, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabaseClient';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui';
import { IDChip, Logo } from '../../components/medis';
import NotificationBell from '../../components/NotificationBell';

const NAV_ITEMS = [
  { to: '/doctor', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/doctor/patients', label: 'My Patients', icon: Users },
  { to: '/doctor/appointments', label: 'Appointments', icon: CalendarDays },
  { to: '/doctor/drafts', label: 'Drafts', icon: FilePen, badge: 'drafts' },
  { to: '/doctor/profile', label: 'My Profile', icon: UserRound },
];

/**
 * Shared shell for every /doctor/* page: sidebar navigation (with the
 * doctor's permanent ID + hospital), a top bar with notifications, and an <Outlet /> for the active page. The
 * doctor_profiles row is loaded once here and passed down via Outlet
 * context so child pages don't re-fetch it.
 */
export default function DoctorLayout() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [doctorProfile, setDoctorProfile] = useState(null);
  const [hospitalName, setHospitalName] = useState(null);
  const [draftCount, setDraftCount] = useState(0);
  const [notifications, setNotifications] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);

  // Exposed to child pages so the profile page can reload after an edit
  const loadDoctorProfile = useCallback(async () => {
    if (!profile?.id) return;

    const { data, error } = await supabase.from('doctor_profiles').select('*').eq('id', profile.id).maybeSingle();

    if (error) {
      console.error('Failed to load doctor profile:', error.message);
      return;
    }

    setDoctorProfile(data);

    // v1 stored hospital as free text; v3 links to the hospitals table.
    // Prefer the linked hospital when present, fall back to the old text.
    let name = data?.hospital_name ?? null;
    if (data?.hospital_id) {
      const { data: hospital } = await supabase.from('hospitals').select('name').eq('id', data.hospital_id).maybeSingle();
      if (hospital?.name) name = hospital.name;
    }
    setHospitalName(name);
  }, [profile?.id]);

  const loadNotifications = useCallback(async () => {
    if (!profile?.id) return;
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(20);
    setNotifications(data ?? []);
  }, [profile?.id]);

  useEffect(() => {
    loadDoctorProfile();
    loadNotifications();
  }, [loadDoctorProfile, loadNotifications]);

  // Drafts badge: refreshed on every navigation (a draft may have just been finalized)
  useEffect(() => {
    if (!profile?.id) return;
    supabase
      .from('consultations')
      .select('id', { count: 'exact', head: true })
      .eq('doctor_id', profile.id)
      .eq('status', 'pending')
      .then(({ count }) => setDraftCount(count ?? 0));
  }, [profile?.id, location.pathname]);

  async function markRead(id) {
    await supabase.from('notifications').update({ is_read: true }).eq('id', id);
    loadNotifications();
  }

  async function markAllRead() {
    await supabase.from('notifications').update({ is_read: true }).eq('user_id', profile.id).eq('is_read', false);
    loadNotifications();
  }

  async function logOut() {
    await signOut();
    navigate('/login');
  }

  const sidebar = (
    <nav className="flex h-full flex-col bg-sidebar p-4 text-sidebar-foreground">
      <div className="flex items-center justify-between">
        <Logo light />
        <button className="lg:hidden" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
          <X className="h-5 w-5" />
        </button>
      </div>
      <ul className="mt-8 space-y-1">
        {NAV_ITEMS.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-sidebar-accent',
                  isActive && 'bg-sidebar-accent text-sidebar-accent-foreground [&>svg]:text-sidebar-primary'
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
              {item.badge === 'drafts' && draftCount > 0 && (
                <span className="ml-auto rounded-full bg-sidebar-primary px-1.5 text-xs font-bold text-sidebar-primary-foreground">{draftCount}</span>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="mt-auto space-y-2 border-t border-sidebar-border pt-4 text-sm">
        <p className="font-semibold text-sidebar-accent-foreground">Dr. {profile?.full_name || ''}</p>
        <IDChip id={profile?.display_id} />
        <p className="text-xs opacity-80">
          {hospitalName ?? '—'}
          {doctorProfile?.specialization && ` · ${doctorProfile.specialization}`}
        </p>
        <button onClick={logOut} className="flex items-center gap-2 rounded-md py-1 text-sm hover:text-sidebar-primary">
          <LogOut className="h-4 w-4" />
          Log out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="sticky top-0 hidden h-screen lg:block">{sidebar}</aside>
      <div className={cn('fixed inset-0 z-50 lg:hidden', menuOpen ? 'block' : 'hidden')}>
        <div className="absolute inset-0 bg-foreground/40" onClick={() => setMenuOpen(false)} />
        <div className="relative h-full w-64 shadow-pop">{sidebar}</div>
      </div>
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-card/90 px-4 py-2.5 backdrop-blur">
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
            <Menu className="h-5 w-5" />
          </Button>
          <div className="ml-auto">
            <NotificationBell notifications={notifications} onMarkRead={markRead} onMarkAllRead={markAllRead} />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
          <Outlet context={{ doctorProfile, hospitalName, reloadDoctorProfile: loadDoctorProfile }} />
        </main>
      </div>
    </div>
  );
}
