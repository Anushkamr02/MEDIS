import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../lib/supabaseClient';
import { Button, Input, SimpleSelect, Textarea } from './ui';
import { EmptyState } from './medis';
import { PrescriptionCard } from './ai/PrescriptionPdfButton';

const TIMING_OPTIONS = ['After food', 'Before food', 'With food', 'Empty stomach', 'At bedtime', 'As needed'];

const FREQUENCY_SUGGESTIONS = [
  'Once daily',
  'Twice daily',
  'Three times daily',
  '1-0-1',
  '1-0-0',
  '0-0-1',
  '1-1-1',
  'SOS',
];

function emptyRow() {
  return { name: '', dosage: '', frequency: '', duration_days: '', timing: 'After food', notes: '' };
}

/**
 * Lists the prescriptions already issued for one consultation and lets
 * the doctor issue a new one. There is deliberately no edit/delete:
 * prescriptions are never overwritten — to change medication, the
 * doctor issues a new prescription. Inserting one fires the
 * notify_prescription_added trigger, so the patient is notified.
 */
export default function PrescriptionForm({
  consultationId,
  patientId,
  doctorId,
  prescriptions,
  canIssue = true,
  onSaved,
  startOpen = false,
}) {
  const [showForm, setShowForm] = useState(startOpen);
  const [rows, setRows] = useState([emptyRow()]);
  const [instructions, setInstructions] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function updateRow(index, field, value) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, emptyRow()]);
  }

  function removeRow(index) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function resetForm() {
    setRows([emptyRow()]);
    setInstructions('');
    setError('');
    setShowForm(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    const filled = rows.filter((r) => r.name.trim() !== '');
    if (filled.length === 0) {
      setError('Add at least one medicine.');
      return;
    }
    const incomplete = filled.find((r) => !r.dosage.trim() || !r.frequency.trim() || !r.duration_days);
    if (incomplete) {
      setError(`Fill in dosage, frequency and duration for ${incomplete.name}.`);
      return;
    }

    // `duration` stays a display string because the patient dashboard
    // already renders it; `duration_days` keeps the number for later use.
    const medicines = filled.map((r) => ({
      name: r.name.trim(),
      dosage: r.dosage.trim(),
      frequency: r.frequency.trim(),
      duration: `${r.duration_days} days`,
      duration_days: Number(r.duration_days),
      timing: r.timing,
      notes: r.notes.trim() || null,
    }));

    setSaving(true);
    const { error: insertError } = await supabase.from('prescriptions').insert({
      consultation_id: consultationId,
      patient_id: patientId,
      doctor_id: doctorId,
      medicines,
      instructions: instructions.trim() || null,
    });
    setSaving(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    await supabase.from('audit_logs').insert({
      user_id: doctorId,
      action: 'added_prescription',
      target_id: consultationId,
      target_type: 'consultation',
      metadata: { medicine_count: medicines.length },
    });

    resetForm();
    toast.success('Prescription issued');
    onSaved?.();
  }

  return (
    <div className="space-y-2">
      {prescriptions.length === 0 && !showForm && <EmptyState text="No prescriptions issued for this visit." />}
      {prescriptions.map((p) => (
        <PrescriptionCard key={p.id} rx={p} />
      ))}

      {canIssue && !showForm && (
        <Button size="sm" onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4" />
          Write prescription
        </Button>
      )}

      {canIssue && showForm && (
        <form onSubmit={handleSubmit} className="mt-3 space-y-2 rounded-lg border bg-muted/30 p-3">
          <div className="hidden grid-cols-[repeat(6,1fr)_auto] gap-2 px-0.5 text-xs text-muted-foreground sm:grid">
            <span>Medicine</span>
            <span>Dosage</span>
            <span>Frequency</span>
            <span>Days</span>
            <span>Timing</span>
            <span>Notes</span>
            <span className="w-9" />
          </div>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(6,1fr)_auto]">
              <Input aria-label="Medicine" placeholder="e.g. Atorvastatin" value={r.name} onChange={(e) => updateRow(i, 'name', e.target.value)} />
              <Input aria-label="Dosage" placeholder="10 mg" value={r.dosage} onChange={(e) => updateRow(i, 'dosage', e.target.value)} />
              <Input
                aria-label="Frequency"
                placeholder="1-0-1"
                list="rx-frequency-options"
                value={r.frequency}
                onChange={(e) => updateRow(i, 'frequency', e.target.value)}
              />
              <Input
                aria-label="Days"
                type="number"
                min="1"
                max="365"
                placeholder="Days"
                value={r.duration_days}
                onChange={(e) => updateRow(i, 'duration_days', e.target.value)}
              />
              <SimpleSelect ariaLabel="Timing" value={r.timing} onChange={(v) => updateRow(i, 'timing', v)} options={TIMING_OPTIONS} />
              <Input aria-label="Notes" placeholder="Notes" value={r.notes} onChange={(e) => updateRow(i, 'notes', e.target.value)} />
              <Button type="button" variant="ghost" size="icon" aria-label="Remove medicine" onClick={() => removeRow(i)} disabled={rows.length === 1}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <datalist id="rx-frequency-options">
            {FREQUENCY_SUGGESTIONS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <Button type="button" size="sm" variant="outline" onClick={addRow}>
            <Plus className="h-4 w-4" />
            Add medicine
          </Button>
          <Textarea
            placeholder="General instructions, e.g. low-salt diet, walk 30 minutes daily, review lipid profile in 3 months"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? 'Issuing...' : 'Issue prescription'}
            </Button>
            <Button type="button" variant="ghost" onClick={resetForm} disabled={saving}>
              Cancel
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Prescriptions can't be edited after they are issued. To change medication, issue a new one.</p>
        </form>
      )}
    </div>
  );
}
