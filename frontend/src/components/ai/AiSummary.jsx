import { useState } from 'react';
import { AlertTriangle, Copy, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { aiRequest } from '../../lib/aiClient';
import { formatDateTime } from '../../lib/format';
import { Button } from '../ui';

/**
 * AI-written summary of a saved assessment (POST /ai/summary, Gemini). It
 * is written only from the engine's numbers; any number the server could
 * not trace back to the input is listed so the doctor checks it.
 * `footer` is shown next to the actions (the share switch).
 */
export default function AiSummary({ patientId, assessment, onSaved, onOpenVisit, footer }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const summary = assessment?.ai_summary;
  const canGenerate = !!assessment?.id; // previews of unsaved visits aren't stored

  async function generate() {
    setError('');
    setRunning(true);
    const { data, error: summaryError } = await aiRequest(`/ai/summary/${patientId}`, {
      body: { assessment_id: assessment.id },
    });
    setRunning(false);
    if (summaryError) setError(summaryError);
    else onSaved(data);
  }

  function copy() {
    const text = [
      summary.overview,
      ...summary.changes.map((c) => `• ${c.text}`),
      ...summary.review_points.map((p) => `• Review: ${p}`),
      ...summary.data_gaps.map((g) => `• Data gap: ${g}`),
    ].join('\n');
    navigator.clipboard?.writeText(text);
    toast.success('Summary copied');
  }

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

  const heading = (text) => <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{text}</h4>;

  return (
    <div className="rounded-lg border p-3">
      <h3 className="text-sm font-semibold">AI summary</h3>
      {error && <p className="mt-2 rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{error}</p>}
      {running ? (
        <div className="mt-2 space-y-2">
          {[90, 75, 85].map((w) => (
            <div key={w} className="h-3 animate-pulse rounded bg-muted" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : !summary ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {canGenerate
              ? 'Write a plain-language summary of this analysis for review.'
              : 'This is an unsaved preview. Save or finalize the visit and refresh the analysis to summarise it.'}
          </p>
          {canGenerate && (
            <Button size="sm" variant="outline" className="border-ai/30 text-ai hover:bg-ai-soft" onClick={generate}>
              <Sparkles className="h-3.5 w-3.5" />
              Generate summary
            </Button>
          )}
        </div>
      ) : (
        <div className="mt-2 space-y-3 text-sm">
          <div>
            {heading('Overview')}
            <p>{summary.overview}</p>
          </div>
          {summary.changes.length > 0 && (
            <div>
              {heading('What changed')}
              <ul className="list-disc space-y-1 pl-5">
                {summary.changes.map((c, i) => (
                  <li key={i}>
                    {c.text} <span className="ml-1 inline-flex flex-wrap gap-1">{c.visit_ids.map(chip)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {summary.review_points.length > 0 && (
            <div>
              {heading('Points to review')}
              <ul className="list-disc space-y-1 pl-5">
                {summary.review_points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {summary.data_gaps.length > 0 && (
            <div>
              {heading('Data gaps')}
              <ul className="list-disc space-y-1 pl-5">
                {summary.data_gaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </div>
          )}
          {summary.unverified_numbers?.length > 0 && (
            <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              Check these numbers against the trend data; they couldn't be matched to the analysis: {summary.unverified_numbers.join(', ')}
            </p>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-2">
        <p className="text-[11px] text-muted-foreground">
          {summary
            ? `AI-generated from structured visit data · Model: ${assessment.summary_model ?? '—'}${assessment.summary_created_at ? ` · ${formatDateTime(assessment.summary_created_at)}` : ''}`
            : 'The summary is written by an AI model only from the analysis numbers.'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {summary && (
            <>
              <Button size="sm" variant="ghost" onClick={generate} disabled={running}>
                <RefreshCw className="h-3.5 w-3.5" />
                Regenerate
              </Button>
              <Button size="sm" variant="ghost" onClick={copy}>
                <Copy className="h-3.5 w-3.5" />
                Copy
              </Button>
            </>
          )}
          {footer}
        </div>
      </div>
    </div>
  );
}
