import { useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../lib/supabaseClient';
import { Button, Input, Label, SimpleSelect } from './ui';

// Must match the family_history.relation check constraint (v1)
const RELATIONS = ['parent', 'sibling', 'grandparent', 'child', 'uncle', 'aunt', 'other'];

/**
 * Doctor adds a past diagnosed condition (type="medical" →
 * patient_medical_history) or a hereditary condition
 * (type="family" → family_history).
 */
export default function HistoryForm({ type, patientId, doctorId, onSaved, onCancel }) {
  const isFamily = type === 'family';
  const [conditionName, setConditionName] = useState('');
  const [relation, setRelation] = useState('parent');
  const [diagnosedAt, setDiagnosedAt] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);

    const { error: insertError } = isFamily
      ? await supabase.from('family_history').insert({
          patient_id: patientId,
          relation,
          condition_name: conditionName.trim(),
          notes: notes.trim() || null,
        })
      : await supabase.from('patient_medical_history').insert({
          patient_id: patientId,
          condition_name: conditionName.trim(),
          diagnosed_at: diagnosedAt || null,
          is_active: isActive,
          notes: notes.trim() || null,
        });
    setSaving(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    supabase.from('audit_logs').insert({
      user_id: doctorId,
      action: isFamily ? 'added_family_history' : 'added_medical_history',
      target_id: patientId,
      target_type: 'patient',
      metadata: { condition_name: conditionName.trim() },
    });

    toast.success('Added to record');
    onSaved?.();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1 space-y-1">
          <Label htmlFor="hist-condition" className="text-xs">
            {isFamily ? 'Condition' : 'Medical history entry'}
          </Label>
          <Input
            id="hist-condition"
            required
            placeholder={isFamily ? 'e.g. Coronary artery disease' : 'e.g. Type 2 diabetes'}
            value={conditionName}
            onChange={(e) => setConditionName(e.target.value)}
          />
        </div>
        {isFamily ? (
          <div className="w-40 space-y-1">
            <Label className="text-xs">Relation</Label>
            <SimpleSelect value={relation} onChange={setRelation} options={RELATIONS.map((r) => [r, r.charAt(0).toUpperCase() + r.slice(1)])} />
          </div>
        ) : (
          <>
            <div className="w-40 space-y-1">
              <Label htmlFor="hist-date" className="text-xs">
                Diagnosed on
              </Label>
              <Input id="hist-date" type="date" value={diagnosedAt} onChange={(e) => setDiagnosedAt(e.target.value)} />
            </div>
            <div className="w-32 space-y-1">
              <Label className="text-xs">Status</Label>
              <SimpleSelect
                value={isActive ? 'active' : 'resolved'}
                onChange={(v) => setIsActive(v === 'active')}
                options={[
                  ['active', 'Active'],
                  ['resolved', 'Resolved'],
                ]}
              />
            </div>
          </>
        )}
        <div className="min-w-48 flex-1 space-y-1">
          <Label htmlFor="hist-notes" className="text-xs">
            Notes
          </Label>
          <Input
            id="hist-notes"
            placeholder={isFamily ? 'e.g. Father, MI at age 52' : 'e.g. On metformin since 2023'}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
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
