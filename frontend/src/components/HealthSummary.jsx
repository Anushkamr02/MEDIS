import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';
import { formatDate } from '../lib/format';
import { SUMMARY_STATUS } from '../lib/healthSummary';
import { cn } from '../lib/utils';
import { SingleTrendChart } from './ai/TrendChart';

const STATUS_STYLE = {
  steady: { tone: 'border-success/30 bg-success-soft text-success', icon: CheckCircle2 },
  keep_an_eye: { tone: 'border-warning/30 bg-warning-soft text-warning', icon: AlertTriangle },
  book_visit: {
    tone: 'border-destructive/30 bg-destructive-soft text-destructive',
    icon: AlertTriangle,
    text: 'If you have chest pain, fainting or severe breathlessness now, call 112 or 108.',
  },
};

function changeSentence(m) {
  const first = m.points[0];
  const last = m.points.at(-1);
  if (m.points.length < 2) return `${m.label}: ${last.value} ${m.unit} on ${formatDate(last.date)}.`;
  const verb = last.value > first.value ? 'went up' : last.value < first.value ? 'went down' : 'stayed';
  return `${m.label} ${verb} from ${first.value} to ${last.value} ${m.unit} between ${formatDate(first.date)} and ${formatDate(last.date)}.`;
}

/**
 * "Health summary from your doctor": the latest summary a doctor reviewed and
 * published (patient_health_summaries, migration v14). It holds only the
 * doctor's words, their chosen status and the measured values they ticked;
 * never the AI priority, risk %, flags or ECG results. Renders nothing until
 * something is published (or before v14).
 */
export default function HealthSummary({ patientId }) {
  const [summary, setSummary] = useState(null);
  const [metric, setMetric] = useState(null);

  useEffect(() => {
    if (!patientId) return;
    supabase
      .from('patient_health_summaries')
      .select('id, status_message, headline, points, next_step, shown_metrics, published_at, doctor:published_by(full_name)')
      .eq('patient_id', patientId)
      .is('withdrawn_at', null)
      .order('published_at', { ascending: false })
      .limit(1)
      .then(({ data }) => setSummary(data?.[0] ?? null));
  }, [patientId]);

  if (!summary) return null;

  const style = STATUS_STYLE[summary.status_message] ?? STATUS_STYLE.steady;
  const StatusIcon = style.icon;
  const metrics = summary.shown_metrics ?? {};
  const keys = Object.keys(metrics);
  const selected = keys.includes(metric) ? metric : keys[0];

  return (
    <div id="health-summary" className="scroll-mt-24 rounded-lg border bg-card p-3" aria-label="Health summary from your doctor" role="region">
      <h3 className="text-sm font-semibold">Health summary from your doctor</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Written by {summary.doctor?.full_name ? `Dr. ${summary.doctor.full_name}` : 'your doctor'} on {formatDate(summary.published_at)}
      </p>

      <div className={cn('mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm', style.tone)}>
        <StatusIcon className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-semibold">{SUMMARY_STATUS[summary.status_message]}</p>
          {style.text && <p className="mt-0.5 text-foreground/80">{style.text}</p>}
        </div>
      </div>

      <p className="mt-3 text-sm font-medium">{summary.headline}</p>
      {summary.points?.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
          {summary.points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {summary.next_step && <p className="mt-2 text-sm"><b>Next step:</b> {summary.next_step}</p>}

      {keys.length > 0 && (
        <div className="mt-3 space-y-2 rounded-lg border p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Your numbers over time</h4>
          <div className="flex flex-wrap gap-1.5">
            {keys.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setMetric(k)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  selected === k ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'
                )}
              >
                {metrics[k].label}
              </button>
            ))}
          </div>
          <p className="text-sm">{changeSentence(metrics[selected])}</p>
          <SingleTrendChart trajectories={metrics} metricKey={selected} />
          <p className="text-xs text-muted-foreground">The shaded band is the usual target range.</p>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">Ask your doctor if you have questions about this summary.</p>
    </div>
  );
}
