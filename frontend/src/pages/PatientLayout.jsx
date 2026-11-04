import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { FileText, History, LayoutDashboard, LogOut, Menu, MessageCircle, Pill, ShieldCheck, UserRound, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../hooks/useNotifications';
import { usePatientData } from '../hooks/usePatientData';
import { cn } from '../lib/utils';
import { Button } from '../components/ui';
import { IDChip, Logo } from '../components/medis';
import NotificationBell from '../components/NotificationBell';
import PatientChat from '../components/PatientChat';

/** The five sections of the patient dashboard, in order. */
export const PATIENT_NAV = [
  { to: '/patient', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/patient/prescriptions', label: 'Prescriptions', icon: Pill },
  { to: '/patient/documents', label: 'Medical Documents', icon: FileText },
  { to: '/patient/visits', label: 'Visit History', icon: History },
  { to: '/patient/access', label: 'Doctors Who Accessed Profile', icon: ShieldCheck },
];

/**
 * Shell for every patient page: sticky header (Ask MEDIS, notifications,
 * profile, log out), the patient's name and ID, the five-section
 * navigation, the floating Ask MEDIS button and the chat drawer.
 *
 * The patient's record is loaded once here and handed to every section
 * through Outlet context, so switching sections is a client-side route
 * change with no refetch and no page reload. `refresh()` is passed down
 * for the sections that write (document upload and deletion).
 */
export default function PatientLayout() {
  const { user, profile, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [chat, setChat] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { notifications, markRead, markAllRead } = useNotifications(user?.id);
  const patientData = usePatientData(user?.id);
  const closeButton = useRef(null);

  // Close the mobile section menu after a navigation.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  // The drawer is a modal surface: Escape closes it and focus starts inside.
  useEffect(() => {
    if (!menuOpen) return;
    closeButton.current?.focus();
    function onKeyDown(event) {
      if (event.key === 'Escape') setMenuOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  async function logOut() {
    await signOut();
    navigate('/login');
  }

  const navClass = ({ isActive }) =>
    cn(
      'inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
      'hover:bg-primary-soft hover:text-primary',
      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      isActive ? 'bg-primary-soft text-primary shadow-card' : 'text-muted-foreground'
    );

  return (
    <div className="min-h-screen pb-24">
      <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2.5">
          <Link to="/patient" aria-label="MEDIS home">
            <Logo />
          </Link>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" className="hidden sm:inline-flex" onClick={() => setChat(true)}>
              <MessageCircle className="h-4 w-4" />
              Ask MEDIS
            </Button>
            <NotificationBell notifications={notifications} onMarkRead={markRead} onMarkAllRead={markAllRead} />
            <Button variant="ghost" size="icon" asChild aria-label="My profile">
              <Link to="/patient/profile">
                <UserRound className="h-5 w-5" />
              </Link>
            </Button>
            <Button variant="ghost" size="icon" aria-label="Log out" onClick={logOut}>
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>

        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 pb-2 text-sm">
          <span className="font-medium">{profile?.full_name || 'Patient'}</span>
          <IDChip id={profile?.display_id} />
        </div>

        {/* Sections. Wide screens get the full row; narrow screens get a
            button that opens the same five links as a drawer. */}
        <nav aria-label="Patient sections" className="mx-auto max-w-6xl px-4 pb-2">
          <ul className="hidden flex-wrap gap-1 md:flex">
            {PATIENT_NAV.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end} className={navClass}>
                  <item.icon className="h-4 w-4" aria-hidden />
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
          <Button variant="outline" size="sm" className="md:hidden" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
            <Menu className="h-4 w-4" />
            Sections
          </Button>
        </nav>
      </header>

      {menuOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Patient sections">
          <div className="absolute inset-0 bg-foreground/40" onClick={() => setMenuOpen(false)} />
          <div className="relative ml-auto flex h-full w-72 max-w-[85vw] flex-col gap-1 bg-card p-4 shadow-pop">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-semibold">Sections</span>
              <button ref={closeButton} aria-label="Close sections menu" className="rounded-md p-1 hover:bg-muted" onClick={() => setMenuOpen(false)}>
                <X className="h-5 w-5" />
              </button>
            </div>
            {PATIENT_NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
                <item.icon className="h-4 w-4" aria-hidden />
                {item.label}
              </NavLink>
            ))}
          </div>
        </div>
      )}

      <main className="mx-auto max-w-6xl px-4 py-5">
        <Outlet context={{ ...patientData }} />
      </main>

      <button
        onClick={() => setChat(true)}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-pop transition-transform hover:scale-105 active:scale-95"
      >
        <MessageCircle className="h-5 w-5" />
        Ask MEDIS
      </button>
      <PatientChat open={chat} onOpenChange={setChat} />
    </div>
  );
}
