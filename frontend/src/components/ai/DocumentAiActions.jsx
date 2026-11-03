import { useState } from 'react';
import { Activity, AlertTriangle, FileText, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { aiRequest } from '../../lib/aiClient';
import { cn } from '../../lib/utils';
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input } from '../ui';
import { AIBadge, EmptyState, Spinner } from '../medis';
import EcgResult from './EcgResult';

const LAB_CATEGORIES = ['blood_report', 'lipid_profile', 'hba1c'];

const COLUMN_LABEL = {
  total_cholesterol: 'Total cholesterol',
  ldl_cholesterol: 'LDL',
  hdl_cholesterol: 'HDL',
  triglycerides: 'Triglycerides',
  fasting_glucose: 'Fasting glucose',
  hba1c: 'HbA1c',
  serum_creatinine: 'Creatinine',
  egfr: 'eGFR',
  systolic_bp: 'Systolic BP',
  diastolic_bp: 'Diastolic BP',
  bmi: 'BMI',
};

/**
 * AI actions under a stored document:
 *  - ECG documents: "Analyse ECG (AI)" (saved to ecg_analyses).
 *  - Lab reports, when onApplyLabs is given (an editable visit):
 *    "Extract values (AI)" opens a review dialog. Extracted values start
 *    unticked; only the ones the doctor checks and ticks are applied.
 */
export default function DocumentAiActions({ doc, consultationId, onApplyLabs }) {
  const [busy, setBusy] = useState(false);
  const [ecg, setEcg] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState('');
  const [rows, setRows] = useState([]);

  const canEcg = doc.category === 'ecg';
  const canExtract = !!onApplyLabs && LAB_CATEGORIES.includes(doc.category);
  if (!canEcg && !canExtract) return null;

  async function analyseEcg() {
    setBusy(true);
    const query = consultationId ? `?consultation_id=${consultationId}` : '';
    const { data, error: ecgError } = await aiRequest(`/ai/ecg/document/${doc.id}${query}`);
    setBusy(false);
    if (ecgError) toast.error(ecgError);
    else {
      setEcg(data);
      toast.success('ECG analysis ready');
    }
  }

  async function extract() {
    setDialogOpen(true);
    setExtractError('');
    setRows([]);
    setExtracting(true);
    const { data, error } = await aiRequest(`/ai/extract-report/${doc.id}`);
    setExtracting(false);
    if (error) setExtractError(error);
    else setRows(data.fields.map((f) => ({ ...f, checked: false })));
  }

  function updateRow(i, patch) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  const selected = rows.filter((r) => r.checked && r.value !== '');

  function apply() {
    onApplyLabs(Object.fromEntries(selected.map((r) => [r.column, r.value])));
    setDialogOpen(false);
    toast.success(`${selected.length} value${selected.length === 1 ? '' : 's'} applied — save the draft to keep them`);
  }

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {canExtract && (
          <Button size="sm" variant="outline" className="border-ai/30 text-ai hover:bg-ai-soft" onClick={extract}>
            <Sparkles className="h-3.5 w-3.5" />
            Extract values (AI)
          </Button>
        )}
        {canEcg && (
          <Button size="sm" variant="outline" className="border-ai/30 text-ai hover:bg-ai-soft" disabled={busy} onClick={analyseEcg}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
            {ecg ? 'Re-run ECG (AI)' : 'Analyse ECG (AI)'}
          </Button>
        )}
      </div>

      {ecg && (
        <div className="rounded-lg border p-3">
          <EcgResult
            status={ecg.analysis.status}
            classification={ecg.analysis.classification}
            result={ecg.result}
            fileName={doc.file_name}
            createdAt={ecg.analysis.created_at}
          />
        </div>
      )}

      {canExtract && (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-4xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                Extract values from report <AIBadge />
              </DialogTitle>
              <DialogDescription>{doc.file_name}</DialogDescription>
            </DialogHeader>
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              Values read automatically from the report. Check each value against the document before applying.
            </div>
            <div className="grid gap-4 md:grid-cols-[180px_1fr]">
              <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border bg-muted/50 p-3 text-center text-xs text-muted-foreground">
                <FileText className="h-10 w-10 text-primary" />
                {doc.file_name}
              </div>
              <div className="overflow-x-auto">
                {extracting ? (
                  <Spinner text="Reading the document… this can take about 10 seconds." />
                ) : extractError ? (
                  <p className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{extractError}</p>
                ) : rows.length === 0 ? (
                  <EmptyState text="No lab values recognised in this document." />
                ) : (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="p-1.5">
                          <span className="sr-only">Select</span>
                        </th>
                        <th className="p-1.5">Test</th>
                        <th className="p-1.5">Value</th>
                        <th className="p-1.5">Unit</th>
                        <th className="p-1.5">Source text</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={r.column} className={cn('border-t', r.checked && 'bg-primary-soft/40')}>
                          <td className="p-1.5">
                            <Checkbox checked={r.checked} aria-label={`Use ${COLUMN_LABEL[r.column] ?? r.column}`} onCheckedChange={(v) => updateRow(i, { checked: !!v })} />
                          </td>
                          <td className="p-1.5 font-medium">{COLUMN_LABEL[r.column] ?? r.column}</td>
                          <td className="p-1.5">
                            <Input
                              type="number"
                              step="0.1"
                              className="h-8 w-24"
                              value={r.value}
                              onChange={(e) => updateRow(i, { value: e.target.value === '' ? '' : Number(e.target.value) })}
                              aria-label={`${COLUMN_LABEL[r.column] ?? r.column} value`}
                            />
                          </td>
                          <td className="p-1.5 text-muted-foreground">{r.unit}</td>
                          <td className="p-1.5 font-mono text-[11px] text-muted-foreground">{r.source_text}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button disabled={!selected.length} onClick={apply}>
                Apply selected to this visit ({selected.length})
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
