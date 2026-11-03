import { useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../lib/supabaseClient';
import { Button, Input, Label } from './ui';

/**
 * Doctor adds an ongoing medication to the patient's current_medications
 * (e.g. a BP tablet the patient takes but never entered). This is the
 * patient's standing medication list, separate from a visit prescription.
 */
export default function MedicationForm({ patientId, doctorId, onSaved, onCancel }) {
  const [medicineName, setMedicineName] = useState('');
  const [conditionName, setConditionName] = useState('');
  const [dosage, setDosage] = useState('');
  const [frequency, setFrequency] = useState('');
  const [startedAt, setStartedAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);

    const { error: insertError } = await supabase.from('current_medications').insert({
      patient_id: patientId,
      medicine_name: medicineName.trim(),
      condition_name: conditionName.trim() || null,
      dosage: dosage.trim() || null,
      frequency: frequency.trim() || null,
      started_at: startedAt || null,
      is_active: true,
    });
    setSaving(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    supabase.from('audit_logs').insert({
      user_id: doctorId,
      action: 'added_medication',
      target_id: patientId,
      target_type: 'patient',
      metadata: { medicine_name: medicineName.trim() },
    });

    toast.success('Added to record');
    onSaved?.();
  }

  const field = (id, label, value, onChange, props = {}) => (
    <div className="min-w-36 flex-1 space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} {...props} />
    </div>
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-wrap items-end gap-2">
        {field('med-name', 'Medicine name', medicineName, setMedicineName, { required: true })}
        {field('med-dosage', 'Dosage', dosage, setDosage, { placeholder: 'e.g. 5 mg' })}
        {field('med-frequency', 'Frequency', frequency, setFrequency, { placeholder: 'e.g. Once daily' })}
        {field('med-condition', 'For condition', conditionName, setConditionName, { placeholder: 'e.g. Hypertension' })}
        {field('med-start', 'Started on', startedAt, setStartedAt, { type: 'date' })}
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving} aria-label="Cancel">
          <X className="h-4 w-4" />
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
