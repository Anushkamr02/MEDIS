import { Bell } from 'lucide-react';
import { Button, Popover, PopoverContent, PopoverTrigger } from './ui';
import { cn } from '../lib/utils';
import { formatDateTime } from '../lib/format';

/**
 * Bell icon with an unread-count badge; the popover lists notifications.
 * Clicking an unread one marks it read.
 */
export default function NotificationBell({ notifications, onMarkRead, onMarkAllRead }) {
  const unread = notifications.filter((n) => !n.is_read).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Notifications, ${unread} unread`} className="relative">
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">Notifications</span>
          <button className="text-xs font-medium text-primary hover:underline disabled:opacity-50" disabled={!unread} onClick={onMarkAllRead}>
            Mark all as read
          </button>
        </div>
        <ul className="max-h-80 overflow-auto">
          {notifications.length === 0 && <li className="p-4 text-center text-sm text-muted-foreground">No notifications yet.</li>}
          {notifications.map((n) => (
            <li key={n.id}>
              <button
                className={cn('flex w-full gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted', !n.is_read && 'bg-primary-soft/50')}
                onClick={() => !n.is_read && onMarkRead(n.id)}
              >
                <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.is_read ? 'bg-transparent' : 'bg-primary')} />
                <span>
                  <span className={cn(!n.is_read && 'font-medium')}>{n.title}</span>
                  {n.body && <span className="block text-muted-foreground">{n.body}</span>}
                  <span className="block text-xs text-muted-foreground">{formatDateTime(n.created_at)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
