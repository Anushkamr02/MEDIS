import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardList, Copy, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { aiRequest } from '../../lib/aiClient';
import { formatDateTime } from '../../lib/format';
import { Button } from '../ui';

const GEMINI_FORMAT = 'gemini-summary-v1'; // backend llm.SUMMARY_FORMAT

function UnverifiedNote({ numbers }) {
  if (!numbers?.length) return null;
  return (
    <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">
      Check before relying on it: {numbers.join(', ')} could not be traced to the record.
    </p>
  );
}

/**
 * Brief clinical overview with the major recorded findings as bullet points.
 * Gemini writes a doctor version and a patient draft; if Gemini fails the
 * rule-based summary is shown with a note. The patient draft is never shown to
 * the patient: it is only the starting text for a doctor-published summary.
 */
export default function AiSummary({ patientId, assessment, onSaved, footer }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const requested = useRef(null);
  const summary = assessment?.ai_summary;
  const gemini = summary?.format === GEMINI_FORMAT;
  const paragraph = gemini || summary?.format === 'clinical-highlights-v1' ? summary.overview : '';
  const keyPoints = paragraph ? (gemini ? (summary.changes ?? []).map((c) => c.text) : summary.key_points ?? []) : [];
  const draft = assessment?.patient_draft ?? summary?.patient_draft; // stored once v14 locks assessments
  const canGenerate = !!patientId && !assessment?.preview;
  const assessmentId = assessment?.id ?? null;

  const generate = useCallback(async () => {
    setError('');
    setRunning(true);
    try {
      const { data, error: summaryError } = await aiRequest(`/ai/summary/${patientId}`, {
        body: { assessment_id: assessmentId },
      });
      if (summaryError) setError(summaryError);
      else onSaved(data);
    } catch {
      setError('Could not refresh the clinical summary. Please try again.');
    } finally {
      setRunning(false);
    }
  }, [patientId, assessmentId, onSaved]);

  // Generate once per assessment; a stored summary is reused (free Gemini quota) until Refresh.
  const stored = !!summary;
  useEffect(() => {
    const key = `${patientId}:${assessmentId ?? 'records'}`;
    if (!canGenerate || stored || requested.current === key) return;
    requested.current = key;
    generate();
  }, [canGenerate, stored, patientId, assessmentId, generate]);

  async function copy() {
    try {
      await navigator.clipboard.writeText([paragraph, ...keyPoints.map((point) => `- ${point}`)].join('\n'));
      toast.success('Summary copied');
    } catch {
      toast.error('Could not copy the summary.');
    }
  }

  return (
    <section aria-label="Patient record summary" aria-busy={running}
      className="rounded-xl border border-primary/15 bg-card p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground sm:text-base">
          <ClipboardList className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          Patient record summary
        </h3>
        <div className="flex items-center gap-1">
          {canGenerate && <Button type="button" size="sm" variant="ghost" onClick={generate} disabled={running} aria-label="Refresh summary">
            <RefreshCw className={`h-3.5 w-3.5 ${running ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>}
          {paragraph && <Button type="button" size="sm" variant="ghost" onClick={copy} disabled={running} aria-label="Copy summary">
            <Copy className="h-3.5 w-3.5" />
          </Button>}
        </div>
      </div>
      <div className="mt-3" aria-live="polite">
        {running && !paragraph ? (
          <div className="space-y-2" role="status" aria-label="Preparing clinical summary">
            {[100, 95, 75].map((width) => <div key={width} className="h-3 animate-pulse rounded bg-muted" style={{ width: `${width}%` }} />)}
          </div>
        ) : paragraph ? (
          <div className="space-y-3">
            <p className="max-w-prose break-words text-sm leading-7 text-foreground/90 sm:max-w-none">{paragraph}</p>
            {keyPoints.length > 0 && (
              <ul aria-label="Key clinical findings" className="list-disc space-y-2 pl-5 text-sm leading-6 text-foreground/90 marker:text-primary">
                {keyPoints.map((point) => <li key={point} className="break-words pl-1">{point}</li>)}
              </ul>
            )}
            {gemini && [['Review points', summary.review_points], ['Data gaps', summary.data_gaps]].map(([title, items]) => items?.length > 0 && (
              <div key={title}>
                <h4 className="text-xs font-semibold text-muted-foreground">{title}</h4>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{items.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
            ))}
            <UnverifiedNote numbers={summary.unverified_numbers} />
            {summary.fallback_reason && (
              <p className="text-xs text-muted-foreground">Written from the record without Gemini ({summary.fallback_reason}). Press Refresh to try Gemini again.</p>
            )}
            {gemini && (
              <div aria-label="Patient draft" role="group" className="rounded-lg border border-dashed p-3">
                <h4 className="text-xs font-semibold">Patient draft (not visible to the patient)</h4>
                {draft ? (
                  <div className="mt-1 space-y-1 text-sm">
                    <p className="font-medium">{draft.headline}</p>
                    <ul className="list-disc space-y-0.5 pl-5">{draft.points.map((p) => <li key={p}>{p}</li>)}</ul>
                    <p>{draft.next_step}</p>
                    <UnverifiedNote numbers={draft.unverified_numbers} />
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">No patient draft yet. Press Refresh to write one.</p>
                )}
              </div>
            )}
          </div>
        ) : !error ? (
          <p className="text-sm leading-6 text-muted-foreground">
            {canGenerate ? 'Preparing a summary of the available records.' : 'Save the consultation to summarize its recorded findings.'}
          </p>
        ) : null}
        {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
        <span className="text-xs text-muted-foreground">
          Based on saved clinical records{assessment?.summary_created_at ? ` - Updated ${formatDateTime(assessment.summary_created_at)}` : ''}
        </span>
        {footer}
      </div>
    </section>
  );
}
