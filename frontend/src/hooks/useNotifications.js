import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '../lib/supabaseClient';

/**
 * The signed-in user's notifications, with the unread count counted by
 * the database rather than inferred from the loaded page. Refreshed when
 * the tab regains focus, so a notification created while the user was
 * elsewhere shows up without a reload.
 *
 * Marking as read reports a failure through a toast instead of throwing:
 * it is called straight from a click handler in NotificationBell.
 */
export function useNotifications(userId) {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!userId) return;
    const [list, unread] = await Promise.all([
      supabase.from('notifications').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(30),
      supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('is_read', false),
    ]);
    setError(list.error?.message || unread.error?.message || '');
    if (!list.error) setNotifications(list.data ?? []);
    if (!unread.error) setUnreadCount(unread.count ?? 0);
  }, [userId]);

  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  const markRead = useCallback(
    async (id) => {
      const { error: updateError } = await supabase.from('notifications').update({ is_read: true }).eq('id', id).eq('user_id', userId);
      if (updateError) {
        toast.error('Could not mark this notification as read.');
        return;
      }
      await refresh();
    },
    [userId, refresh]
  );

  const markAllRead = useCallback(async () => {
    const { error: updateError } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false);
    if (updateError) {
      toast.error('Could not mark your notifications as read.');
      return;
    }
    await refresh();
  }, [userId, refresh]);

  return { notifications, unreadCount, error, refresh, markRead, markAllRead };
}
