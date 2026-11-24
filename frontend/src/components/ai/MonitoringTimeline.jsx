import { useCallback, useEffect, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';
import { isMissingColumn } from '../../lib/dashboardCompatibility';
import { METRIC_STATUS, TREATMENT_STATUS, TRIGGER_LABEL, trendInfo } from '../../lib/healthTrend';
import { formatDate, formatDateTime } from '../../lib/format';
import { ESCALATION_LEVEL, ESCALATION_REASON } from '../../lib/escalation';
import { cn } from '../../lib/utils';
import { AIBadge, EmptyState, Spinner, TrendPill, TREND_PILL } from '../medis';
import { assessmentFindings } from '../../lib/findingReview';
import FindingReview from './FindingReview';

const reading = (r, unit) => (r ? `${r.value}${unit ? ` ${unit}` : ''} (${formatDate(r.date)})` : '—');

/**
 * Continuous monitoring for one patient (migration v12): one dot per saved
 * check, what changed since the previous check, and how each recognised
 * medicine is working. Hidden on a database without v12.
 */
export default function MonitoringTimeline({ patientId }) {
  const [runs, setRuns] = useState(null); // newest first; null while loading
  const [available, setAvailable] = useState(true);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState('');
  const [escalations, setEscalations] = useState([]);

  const load = useCallback(async () => {
    if (!patientId) return;
    const { data, error: loadError } = await supabase.from('cad_assessments')
      .select('id, created_at, review_priority, health_trend, trigger_event, monitoring')
      .eq('patient_id', patientId).not('health_trend', 'is', null)
      .order('created_at', { ascending: false }).limit(20);
    if (isMissingColumn(loadError)) {
      setAvailable(false);
      return;
    }
    if (loadError) setError(loadError.message);
    setRuns((data ?? []).filter((r) => r.health_trend));
    setSelected(0);
  }, [patientId]);

  useEffect(() => {
    load();
  }, [load]);

  // Escalation steps for this patient's urgent findings (migration v15); none before it.
  useEffect(() => {
    if (!patientId) return;
    supabase.from('escalation_events').select('id, level, reason, finding_at, created_at, doctors_notified')
      .eq('patient_id', patientId).order('created_at', { ascending: false }).limit(20)
      .then(({ data, error: escalationError }) => setEscalations(escalationError ? [] : data ?? []));
  }, [patientId]);

  if (!available) return null;

  const run = runs?.[selected];
  const monitoring = run?.monitoring ?? {};
  const changes = (monitoring.metric_changes ?? []).filter((m) => m.status !== 'insufficient' || m.latest);
  const treatments = monitoring.treatment_responses ?? [];

  return (
    <section className="rounded-xl border border-ai/20 bg-card p-4 shadow-card sm:p-5" aria-label="Monitoring">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <TrendingUp className="h-4 w-4 text-ai" />
          Monitoring <AIBadge />
        </h2>
        {runs?.[0] && <TrendPill value={runs[0].health_trend} size="lg" />}
      </div>

      <div className="mt-3 space-y-4">
        {error && <p className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{error}</p>}
        {!runs ? (
          <Spinner text="Loading monitoring..." />
        ) : runs.length === 0 ? (
          <EmptyState text="No monitoring checks yet. The patient is re-checked when a visit is finalized or a prescription is issued." />
        ) : (
          <>
            <ol className="flex flex-wrap items-center gap-1.5" aria-label="Monitoring checks, oldest first">
              {[...runs].reverse().map((r) => {
                const index = runs.indexOf(r);
                const info = trendInfo(r.health_trend);
                const label = `${TRIGGER_LABEL[r.trigger_event] ?? 'Check'}, ${formatDate(r.created_at)}: ${info.label}`;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      title={label}
                      aria-label={label}
                      aria-pressed={index === selected}
                      onClick={() => setSelected(index)}
                      className={cn('flex h-7 w-7 items-center justify-center rounded-full border text-xs font-bold', TREND_PILL[info.cls],
                        index === selected && 'ring-2 ring-ring ring-offset-1')}
                    >
                      <span aria-hidden>{info.arrow}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <p className="text-xs text-muted-foreground">
              {TRIGGER_LABEL[run.trigger_event] ?? 'Check'} · {formatDate(run.created_at)} · <TrendPill value={run.health_trend} />
            </p>
            <FindingReview key={run.id} patientId={patientId} assessmentId={run.id} findings={assessmentFindings(run)} evidence={monitoring.reasons} />

            {monitoring.reasons?.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {monitoring.reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
            )}

            {changes.length > 0 && (
              <div className="overflow-x-auto rounded-lg border p-3">
                <h3 className="mb-2 text-sm font-semibold">Since last check</h3>
                <table className="w-full min-w-[520px] text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr><th className="pb-1">Measure</th><th className="pb-1">Previous</th><th className="pb-1">Latest</th><th className="pb-1">Target</th><th className="pb-1">Status</th></tr>
                  </thead>
                  <tbody className="divide-y">
                    {changes.map((m) => {
                      const status = METRIC_STATUS[m.status] ?? METRIC_STATUS.insufficient;
                      return (
                        <tr key={m.metric}>
                          <td className="py-1.5 font-medium">{m.label}</td>
                          <td>{reading(m.previous, m.unit)}</td>
                          <td>{reading(m.latest, m.unit)}</td>
                          <td className="text-muted-foreground">{m.target}</td>
                          <td><TrendPill label={status.label} cls={status.cls} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {treatments.length > 0 && (
              <div className="rounded-lg border p-3">
                <h3 className="mb-2 text-sm font-semibold">Treatment response</h3>
                <ul className="divide-y text-sm">
                  {treatments.map((t) => {
                    const status = TREATMENT_STATUS[t.status] ?? TREATMENT_STATUS.no_baseline;
                    return (
                      <li key={`${t.medicine}-${t.metric}-${t.started}`} className="flex flex-wrap items-center gap-2 py-1.5">
                        <span className="font-medium">{t.medicine}</span>
                        <span className="text-xs text-muted-foreground">{t.class_label} · {t.metric_label} · started {formatDate(t.started)}</span>
                        <TrendPill label={status.label} cls={status.cls} />
                        <span className="text-xs text-muted-foreground">
                          {t.status === 'awaiting_follow_up'
                            ? `${t.overdue ? 'Overdue: ' : ''}check ${t.metric_label} between ${formatDate(t.due_from)} and ${formatDate(t.due_by)}`
                            : t.baseline && t.follow_up ? `${reading(t.baseline, t.unit)} → ${reading(t.follow_up, t.unit)}` : ''}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </>
        )}
        {escalations.length > 0 && (
          <div className="rounded-lg border border-destructive/30 p-3" aria-label="Escalation history" role="group">
            <h3 className="mb-2 text-sm font-semibold">Escalation history</h3>
            <ul className="divide-y text-sm">
              {escalations.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2 py-1.5">
                  <span className={cn('font-medium', e.level > 0 && 'text-destructive')}>{ESCALATION_LEVEL[e.level]}</span>
                  <span className="text-xs text-muted-foreground">
                    {ESCALATION_REASON[e.reason]} · {formatDateTime(e.created_at)} · {e.doctors_notified} doctor{e.doctors_notified === 1 ? '' : 's'} notified
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          Decision support, not a diagnosis. The trend compares recorded values with the previous check and with standard targets; the doctor decides.
        </p>
      </div>
    </section>
  );
}
