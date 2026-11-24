import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../../lib/supabaseClient';
import { isMissingTable } from '../../lib/dashboardCompatibility';
import { REVIEW_OUTCOMES, REVIEW_STATUS, REVIEWED_EVENT } from '../../lib/findingReview';
import { formatDateTime } from '../../lib/format';
import { Button, Label, SimpleSelect, Textarea } from '../ui';
import { DetailsDialog, TrendPill } from '../medis';

/**
 * Review status of one significant finding (a cad_assessments or an
 * ecg_analyses row) and the dialog that records a review (migration v13).
 * Pass `review` when the parent already loaded it; otherwise it loads its own.
 * Hidden on a database without v13, and when there is nothing to review.
 */
export default function FindingReview({ patientId, assessmentId, ecgAnalysisId, findings, evidence = [], review: preloaded }) {
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState(undefined); // undefined while loading
  const [available, setAvailable] = useState(true);
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const targetId = assessmentId ?? ecgAnalysisId;
  const review = preloaded !== undefined ? preloaded : loaded;

  const load = useCallback(async () => {
    if (!targetId || preloaded !== undefined) return;
    const { data, error } = await supabase
      .from('finding_reviews')
      .select('id, outcome, note, reviewed_at, reviewer:reviewed_by(full_name)')
      .eq(assessmentId ? 'assessment_id' : 'ecg_analysis_id', targetId)
      .order('reviewed_at', { ascending: false })
      .limit(1);
    if (isMissingTable(error)) setAvailable(false);
    else setLoaded(data?.[0] ?? null);
  }, [targetId, assessmentId, preloaded]);

  useEffect(() => {
    load();
    const onReviewed = (e) => e.detail === targetId && load();
    window.addEventListener(REVIEWED_EVENT, onReviewed);
    return () => window.removeEventListener(REVIEWED_EVENT, onReviewed);
  }, [load, targetId]);

  if (!available || review === undefined || (!review && !findings.length)) return null;

  async function save() {
    setSaving(true);
    const { error } = await supabase.rpc('record_finding_review', {
      p_assessment_id: assessmentId ?? null,
      p_ecg_analysis_id: ecgAnalysisId ?? null,
      p_outcome: outcome,
      p_note: note,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success('Review recorded');
    setOpen(false);
    window.dispatchEvent(new CustomEvent(REVIEWED_EVENT, { detail: targetId }));
    if (outcome === 'follow_up_booked') {
      navigate(`/doctor/appointments?${new URLSearchParams({ patient: patientId, reason: `Follow-up: ${findings[0] ?? 'review of findings'}` })}`);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {review ? (
        <>
          <TrendPill label={`${REVIEW_STATUS.reviewed}: ${REVIEW_OUTCOMES[review.outcome] ?? review.outcome}`} cls="better" />
          <span className="text-muted-foreground">
            by Dr. {review.reviewer?.full_name ?? '—'} · {formatDateTime(review.reviewed_at)}
            {review.note && ` · ${review.note}`}
          </span>
        </>
      ) : (
        <>
          <span className="rounded-full border border-warning/30 bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning">{REVIEW_STATUS.pending}</span>
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Review
          </Button>
        </>
      )}
      <DetailsDialog
        open={open}
        onOpenChange={setOpen}
        title="Review finding"
        description="Doctor only. Recording a review does not notify the patient."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!outcome || saving} onClick={save}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Record review
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          <div>
            <h3 className="mb-1 font-semibold">Finding</h3>
            <ul className="list-disc space-y-0.5 pl-5">
              {findings.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
          {evidence.length > 0 && (
            <div>
              <h3 className="mb-1 font-semibold">Evidence</h3>
              <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                {evidence.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="review-outcome">Outcome</Label>
            <SimpleSelect id="review-outcome" value={outcome} onChange={setOutcome} placeholder="Choose an outcome" options={Object.entries(REVIEW_OUTCOMES)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="review-note">Note (optional)</Label>
            <Textarea id="review-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
          </div>
          {outcome === 'follow_up_booked' && <p className="text-xs text-muted-foreground">Appointments opens next, with the booking form filled in.</p>}
        </div>
      </DetailsDialog>
    </div>
  );
}
