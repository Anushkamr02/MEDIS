import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatDate } from '../../lib/format';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from '../ui';

const YES_NO = [
  ['bp_treated', 'On BP treatment?'],
  ['diabetes', 'Diabetes?'],
  ['current_smoker', 'Current smoker?'],
  ['known_ascvd', 'Known heart disease or stroke (ASCVD)?'],
];

function emptyForm(defaults) {
  return {
    model_sex: '',
    cohort: '',
    age: defaults.age ?? '',
    total_cholesterol: defaults.total_cholesterol ?? '',
    hdl_cholesterol: defaults.hdl_cholesterol ?? '',
    systolic_bp: defaults.systolic_bp ?? '',
    snapshot_date: defaults.snapshot_date ?? '',
    bp_treated: null,
    diabetes: null,
    current_smoker: null,
    known_ascvd: null,
  };
}

/**
 * Doctor-confirmed inputs for the legacy 2013 PCE, in a dialog. Nothing is
 * assumed: every yes/no starts unanswered and Calculate stays disabled
 * until all inputs are confirmed (the engine rejects missing values anyway).
 */
export default function PceForm({ open, onOpenChange, defaults, onSubmit, running }) {
  const [form, setForm] = useState(() => emptyForm(defaults));

  // Start from the latest measured values each time the dialog opens
  useEffect(() => {
    if (open) setForm(emptyForm(defaults));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));
  const complete = Object.values(form).every((v) => v !== '' && v !== null);

  function submit() {
    onSubmit({
      ...form,
      age: Number(form.age),
      total_cholesterol: Number(form.total_cholesterol),
      hdl_cholesterol: Number(form.hdl_cholesterol),
      systolic_bp: Number(form.systolic_bp),
    });
  }

  const choice = (key, options, label) => (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map(([v, l]) => (
          <button
            type="button"
            key={String(v)}
            aria-pressed={form[key] === v}
            onClick={() => set(key, v)}
            className={cn('rounded-md border px-3 py-1 text-sm transition-colors', form[key] === v ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}
          >
            {l}
          </button>
        ))}
      </div>
    </fieldset>
  );

  const number = (key, label, props, source) => (
    <div className="space-y-1">
      <Label htmlFor={`pce-${key}`}>{label}</Label>
      <Input id={`pce-${key}`} type="number" value={form[key]} onChange={(e) => set(key, e.target.value)} {...props} />
      {source && <p className="text-[11px] text-muted-foreground">latest reading, {formatDate(source)}</p>}
    </div>
  );

  const age = Number(form.age);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Confirm PCE inputs</DialogTitle>
          <DialogDescription>The system never guesses inputs. Confirm every value before calculating.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {choice('model_sex', [['Male', 'Male'], ['Female', 'Female']], 'Sex (model)')}
          {choice('cohort', [['White', 'White'], ['Black', 'Black'], ['Other', 'Other (not supported)']], 'Cohort (per equation)')}
          {number('age', 'Age (40–79)', { min: 40, max: 79 })}
          {number('total_cholesterol', 'Total cholesterol (mg/dL)', { min: 130, max: 320, step: '0.1' }, defaults.snapshot_date)}
          {number('hdl_cholesterol', 'HDL (mg/dL)', { min: 20, max: 100, step: '0.1' }, defaults.snapshot_date)}
          {number('systolic_bp', 'Systolic BP (mmHg)', { min: 90, max: 200 }, defaults.snapshot_date)}
          {YES_NO.map(([key, label]) => (
            <div key={key}>
              {choice(
                key,
                [
                  [true, 'Yes'],
                  [false, 'No'],
                ],
                label
              )}
            </div>
          ))}
          <div className="space-y-1">
            <Label htmlFor="pce-date">Values measured on</Label>
            <Input id="pce-date" type="date" value={form.snapshot_date} onChange={(e) => set('snapshot_date', e.target.value)} />
          </div>
        </div>
        {age && (age < 40 || age > 79) ? <p className="text-xs text-warning">PCE is validated for ages 40–79; the engine will not calculate outside this range.</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={running}>
            Cancel
          </Button>
          <Button disabled={!complete || running} onClick={submit}>
            {running && <Loader2 className="h-4 w-4 animate-spin" />}
            Calculate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
