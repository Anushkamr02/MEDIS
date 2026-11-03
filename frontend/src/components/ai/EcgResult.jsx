import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { formatDateTime } from '../../lib/format';
import { Progress, SimpleSelect } from '../ui';

// Digital recordings are resampled by the engine to 10 s at 100 Hz
const DIGITAL_FORMATS = ['wfdb', 'wfdb_mat', 'csv', 'npy'];
const LEAD_ORDER = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'Rhythm_Strip_II'];
// Light pink grid, like ECG paper
const ECG_PAPER = {
  backgroundImage:
    'repeating-linear-gradient(0deg, transparent 0 9px, var(--destructive-soft) 9px 10px), repeating-linear-gradient(90deg, transparent 0 9px, var(--destructive-soft) 9px 10px)',
};
const leadRank =(lead) => (LEAD_ORDER.includes(lead) ? LEAD_ORDER.indexOf(lead) : LEAD_ORDER.length);

/**
 * Waveform of one lead (like the teammate's web app: a lead selector plus
 * the trace). Time in seconds when the duration is known, otherwise the
 * sample number (no sampling rate is assumed for digitised printouts).
 */
function EcgWaveform({ result }) {
  const signals = result?.lead_signals ?? result?.digitization?.lead_signals ?? {};
  const leads = Object.keys(signals)
    .filter((k) => Array.isArray(signals[k]) && signals[k].length > 1)
    .sort((a, b) => leadRank(a) - leadRank(b));
  const [lead, setLead] = useState(leads.includes('II') ? 'II' : leads[0]);
  if (!leads.length) return null;

  const values = signals[lead] ?? [];
  const seconds =
    lead === 'Rhythm_Strip_II'
      ? result?.digitization?.rhythm_strip?.duration_sec
      : DIGITAL_FORMATS.includes(result?.input_format)
        ? 10
        : result?.digitization?.leads?.[lead]?.duration_sec;
  const data = values.map((v, i) => ({ x: seconds ? +((i * seconds) / (values.length - 1)).toFixed(3) : i, v }));

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold">ECG waveform</p>
        <div className="w-40">
          <SimpleSelect
            ariaLabel="ECG lead"
            value={lead}
            onChange={setLead}
            options={leads.map((l) => [l, l === 'Rhythm_Strip_II' ? 'Rhythm strip (II)' : `Lead ${l}`])}
          />
        </div>
      </div>
      <div className="h-48 w-full rounded-md" style={ECG_PAPER}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="x"
              type="number"
              domain={['dataMin', 'dataMax']}
              tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
              tickFormatter={(x) => (seconds ? `${x}s` : x)}
            />
            <YAxis tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} domain={['auto', 'auto']} unit=" mV" width={60} />
            <Tooltip
              formatter={(v) => [`${v} mV`, `Lead ${lead}`]}
              labelFormatter={(x) => (seconds ? `${x} s` : `sample ${x}`)}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
            <Line dataKey="v" type="linear" stroke="var(--foreground)" strokeWidth={1.2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {seconds ? `${seconds} s` : `${values.length} samples (sampling rate not assumed)`} · {leads.length} lead{leads.length === 1 ? '' : 's'} recorded.
        Check the original trace before acting on it.
      </p>
    </div>
  );
}

const INTERVALS = [
  ['heart_rate_bpm', 'HR', 'bpm'],
  ['pr_interval_ms', 'PR', 'ms'],
  ['qrs_duration_ms', 'QRS', 'ms'],
  ['qt_interval_ms', 'QT', 'ms'],
  ['qtc_bazett_ms', 'QTc', 'ms'],
];

const FORMAT = { pdf: 'PDF', image: 'image', wfdb: 'digital', csv: 'digital', npy: 'digital' };

// Checklist from the engine's validation block (digital recordings)
function qualityItems(validation) {
  if (!validation) return [];
  const items = [];
  if (validation.quality_score !== undefined) {
    items.push({ label: `Signal quality score ${Math.round(validation.quality_score)}/100`, ok: validation.overall_valid !== false });
  }
  const leads = validation.lead_validation;
  if (leads?.num_valid_leads !== undefined) {
    items.push({ label: `${leads.num_valid_leads} of ${leads.num_valid_leads + (leads.num_invalid_leads ?? 0)} leads usable`, ok: !leads.num_invalid_leads });
  }
  const signal = validation.signal_validation;
  if (signal?.duration_sec !== undefined) {
    items.push({ label: `${signal.duration_sec} s recording`, ok: signal.valid !== false });
  }
  return items;
}

/**
 * One ECG analysis (an ecg_analyses row or a fresh engine result). A
 * blocked or failed analysis is never shown as "normal".
 */
export default function EcgResult({ status, classification, result, fileName, createdAt }) {
  const intervals = result?.cardiac_intervals ?? result?.digitization?.cardiac_intervals ?? {};
  const validation = result?.validation;
  const issues = [...(validation?.all_issues ?? []), ...(result?.digitization?.issues ?? [])];
  const isMi = classification?.prediction === 'MI';
  // The engine still classifies a recording that fails its signal checks;
  // that prediction is not reliable, so it is withheld here.
  const qualityFailed = validation?.overall_valid === false;
  const showClass = status === 'validated_continuous_10s_analysis' && classification && !qualityFailed;
  const quality = qualityItems(validation);
  const shownIntervals = INTERVALS.filter(([k]) => intervals[k] !== undefined && intervals[k] !== null);

  return (
    <div className="space-y-2 text-sm">
      <p className="text-xs text-muted-foreground">
        {fileName}
        {result?.input_format && ` · ${FORMAT[result.input_format] ?? result.input_format}`}
        {createdAt && ` · analysed ${formatDateTime(createdAt)}`}
      </p>
      {status === 'failed' && (
        <p className="flex items-center gap-2 rounded-md bg-destructive-soft px-3 py-2 text-destructive">
          <XCircle className="h-4 w-4 shrink-0" />
          Couldn't read this file{result?.error ? `: ${result.error}` : ''}. Try a clearer scan or the digital ECG file.
        </p>
      )}
      {status === 'digitization_complete_cnn_blocked' && (
        <p className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          AI classification not run: printed or scanned ECGs are only digitised. The model is validated for continuous 10-second digital recordings.
          Measurements shown where available.
        </p>
      )}
      {status === 'validated_continuous_10s_analysis' && classification && qualityFailed && (
        <p className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          AI classification withheld: this recording failed the signal quality checks. Check the leads and recording, then upload it again.
        </p>
      )}
      {showClass && (
        <div>
          <p className={isMi ? 'font-semibold text-destructive' : 'font-semibold'}>{isMi ? 'Possible myocardial infarction (MI)' : 'Normal pattern (NORM)'}</p>
          <div className="mt-1 flex items-center gap-2">
            <Progress value={(classification.confidence ?? 0) * 100} className="h-2 flex-1" />
            <span className="text-xs">{Math.round((classification.confidence ?? 0) * 100)}% confidence</span>
          </div>
        </div>
      )}
      {quality.length > 0 && (
        <ul className="space-y-0.5">
          {quality.map((q) => (
            <li key={q.label} className="flex items-center gap-1.5 text-xs">
              {q.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <AlertTriangle className="h-3.5 w-3.5 text-warning" />}
              {q.label}
            </li>
          ))}
        </ul>
      )}
      {shownIntervals.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {shownIntervals.map(([k, label, unit]) => (
            <span key={k} className="rounded bg-muted px-2 py-0.5">
              <b className="uppercase">{label}</b> {intervals[k]} {unit}
            </span>
          ))}
        </div>
      )}
      <EcgWaveform key={createdAt ?? fileName} result={result} />
      {issues.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium">{issues.length} quality note(s)</summary>
          <ul className="mt-1 list-disc pl-5">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-ai">Decision support, not a diagnosis.</span> Verify against the trace.
      </p>
    </div>
  );
}
