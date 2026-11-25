import { useEffect, useMemo, useState } from 'react';
import { Calculator, Info } from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';
import { aiRequest } from '../../lib/aiClient';
import { formatDate, formatDateTime } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Button } from '../ui';
import { ServiceUnavailable, WarningState } from '../medis';
import RiskForm from './RiskForm';

const CATEGORY = {
  LOW: { label: 'Low (< 5%)', tone: 'text-success' },
  BORDERLINE: { label: 'Borderline (5–7.4%)', tone: 'text-warning' },
  INTERMEDIATE: { label: 'Intermediate (7.5–19.9%)', tone: 'text-warning' },
  HIGH: { label: 'High (≥ 20%)', tone: 'text-destructive' },
};

const OUTCOME_LABEL = {
  total_cvd: 'Total CVD',
  ascvd: 'Heart attack or stroke (ASCVD)',
  heart_failure: 'Heart failure',
};

function ageFrom(dateOfBirth) {
  if (!dateOfBirth) return '';
  const born = new Date(dateOfBirth);
  const now = new Date();
  const years = now.getFullYear() - born.getFullYear() -
    (now.getMonth() < born.getMonth() || (now.getMonth() === born.getMonth() && now.getDate() < born.getDate()) ? 1 : 0);
  return years > 0 && years < 130 ? years : '';
}

/** The engine's own words whenever no number may be shown. */
function blockedText(result) {
  if (result.status === 'NOT_APPLICABLE') {
    return 'Not applicable: the patient has known cardiovascular disease, or the confirmed sex is outside the equation. No number is shown.';
  }
  if (result.status === 'NOT_CALCULATED' && result.missing_inputs?.length) {
    return `Not calculated: confirm ${result.missing_inputs.join(', ').replaceAll('_', ' ')}.`;
  }
  return result.reason || 'Not calculated.';
}

function ConfirmedLine({ result }) {
  if (!result.confirmed_at) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Inputs confirmed{result.confirmed_by_name ? ` by ${result.confirmed_by_name}` : ''} on {formatDateTime(result.confirmed_at)}
      {result.inputs?.snapshot_date && ` · values measured ${formatDate(result.inputs.snapshot_date)}`}
    </p>
  );
}

function Limitations({ notes }) {
  if (!notes?.length) return null;
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="flex cursor-pointer items-center gap-1 font-medium">
        <Info className="h-3 w-3" aria-hidden />
        Limitations
      </summary>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </details>
  );
}

/** PREVENT: one percentage per outcome whose inputs were confirmed. */
function PreventResult({ result }) {
  if (result.status !== 'CALCULATED') return <WarningState>{blockedText(result)}</WarningState>;
  const band = CATEGORY[result.category];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-4">
        {Object.entries(result.risks).map(([outcome, percent]) => (
          <div key={outcome}>
            <p className={cn('text-2xl font-bold leading-none', outcome === 'ascvd' && band?.tone)}>{percent}%</p>
            <p className="text-xs text-muted-foreground">{OUTCOME_LABEL[outcome] ?? outcome}</p>
          </div>
        ))}
      </div>
      {band && <p className={cn('text-xs font-semibold', band.tone)}>ASCVD risk band: {band.label}</p>}
      {Object.entries(result.unavailable ?? {}).map(([outcome, reason]) => (
        <p key={outcome} className="text-xs text-muted-foreground">
          {OUTCOME_LABEL[outcome] ?? outcome}: {reason}
        </p>
      ))}
    </div>
  );
}

/** Legacy 2013 PCE: one ASCVD percentage. */
function PceResult({ result }) {
  if (result.status !== 'CALCULATED') return <WarningState>{blockedText(result)}</WarningState>;
  const band = CATEGORY[result.category];
  return (
    <div className="flex flex-wrap items-end gap-3">
      <p className={cn('text-2xl font-bold leading-none', band?.tone)}>{result.risk_percent}%</p>
      <div className="text-xs">
        {band && <p className={cn('font-semibold', band.tone)}>{band.label}</p>}
        <p className="text-muted-foreground">{result.outcome}</p>
      </div>
    </div>
  );
}

/**
 * 10-year risk, doctor-only: the 2023 PREVENT base model and, for comparison,
 * the legacy 2013 PCE. Both run only on inputs the doctor confirms in
 * RiskForm; neither is merged with the trend screening or its review
 * priority, and neither is ever shown to the patient.
 */
export default function RiskCard({ assessment, trajectories = {}, patientId, onSaved }) {
  const [model, setModel] = useState(null); // which form is open
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [stored, setStored] = useState(assessment?.pce ?? null);
  const [patient, setPatient] = useState(null);

  useEffect(() => {
    setStored(assessment?.pce ?? null);
    setError('');
  }, [assessment?.id, assessment?.pce]);

  useEffect(() => {
    if (!patientId) return;
    let active = true;
    supabase.from('profiles').select('id,date_of_birth').eq('id', patientId).maybeSingle()
      .then(({ data }) => {
        if (active) setPatient(data ?? null);
      });
    return () => {
      active = false;
    };
  }, [patientId]);

  // Pre-fill from the latest recorded reading of each measurement
  const defaults = useMemo(() => {
    const latest = (key) => trajectories[key]?.points?.filter((p) => p.value != null).at(-1) ?? null;
    const keys = ['total_cholesterol', 'hdl_cholesterol', 'systolic_bp', 'egfr', 'bmi'];
    const dates = keys.map((key) => latest(key)?.date).filter(Boolean).sort();
    return {
      age: ageFrom(patient?.date_of_birth),
      ...Object.fromEntries(keys.map((key) => [key, latest(key)?.value ?? ''])),
      snapshot_date: (dates.at(-1) ?? new Date().toISOString()).slice(0, 10),
    };
  }, [trajectories, patient?.date_of_birth]);

  async function calculate(inputs) {
    setError('');
    setRunning(true);
    const { data, error: riskError } = await aiRequest(`/ai/risk/${assessment.id}`, { body: inputs });
    setRunning(false);
    if (riskError) {
      setError(riskError);
      return;
    }
    setStored(data.pce);
    setModel(null);
    onSaved?.({ pce: data.pce });
  }

  const prevent = stored?.prevent ?? null;
  const pce = stored && (stored.model || stored.status) ? stored : null;
  const serviceDown = /unavailable|Could not reach/i.test(error);

  return (
    <div className="rounded-lg border p-3" aria-label="10-year risk">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">10-year risk (doctor only)</h3>
          <p className="text-xs text-muted-foreground">
            A separate population estimate. It does not use the screening above, every input is confirmed by you, and it is
            never shown to the patient.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" disabled={running} onClick={() => setModel('prevent')}>
            <Calculator className="h-3.5 w-3.5" aria-hidden />
            {prevent ? 'Recalculate PREVENT' : 'Calculate PREVENT'}
          </Button>
          <Button size="sm" variant="ghost" disabled={running} onClick={() => setModel('pce')}>
            {pce ? 'Recalculate 2013 PCE' : 'Compare 2013 PCE'}
          </Button>
        </div>
      </div>

      {error &&
        (serviceDown ? (
          <div className="mt-2">
            <ServiceUnavailable text={error} />
          </div>
        ) : (
          <p className="mt-2 rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{error}</p>
        ))}

      <div className="mt-3 space-y-3">
        <div className="space-y-2">
          <p className="text-xs font-semibold">PREVENT (2023, base model)</p>
          {prevent ? (
            <>
              <PreventResult result={prevent} />
              <ConfirmedLine result={prevent} />
              <Limitations notes={prevent.limitations} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not calculated yet. <b>Calculate PREVENT</b> opens a form for sex, age, cholesterol, systolic BP, kidney
              function (eGFR), BMI, treatment, diabetes, smoking, known disease and the measurement date.
            </p>
          )}
        </div>

        {pce && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs font-semibold">Legacy 2013 Pooled Cohort Equations</p>
            <PceResult result={pce} />
            <ConfirmedLine result={pce} />
            <Limitations notes={pce.limitations} />
          </div>
        )}
      </div>

      <RiskForm
        model={model ?? 'prevent'}
        open={!!model}
        onOpenChange={(open) => !open && setModel(null)}
        defaults={defaults}
        onSubmit={calculate}
        running={running}
      />
    </div>
  );
}
