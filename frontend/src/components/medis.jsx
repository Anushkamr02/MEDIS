// MEDIS building blocks from the teammate's design: brand, ID chip,
// status/priority pills, section cards and empty/error/loading states.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Check, CircleDot, CloudOff, Copy, Inbox, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui';
import { cn } from '../lib/utils';
import { priorityInfo } from '../lib/aiPriority';
import medicalEmblem from './medical-emblem.png';

// ---------- Brand ----------
export function Logo({ className, light }) {
  return (
    <span className={cn('inline-flex items-center gap-1 font-display text-lg font-bold tracking-tight', light ? 'text-navy-foreground' : 'text-foreground', className)}>
      <img src={medicalEmblem} alt="Medical logo" loading="lazy" width={1024} height={1024} className="h-9 w-auto" />
      <span>MEDIS</span>
    </span>
  );
}

export function EcgLine({ className }) {
  return (
    <svg viewBox="0 0 600 80" className={cn('w-full', className)} aria-hidden fill="none">
      <path
        className="animate-ecg"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        d="M0 40 H120 L135 40 L145 20 L155 60 L165 40 H220 L232 40 L240 8 L252 72 L262 40 H330 L340 34 L352 40 H420 L432 40 L440 12 L452 68 L462 40 H600"
      />
    </svg>
  );
}

export function AuthAside() {
  const features = [
    ['Your record, everywhere', 'One permanent ID across every hospital.'],
    ['Doctors you can see', 'Every record access is logged for you.'],
    ['Prescriptions in your pocket', 'Download any prescription as a PDF.'],
    ['AI decision support', 'Trends and alerts for doctors, clearly labelled.'],
  ];
  return (
    <aside className="relative hidden overflow-hidden bg-hero p-10 text-navy-foreground lg:flex lg:flex-col lg:justify-between">
      <Logo light />
      <div className="space-y-8">
        <div>
          <h1 className="max-w-md text-4xl font-bold leading-tight">Connected care, one record at a time.</h1>
          <EcgLine className="mt-6 text-sidebar-primary" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          {features.map(([t, d]) => (
            <div key={t} className="rounded-xl border border-sidebar-border bg-sidebar-accent/50 p-3">
              <p className="text-sm font-semibold">{t}</p>
              <p className="mt-1 text-xs opacity-80">{d}</p>
            </div>
          ))}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest opacity-70">How it works</p>
          <ol className="mt-2 flex gap-4 text-sm">
            {['Register and get your ID', 'Share the ID with your doctor', 'See results they share'].map((s, i) => (
              <li key={s} className="flex-1">
                <span className="font-display text-2xl font-bold text-sidebar-primary">{i + 1}</span>
                <p className="opacity-90">{s}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <p className="text-xs opacity-70">Privacy: patients see only their own data, and only visits a doctor has shared.</p>
    </aside>
  );
}

// ---------- Chips and pills ----------
export function IDChip({ id, className }) {
  const [done, setDone] = useState(false);
  if (!id) return null;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md border bg-muted/60 py-0.5 pl-2 pr-0.5 font-mono text-xs text-foreground', className)}>
      {id}
      <button
        type="button"
        aria-label={`Copy ${id}`}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-primary"
        onClick={(e) => {
          e.stopPropagation();
          navigator.clipboard?.writeText(id);
          setDone(true);
          toast.success('ID copied');
          setTimeout(() => setDone(false), 1500);
        }}
      >
        {done ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}

const PILL = {
  scheduled: 'bg-info-soft text-info border-info/20',
  completed: 'bg-success-soft text-success border-success/20',
  cancelled: 'bg-muted text-muted-foreground border-border',
  missed: 'bg-warning-soft text-warning border-warning/30',
  'no show': 'bg-warning-soft text-warning border-warning/30',
  draft: 'bg-warning-soft text-warning border-warning/30',
  final: 'bg-success-soft text-success border-success/20',
  'pending review': 'bg-warning-soft text-warning border-warning/30',
  reviewed: 'bg-info-soft text-info border-info/20',
  verified: 'bg-success-soft text-success border-success/20',
  'needs clarification': 'bg-destructive-soft text-destructive border-destructive/20',
  'shared with patient': 'bg-primary-soft text-primary border-primary/20',
  'not shared': 'bg-muted text-muted-foreground border-border',
};
const PILL_LABEL = { draft: 'Draft · pending', final: 'Final · completed' };

// Our statuses: consultations 'pending' / 'completed' -> draft / final;
// snake_case values (pending_review, no_show) -> words.
export function pillValue(status, kind) {
  if (kind === 'visit') return status === 'pending' ? 'draft' : 'final';
  return String(status ?? '').replace(/_/g, ' ');
}

export function StatusPill({ value }) {
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium capitalize', PILL[value] ?? PILL.cancelled)}>
      <CircleDot className="h-2.5 w-2.5" aria-hidden />
      {PILL_LABEL[value] ?? value}
    </span>
  );
}

const PRI = {
  urgent: 'bg-destructive text-destructive-foreground border-destructive',
  review: 'bg-warning-soft text-warning border-warning/40',
  ok: 'bg-success-soft text-success border-success/30',
  none: 'bg-muted text-muted-foreground border-border',
};
/** Review priority from the engine (URGENT_REVIEW, REVIEW, ...), shown with our doctor-facing labels. */
export function PriorityPill({ value, size = 'sm' }) {
  const info = priorityInfo(value);
  const Icon = info.cls === 'urgent' || info.cls === 'review' ? AlertTriangle : info.cls === 'ok' ? Check : CircleDot;
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full border font-semibold tracking-wide', size === 'lg' ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-[11px]', PRI[info.cls])}>
      <Icon className={size === 'lg' ? 'h-4 w-4' : 'h-3 w-3'} aria-hidden />
      {info.label}
    </span>
  );
}

export function AIBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-ai-soft px-1.5 py-0.5 text-[11px] font-semibold text-ai">
      <Sparkles className="h-3 w-3" aria-hidden />
      AI
    </span>
  );
}

export function AIDisclaimer({ meta }) {
  return (
    <p className="text-xs text-muted-foreground">
      <span className="font-medium text-ai">Decision support, not a diagnosis. Final decision rests with the doctor.</span>
      {meta && <> · {meta}</>}
    </p>
  );
}

// ---------- Layout and states ----------
export function Section({ title, icon, action, children, className, id }) {
  return (
    <section id={id} className={cn('rounded-xl border bg-card p-4 shadow-card sm:p-5 scroll-mt-20', className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          {icon}
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * A Section whose body scrolls inside the panel instead of growing it.
 *
 * The outer panel is a flex column with `overflow-hidden` and a height
 * cap (`maxHeight`, or `height` for a fixed one). The header is
 * `shrink-0`, so adding records never moves it, and the body gets
 * `flex-1` + `min-h-0` so it takes the leftover space and scrolls
 * rather than stretching the panel — or the panel beside it in a grid.
 * `min-w-0` on the panel and its body stops a long file name or ID
 * from widening the grid column.
 *
 * The body is focusable (`tabIndex={0}`) so the list is reachable with
 * the keyboard alone; the scrollbar styling lives in `.medis-scroll`.
 * `maxHeight` is per-panel on purpose — there is no one universal
 * height — and it can be a responsive Tailwind class via `bodyClassName`
 * instead if a panel needs breakpoint-specific sizing.
 */
export function ScrollPanel({ id, title, icon, action, children, footer, className, bodyClassName, maxHeight = '28rem', label }) {
  return (
    <section
      id={id}
      style={maxHeight ? { maxHeight } : undefined}
      className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-card scroll-mt-20', className)}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-5">
        <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold">
          {icon}
          <span className="truncate">{title}</span>
        </h2>
        {action}
      </div>
      <div
        tabIndex={0}
        role="group"
        aria-label={label ?? (typeof title === 'string' ? `${title}, scrollable` : undefined)}
        className={cn('medis-scroll min-h-0 min-w-0 flex-1 px-4 py-3 sm:px-5', bodyClassName)}
      >
        {children}
      </div>
      {footer && <div className="shrink-0 border-t px-4 py-2 text-xs text-muted-foreground sm:px-5">{footer}</div>}
    </section>
  );
}

/**
 * The "View details" modal both dashboards use: an accessible label, a
 * description for screen readers, a close button, Escape to dismiss and
 * focus returned to the trigger (all from Radix Dialog). Tall content
 * scrolls inside the modal rather than off-screen.
 */
export function DetailsDialog({ open, onOpenChange, title, description, children, footer }) {
  // Remember what had focus when the modal opened and put it back on
  // close, so a "View details" button does not lose the keyboard.
  const opener = useRef(null);
  useEffect(() => {
    if (open) {
      opener.current = document.activeElement;
      return undefined;
    }
    const target = opener.current;
    opener.current = null;
    if (!target?.isConnected) return undefined;
    const frame = requestAnimationFrame(() => target.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-2xl grid-rows-[auto_1fr_auto] overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4 pr-12 text-left">
          <DialogTitle className="pr-2">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="medis-scroll min-h-0 px-5 py-4">{children}</div>
        {footer && <DialogFooter className="gap-2 border-t px-5 py-3">{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

export function EmptyState({ text, action }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
      <Inbox className="h-5 w-5" aria-hidden />
      {text}
      {action}
    </div>
  );
}

export function ErrorState({ text, onRetry }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive">
      <span className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {text}
      </span>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function WarningState({ children, className }) {
  return (
    <div className={cn('flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning', className)}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function ServiceUnavailable({ text }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-3 text-sm text-muted-foreground">
      <CloudOff className="h-4 w-4 shrink-0" />
      {text ?? 'AI analysis is temporarily unavailable. All other features work normally.'}
    </div>
  );
}

export function Spinner({ text }) {
  return (
    <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground" role="status">
      <Loader2 className="h-4 w-4 animate-spin text-primary" />
      {text}
    </div>
  );
}

export function FullPageSpinner({ text = 'Loading...' }) {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner text={text} />
    </div>
  );
}

export function Field({ label, value }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value === '' || value === null || value === undefined ? '—' : value}</dd>
    </div>
  );
}

export function BackButton({ to }) {
  const navigate = useNavigate();
  return (
    <Button variant="ghost" size="sm" className="-ml-2 mb-2 text-muted-foreground" onClick={() => (to ? navigate(to) : navigate(-1))}>
      <ArrowLeft className="h-4 w-4" />
      Back
    </Button>
  );
}

/** Segmented tabs used for filters (All / Critical ..., Upcoming / Past). */
export function SegmentedTabs({ options, value, onChange, label }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex flex-wrap rounded-lg bg-muted p-1">
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={value === v}
          onClick={() => onChange(v)}
          className={cn('rounded-md px-3 py-1.5 text-sm font-medium transition-colors', value === v ? 'bg-card shadow-card' : 'text-muted-foreground')}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
