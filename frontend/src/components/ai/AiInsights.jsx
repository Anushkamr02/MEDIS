import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, ChevronDown, HeartPulse, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';
import { aiRequest } from '../../lib/aiClient';
import { formatDate, formatDateTime } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Button } from '../ui';
import { AIBadge, AIDisclaimer, EmptyState, PriorityPill, ServiceUnavailable, Spinner } from '../medis';
import { METRIC_INFO, TrendCharts } from './TrendChart';
import PceForm from './PceForm';
import EcgResult from './EcgResult';
import AiSummary from './AiSummary';
import DigitalEcgUpload from './DigitalEcgUpload';
import ShareAssessment from './ShareAssessment';

function Flags({ flags, chip }) {
  const [open, setOpen] = useState(null);
  return (
    <div className="rounded-lg border p-3">
      <h3 className="mb-2 text-sm font-semibold">Findings to review</h3>
      {flags.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing to review.</p>
      ) : (
        <ul className="divide-y">
          {flags.map((f, i) => {
            const urgent = f.severity === 'URGENT_REVIEW';
            const evidence = (f.evidence ?? []).filter((e) => e?.date || e?.visit_id);
            return (
              <li key={i} className="py-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle className={cn('mt-0.5 h-4 w-4 shrink-0', urgent ? 'text-destructive' : 'text-warning')} aria-label={urgent ? 'critical' : 'needs review'} />
                  <div className="flex-1">
                    <p className="text-sm font-medium">
                      {f.metric && `${METRIC_INFO[f.metric]?.label ?? f.metric}: `}
                      {f.message} <span className="text-xs font-normal text-muted-foreground">· {urgent ? 'critical' : 'review'}</span>
                    </p>
                    {evidence.length > 0 && (
                      <>
                        <button
                          className="mt-0.5 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          onClick={() => setOpen(open === i ? null : i)}
                          aria-expanded={open === i}
                        >
                          Show evidence <ChevronDown className={cn('h-3 w-3 transition-transform', open === i && 'rotate-180')} />
                        </button>
                        {open === i && (
                          <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                            <p>
                              {evidence
                                .filter((e) => e.date)
                                .map((e) => `${formatDate(e.date)}${e.value !== undefined ? ` (${e.value})` : ''}`)
                                .join(' → ')}
                            </p>
                            <div className="flex flex-wrap gap-1">{[...new Set(evidence.map((e) => e.visit_id).filter(Boolean))].map(chip)}</div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Longitudinal CAD screening from the teammate's engine (via the AI
 * service): review priority, AI summary, trend graphs, findings, optional
 * legacy PCE and recent ECG analyses. Shown on the patient profile and,
 * compact, on the consultation page, where getDraftValues lets the doctor
 * preview how the unsaved visit changes the trend (previews are not saved).
 */
export default function AiInsights({ patientId, patientAge, consultationId, getDraftValues, compact = false, onOpenVisit }) {
  const [assessment, setAssessment] = useState(null); // cad_assessments row (+ preview flag)
  const [ecgRows, setEcgRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [full, setFull] = useState(!compact);
  const [pceOpen, setPceOpen] = useState(false);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    const [{ data: rows, error: loadError }, { data: ecgs }] = await Promise.all([
      supabase.from('cad_assessments').select('*').eq('patient_id', patientId).order('created_at', { ascending: false }).limit(1),
      supabase.from('ecg_analyses').select('*').eq('patient_id', patientId).order('created_at', { ascending: false }).limit(3),
    ]);
    if (loadError) setError(loadError.message);
    setAssessment(rows?.[0] ?? null);
    setEcgRows(ecgs ?? []);
    setLoading(false);
  }, [patientId]);

  useEffect(() => {
    load();
  }, [load]);

  async function run(pceInputs) {
    setError('');
    setRunning(true);
    const draft = getDraftValues?.() ?? null;
    const { data, error: runError } = await aiRequest(`/ai/longitudinal/${patientId}`, {
      body: {
        consultation_id: consultationId ?? null,
        draft_values: draft,
        save: !draft,
        pce_inputs: pceInputs ?? null,
      },
    });
    setRunning(false);
    if (runError) {
      setError(runError);
      return;
    }
    setAssessment({
      id: data.assessment_id,
      report: data.report,
      created_at: new Date().toISOString(),
      preview: !!draft,
      ai_summary: null,
    });
    if (pceInputs) setPceOpen(false);
  }

  const report = assessment?.report;
  const trajectories = report?.metric_trajectories ?? {};
  const pce = report?.absolute_risk;
  const hospitals = new Set(
    Object.values(trajectories).flatMap((m) => (m.points ?? []).flatMap((p) => (p.evidence ?? []).map((e) => e.hospital).filter(Boolean)))
  ).size;
  const latestEcg = ecgRows[0];

  const pceDefaults = {
    age: patientAge ?? '',
    total_cholesterol: trajectories.total_cholesterol?.latest ?? '',
    hdl_cholesterol: trajectories.hdl_cholesterol?.latest ?? '',
    systolic_bp: trajectories.systolic_bp?.latest ?? '',
    snapshot_date: trajectories.total_cholesterol?.points?.at(-1)?.date ?? '',
  };

  const chip = (id) => (
    <button
      key={id}
      type="button"
      onClick={() => onOpenVisit?.(id)}
      className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] hover:border-primary hover:text-primary"
    >
      {id}
    </button>
  );

  const serviceDown = /unavailable|Could not reach/i.test(error);

  return (
    <section className={cn('rounded-xl border border-ai/20 bg-card shadow-card', compact ? 'p-4' : 'p-4 sm:p-5')} aria-label="AI insights">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Sparkles className="h-4 w-4 text-ai" />
          {compact ? 'AI CAD screening' : 'AI Insights'} <AIBadge />
        </h2>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => run()} disabled={running || !patientId}>
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {compact ? 'Run AI screening' : report ? 'Refresh analysis' : 'Run analysis'}
          </Button>
          {report && (
            <Button size="sm" variant="outline" onClick={() => setFull((f) => !f)}>
              {full ? 'Hide full report' : 'View full report'}
            </Button>
          )}
        </div>
      </div>
      {compact && <p className="mt-1 text-xs text-muted-foreground">Includes the values of this visit as you type them (a preview is not saved).</p>}

      <div className="mt-3 space-y-4">
        {error &&
          (serviceDown ? (
            <ServiceUnavailable text={error} />
          ) : (
            <p className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{error}</p>
          ))}
        {loading ? (
          <Spinner text="Loading AI analysis..." />
        ) : running ? (
          <Spinner text="Analysing visits…" />
        ) : !report ? (
          <EmptyState text="No assessment yet. Run an analysis to see how BP, lipids and glucose change across this patient's finalized visits at every hospital." />
        ) : (
          <>
            <div className="rounded-lg bg-muted/50 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <PriorityPill value={report.review_priority ?? 'INSUFFICIENT_DATA'} size="lg" />
                <span className="text-sm">{report.overall_assessment}</span>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Based on <b>{report.coverage?.valid_visits ?? 0} visits</b>
                {hospitals > 0 && (
                  <>
                    {' '}
                    at{' '}
                    <b>
                      {hospitals} hospital{hospitals === 1 ? '' : 's'}
                    </b>
                  </>
                )}{' '}
                · as of {formatDate(report.as_of)} · Analysed {formatDateTime(assessment.created_at)} · {report.engine_version}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {assessment.preview ? 'Preview including this unsaved visit (not saved). ' : ''}The review priority is a screening label, not a probability.
              </p>
            </div>
            {full && (
              <>
                <AiSummary
                  patientId={patientId}
                  assessment={assessment}
                  onSaved={(saved) => setAssessment((prev) => ({ ...prev, ...saved }))}
                  onOpenVisit={onOpenVisit}
                  footer={
                    !compact && (
                      <ShareAssessment
                        key={assessment.id ?? 'preview'}
                        assessment={assessment}
                        onChange={(saved) => setAssessment((prev) => ({ ...prev, ...saved }))}
                      />
                    )
                  }
                />
                <div className="rounded-lg border p-3">
                  <h3 className="mb-2 text-sm font-semibold">Trends</h3>
                  <TrendCharts trajectories={trajectories} compact={compact} />
                </div>
                <Flags flags={report.clinical_flags ?? []} chip={chip} />
                {!compact && report.recommendations?.length > 0 && (
                  <div className="rounded-lg border p-3">
                    <h3 className="mb-2 text-sm font-semibold">Suggested review points</h3>
                    <ul className="list-disc space-y-1 pl-5 text-sm">
                      {report.recommendations.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {(report.observations?.length > 0 || report.data_quality?.length > 0) && (
                  <details className="rounded-lg border p-3 text-xs text-muted-foreground">
                    <summary className="cursor-pointer font-medium">
                      Observations and data quality notes ({(report.observations?.length ?? 0) + (report.data_quality?.length ?? 0)})
                    </summary>
                    <ul className="mt-2 list-disc pl-5">
                      {report.observations?.map((o) => (
                        <li key={o}>{o}</li>
                      ))}
                      {report.data_quality?.map((q, i) => (
                        <li key={`q${i}`}>
                          {[q.metric && (METRIC_INFO[q.metric]?.label ?? q.metric), q.visit_id, q.date, q.reason?.replaceAll('_', ' ')].filter(Boolean).join(' · ')}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
            <AIDisclaimer meta={`Generated ${formatDateTime(assessment.created_at)} from ${report.coverage?.valid_visits ?? 0} visits`} />
          </>
        )}

        {(full || compact || !report) && (
          <div className={cn('grid gap-4', !compact && 'lg:grid-cols-2')}>
            <div className="rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold">10-year ASCVD risk (Pooled Cohort Equations, 2013)</h3>
                <Button size="sm" variant="outline" onClick={() => setPceOpen(true)} disabled={running}>
                  <HeartPulse className="h-3.5 w-3.5" />
                  {pce?.status === 'CALCULATED' ? 'Recalculate' : 'Calculate'}
                </Button>
              </div>
              {pce?.status === 'CALCULATED' ? (
                <div className="mt-2">
                  <p className="font-display text-3xl font-bold">{pce.risk_percent}%</p>
                  <p className="text-sm font-medium">{pce.category}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Inputs confirmed by the doctor · values from {formatDate(pce.inputs?.snapshot_date)} · Legacy 2013 equation; not calibrated for Indian
                    populations.
                  </p>
                </div>
              ) : pce && pce.status !== 'NOT_CALCULATED' ? (
                <p className="mt-2 rounded-md bg-muted px-3 py-2 text-sm font-medium">{pce.reason}</p>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">Not calculated. Each input must be confirmed by the doctor.</p>
              )}
              <PceForm open={pceOpen} onOpenChange={setPceOpen} defaults={pceDefaults} running={running} onSubmit={run} />
            </div>
            <div className="space-y-3 rounded-lg border p-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Activity className="h-4 w-4 text-ai" />
                {compact ? 'Digital ECG recording' : 'Latest ECG analysis'}
              </h3>
              {!compact &&
                (latestEcg ? (
                  <EcgResult
                    status={latestEcg.status}
                    classification={latestEcg.classification}
                    result={latestEcg.result}
                    fileName={latestEcg.file_name}
                    createdAt={latestEcg.created_at}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No ECG analysed yet. Use <b>Analyse ECG (AI)</b> on an ECG in Medical documents below, or upload a digital recording.
                  </p>
                ))}
              {!compact && ecgRows.length > 1 && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer font-medium">Earlier ECG analyses ({ecgRows.length - 1})</summary>
                  <div className="mt-2 space-y-3">
                    {ecgRows.slice(1).map((r) => (
                      <div key={r.id} className="rounded-md border p-2">
                        <EcgResult status={r.status} classification={r.classification} result={r.result} fileName={r.file_name} createdAt={r.created_at} />
                      </div>
                    ))}
                  </div>
                </details>
              )}
              <div className={cn(!compact && 'border-t pt-3')}>
                {!compact && <p className="mb-2 text-xs font-medium">Upload a digital ECG recording</p>}
                <DigitalEcgUpload patientId={patientId} consultationId={consultationId} onSaved={load} />
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
