import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDot } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';
import { formatDate } from '../lib/format';
import { cn } from '../lib/utils';
import { SingleTrendChart } from './ai/TrendChart';
import { AIBadge } from './medis';

// Plain-language names for each tracked number
const METRICS = [
  { key: 'systolic_bp', label: 'Blood pressure (top number)' },
  { key: 'diastolic_bp', label: 'Blood pressure (bottom number)' },
  { key: 'ldl_cholesterol', label: 'LDL ("bad") cholesterol' },
  { key: 'hdl_cholesterol', label: 'HDL ("good") cholesterol' },
  { key: 'total_cholesterol', label: 'Total cholesterol' },
  { key: 'triglycerides', label: 'Triglycerides (blood fats)' },
  { key: 'fasting_glucose', label: 'Fasting blood sugar' },
  { key: 'hba1c', label: 'HbA1c (3-month average sugar)' },
  { key: 'bmi', label: 'Body mass index (BMI)' },
  { key: 'serum_creatinine', label: 'Creatinine (kidney)' },
  { key: 'egfr', label: 'eGFR (kidney function)' },
];

const PRIORITY = {
  NO_FLAGGED_PROGRESSION: {
    tone: 'border-success/30 bg-success-soft text-success',
    icon: CheckCircle2,
    title: 'No worrying trend found',
    text: 'Your doctor reviewed how your results have changed over your visits, and nothing needs extra attention.',
  },
  REVIEW: {
    tone: 'border-warning/30 bg-warning-soft text-warning',
    icon: AlertTriangle,
    title: 'Some results to keep an eye on',
    text: 'Some of your results are changing in a way your doctor wants to follow. It is a reason to talk with your doctor, not a diagnosis.',
  },
  URGENT_REVIEW: {
    tone: 'border-destructive/30 bg-destructive-soft text-destructive',
    icon: AlertTriangle,
    title: 'Your doctor wants to discuss your results soon',
    text: 'Some results need a closer look. Please book or keep your next appointment soon. If you have chest pain, fainting or severe breathlessness now, call 112 or 108.',
  },
  INSUFFICIENT_DATA: {
    tone: 'border-border bg-muted text-muted-foreground',
    icon: CircleDot,
    title: 'Not enough visits yet',
    text: 'A trend needs results from more than one visit. Your doctor will be able to say more after your next check-up.',
  },
};

function changeSentence(m, label) {
  const first = m.points[0];
  const last = m.points.at(-1);
  if (m.points.length < 2) return `${label}: ${last.value} ${m.unit} on ${formatDate(last.date)}.`;
  const verb = last.value > first.value ? 'went up' : last.value < first.value ? 'went down' : 'stayed';
  return `${label} ${verb} from ${first.value} to ${last.value} ${m.unit} between ${formatDate(first.date)} and ${formatDate(last.date)}.`;
}

/**
 * The patient's latest heart health check that their doctor chose to share
 * (cad_assessments.shared_with_patient, migration v6), in plain words.
 * Renders nothing until something is shared.
 */
export default function HeartHealthCheck({ patientId }) {
  const [check, setCheck] = useState(null);
  const [metric, setMetric] = useState(null);

  useEffect(() => {
    if (!patientId) return;
    supabase
      .from('cad_assessments')
      .select('id, report, pce, shared_at, patient_note, doctor:shared_by(full_name)')
      .eq('patient_id', patientId)
      .eq('shared_with_patient', true)
      .order('shared_at', { ascending: false })
      .limit(1)
      .then(({ data }) => setCheck(data?.[0] ?? null)); // no row (or v6 not applied): show nothing
  }, [patientId]);

  if (!check) return null;

  const report = check.report ?? {};
  const priority = PRIORITY[report.review_priority] ?? PRIORITY.INSUFFICIENT_DATA;
  const PriorityIcon = priority.icon;
  const trajectories = report.metric_trajectories ?? {};
  const withData = METRICS.filter((m) => trajectories[m.key]?.count > 0);
  const selected = withData.find((m) => m.key === metric) ?? withData[0];
  const series = selected && trajectories[selected.key];
  const pce = check.pce?.status === 'CALCULATED' ? check.pce : null;

  return (
    <div className="rounded-lg border border-ai/20 bg-ai-soft/40 p-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        Your heart health check <AIBadge />
      </h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Shared by {check.doctor?.full_name ? `Dr. ${check.doctor.full_name}` : 'your doctor'} on {formatDate(check.shared_at)} · based on
        results up to {formatDate(report.as_of)}
      </p>

      <div className={cn('mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm', priority.tone)}>
        <PriorityIcon className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-semibold">{priority.title}</p>
          <p className="mt-0.5 text-foreground/80">{priority.text}</p>
        </div>
      </div>

      {check.patient_note && (
        <blockquote className="mt-3 border-l-2 border-primary/40 pl-3 text-sm italic">
          <span className="block text-xs not-italic text-muted-foreground">Note from your doctor</span>
          {check.patient_note}
        </blockquote>
      )}

      {withData.length > 0 && (
        <div className="mt-3 space-y-2 rounded-lg border bg-card p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Your numbers over time</h4>
          <div className="flex flex-wrap gap-1.5">
            {withData.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setMetric(m.key)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  selected?.key === m.key ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          {series && (
            <>
              <p className="text-sm">{changeSentence(series, selected.label)}</p>
              <SingleTrendChart trajectories={trajectories} metricKey={selected.key} />
              <p className="text-xs text-muted-foreground">The shaded band is the usual target range.</p>
            </>
          )}
        </div>
      )}

      {pce && (
        <div className="mt-3 rounded-lg border bg-card p-3 text-sm">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">10-year heart risk estimate</h4>
          <p className="mt-1">
            <b>{pce.risk_percent}%</b> ({pce.category}): out of 100 people with numbers like yours, about {Math.round(pce.risk_percent)} may
            have a heart attack or stroke in the next 10 years. It is an estimate for a group of people, not a prediction for you.
          </p>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        <span className="font-medium text-ai">This is a screening summary made with the help of software and checked by your doctor. It is not a diagnosis.</span>{' '}
        Ask your doctor what it means for you, or tap "Ask MEDIS" to have it explained.
      </p>
    </div>
  );
}
