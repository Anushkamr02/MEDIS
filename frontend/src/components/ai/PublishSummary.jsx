import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../../lib/supabaseClient';
import { isMissingTable } from '../../lib/dashboardCompatibility';
import { assessmentFindings, REVIEWED_EVENT } from '../../lib/findingReview';
import { copyMetrics, PATIENT_METRICS, remainingUnverified, SUMMARY_STATUS } from '../../lib/healthSummary';
import { formatDate } from '../../lib/format';
import {
  Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, SimpleSelect, Textarea,
} from '../ui';

/**
 * Publishes a doctor-reviewed summary to the patient (migration v14). The text
 * starts from the Gemini patient draft; the patient never sees the AI output
 * itself (priority, flags, risk %, ECG, trend). Publishing is blocked until any
 * significant finding of the assessment is reviewed and no untraceable number
 * remains. A published summary can be withdrawn; a new version replaces it.
 */
export default function PublishSummary({ patientId, assessment }) {
  const [current, setCurrent] = useState(undefined); // undefined while loading
  const [available, setAvailable] = useState(true);
  const [review, setReview] = useState(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ status: '', headline: '', points: '', nextStep: '', metrics: [], confirmed: false });
  const [busy, setBusy] = useState(false);
  const assessmentId = assessment?.id;
  const draft = assessment?.patient_draft ?? assessment?.ai_summary?.patient_draft;

  const load = useCallback(async () => {
    if (!patientId || !assessmentId) return;
    const [summaries, reviews] = await Promise.all([
      supabase.from('patient_health_summaries').select('id, status_message, published_at')
        .eq('patient_id', patientId).is('withdrawn_at', null).order('published_at', { ascending: false }).limit(1),
      supabase.from('finding_reviews').select('id').eq('assessment_id', assessmentId).limit(1),
    ]);
    if (isMissingTable(summaries.error)) return setAvailable(false);
    setCurrent(summaries.data?.[0] ?? null);
    setReview(reviews.data?.[0] ?? null);
  }, [patientId, assessmentId]);

  useEffect(() => {
    load();
    const onReviewed = (e) => e.detail === assessmentId && load();
    window.addEventListener(REVIEWED_EVENT, onReviewed);
    return () => window.removeEventListener(REVIEWED_EVENT, onReviewed);
  }, [load, assessmentId]);

  // Previews (unsaved consultation values) can't be published
  if (!assessmentId || assessment.preview) return null;
  if (!available) return <span className="text-xs text-muted-foreground">Publishing to the patient needs database migration v14.</span>;
  if (current === undefined) return null;

  const trajectories = assessment.report?.metric_trajectories ?? {};
  const metricKeys = Object.keys(PATIENT_METRICS).filter((k) => trajectories[k]?.points?.length);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const text = [form.headline, form.points, form.nextStep].join('\n');
  const unverified = remainingUnverified(text, draft?.unverified_numbers);
  const needsReview = assessmentFindings(assessment).length > 0 && !review;
  const blockers = [
    needsReview && 'Review the significant findings of this assessment first (Review button above).',
    unverified.length > 0 && `Correct or remove ${unverified.join(', ')}: these numbers could not be traced to the record.`,
  ].filter(Boolean);
  const ready = form.status && form.headline.trim() && form.confirmed && !blockers.length;

  function start() {
    set({
      status: '', confirmed: false, metrics: [],
      headline: draft?.headline ?? '', points: (draft?.points ?? []).join('\n'), nextStep: draft?.next_step ?? '',
    });
    setOpen(true);
  }

  async function publish() {
    setBusy(true);
    const { error } = await supabase.rpc('publish_health_summary', {
      p_patient_id: patientId,
      p_assessment_id: assessmentId,
      p_status_message: form.status,
      p_headline: form.headline,
      p_points: form.points.split('\n').map((p) => p.trim()).filter(Boolean),
      p_next_step: form.nextStep,
      p_shown_metrics: copyMetrics(trajectories, form.metrics),
    });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success('Summary published to the patient');
    setOpen(false);
    load();
  }

  async function withdraw() {
    setBusy(true);
    const { error } = await supabase.rpc('withdraw_health_summary', { p_summary_id: current.id });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success('Summary withdrawn');
    load();
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {current && (
        <>
          <span className="font-medium">Published to patient · {formatDate(current.published_at)}</span>
          <Button size="sm" variant="ghost" onClick={withdraw} disabled={busy}>
            Withdraw
          </Button>
        </>
      )}
      <Button size="sm" variant="outline" onClick={start}>
        {current ? 'Publish new version' : 'Publish summary to patient'}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Publish a health summary</DialogTitle>
            <DialogDescription>
              The patient sees only this text, the status you choose and the measured values you tick. The review priority, flags, risk
              estimates, ECG results and the AI summary stay doctor-only.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="space-y-1">
              <Label htmlFor="summary-status">Status message</Label>
              <SimpleSelect id="summary-status" value={form.status} onChange={(status) => set({ status })} options={Object.entries(SUMMARY_STATUS)} placeholder="Choose a status" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="summary-headline">Headline</Label>
              <Input id="summary-headline" maxLength={300} value={form.headline} onChange={(e) => set({ headline: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="summary-points">Points (one per line, plain words)</Label>
              <Textarea id="summary-points" rows={4} value={form.points} onChange={(e) => set({ points: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="summary-next">Next step</Label>
              <Input id="summary-next" value={form.nextStep} onChange={(e) => set({ nextStep: e.target.value })} />
            </div>
            {metricKeys.length > 0 && (
              <fieldset className="space-y-1">
                <legend className="text-sm font-medium">Measured values to show</legend>
                {metricKeys.map((k) => (
                  <label key={k} className="flex items-center gap-2">
                    <Checkbox
                      checked={form.metrics.includes(k)}
                      onCheckedChange={(on) => set({ metrics: on ? [...form.metrics, k] : form.metrics.filter((m) => m !== k) })}
                    />
                    {PATIENT_METRICS[k]}
                  </label>
                ))}
              </fieldset>
            )}
            {blockers.length > 0 && (
              <ul role="alert" className="list-disc space-y-0.5 rounded-md bg-warning-soft py-2 pl-8 pr-3 text-xs text-warning">
                {blockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            )}
            <label className="flex items-center gap-2 font-medium">
              <Checkbox checked={form.confirmed} onCheckedChange={(on) => set({ confirmed: on === true })} />
              I have reviewed this summary and it is accurate
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={publish} disabled={!ready || busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
