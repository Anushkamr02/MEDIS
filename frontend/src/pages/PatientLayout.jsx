import { useCallback, useEffect, useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { LogOut, MessageCircle, UserRound } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { Button } from '../components/ui';
import { IDChip, Logo } from '../components/medis';
import NotificationBell from '../components/NotificationBell';
import PatientChat from '../components/PatientChat';

/**
 * Shell for every patient page: sticky header (Ask MEDIS, notifications,
 * profile, log out), the patient's name and ID, the floating Ask MEDIS
 * button and the chat drawer.
 */
export default function PatientLayout() {
  const { user, profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [chat, setChat] = useState(false);
  const [notifications, setNotifications] = useState([]);

  const loadNotifications = useCallback(async () => {
    if (!user?.id) return;
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20);
    setNotifications(data ?? []);
  }, [user?.id]);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  async function markRead(id) {
    await supabase.from('notifications').update({ is_read: true }).eq('id', id);
    loadNotifications();
  }

  async function markAllRead() {
    await supabase.from('notifications').update({ is_read: true }).eq('user_id', user.id).eq('is_read', false);
    loadNotifications();
  }

  async function logOut() {
    await signOut();
    navigate('/login');
  }

  return (
    <div className="min-h-screen pb-24">
      <header className="sticky top-0 z-30 border-b bg-card/90 backdrop-blur">
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
      </header>
      <main className="mx-auto max-w-6xl px-4 py-5">
        <Outlet />
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
