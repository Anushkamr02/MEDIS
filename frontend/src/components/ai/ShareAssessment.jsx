import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabaseClient';
import { formatDate } from '../../lib/format';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Label, Switch, Textarea } from '../ui';

/**
 * "Share with patient" switch on a saved assessment. Turning it on asks
 * for an optional note in plain words; the patient's dashboard then shows
 * their latest shared assessment and they get a notification (migration
 * v6 trigger). Turning it off stops sharing.
 */
export default function ShareAssessment({ assessment, onChange }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(assessment.patient_note ?? '');
  const [busy, setBusy] = useState(false);

  // Previews (unsaved consultation values) can't be shared
  if (!assessment.id || assessment.preview) return null;

  async function update(values) {
    setBusy(true);
    const { data, error: updateError } = await supabase
      .from('cad_assessments')
      .update(values)
      .eq('id', assessment.id)
      .select('shared_with_patient, shared_at, shared_by, patient_note')
      .single();
    setBusy(false);
    if (updateError) {
      toast.error(
        updateError.message.includes('shared_with_patient')
          ? 'Sharing needs database migration v6 (supabase_migration_v6.sql).'
          : updateError.message
      );
      return;
    }
    setOpen(false);
    onChange(data);
    toast.success(data.shared_with_patient ? 'Shared with the patient' : 'Stopped sharing');
  }

  function share() {
    update({
      shared_with_patient: true,
      shared_at: new Date().toISOString(),
      shared_by: user.id,
      patient_note: note.trim() || null,
    });
  }

  return (
    <>
      <label className="flex items-center gap-2 text-xs font-medium">
        <Switch
          checked={!!assessment.shared_with_patient}
          disabled={busy}
          onCheckedChange={(on) => (on ? setOpen(true) : update({ shared_with_patient: false }))}
        />
        {assessment.shared_with_patient ? `Shared with patient · ${formatDate(assessment.shared_at)}` : 'Share with patient'}
      </label>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Share with the patient</DialogTitle>
            <DialogDescription>
              On their dashboard the patient sees the review result in simple words, their trends, the 10-year risk (if calculated) and your
              note, and Ask MEDIS can explain them. Their history PDF also prints this assessment's screening section. ECG results and the AI
              summary stay private.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="share-note">Note for the patient (optional, plain words)</Label>
            <Textarea
              id="share-note"
              rows={3}
              maxLength={500}
              placeholder="e.g. Your cholesterol has gone up this year. Let's discuss diet and medicines at your next visit."
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={share} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Share
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
