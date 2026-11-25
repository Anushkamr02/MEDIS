import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatDate } from '../../lib/format';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from '../ui';

// What each equation needs. PREVENT (2023) has no race/cohort term and adds
// kidney function, BMI and statin use; the legacy 2013 PCE needs a cohort.
export const MODELS = {
  prevent: {
    title: 'PREVENT (2023) inputs',
    numbers: [
      ['age', 'Age (30–79)', { min: 30, max: 79 }],
      ['total_cholesterol', 'Total cholesterol (mg/dL)', { min: 130, max: 320, step: '0.1' }],
      ['hdl_cholesterol', 'HDL (mg/dL)', { min: 20, max: 100, step: '0.1' }],
      ['systolic_bp', 'Systolic BP (mmHg)', { min: 90, max: 200 }],
      ['egfr', 'eGFR (mL/min/1.73m²)', { min: 15, max: 150, step: '0.1' }],
      ['bmi', 'BMI (18.5–39.9, heart failure only)', { min: 18.5, max: 39.9, step: '0.1' }],
    ],
    choices: [
      ['bp_treated', 'On BP treatment?'],
      ['statin', 'On a statin or other lipid-lowering medicine?'],
      ['diabetes', 'Diabetes?'],
      ['current_smoker', 'Current smoker?'],
      ['known_ascvd', 'Known heart disease or stroke (ASCVD)?'],
    ],
    note: 'PREVENT uses no race or ethnicity term. It is validated for ages 30–79 without known cardiovascular disease.',
  },
  pce: {
    title: 'Legacy 2013 PCE inputs',
    numbers: [
      ['age', 'Age (40–79)', { min: 40, max: 79 }],
      ['total_cholesterol', 'Total cholesterol (mg/dL)', { min: 130, max: 320, step: '0.1' }],
      ['hdl_cholesterol', 'HDL (mg/dL)', { min: 20, max: 100, step: '0.1' }],
      ['systolic_bp', 'Systolic BP (mmHg)', { min: 90, max: 200 }],
    ],
    choices: [
      ['bp_treated', 'On BP treatment?'],
      ['diabetes', 'Diabetes?'],
      ['current_smoker', 'Current smoker?'],
      ['known_ascvd', 'Known heart disease or stroke (ASCVD)?'],
    ],
    cohort: true,
    note: 'The 2013 equation requires the cohort it was fitted in. The 2026 guidance prefers PREVENT.',
  },
};

function emptyForm(model, defaults) {
  const spec = MODELS[model];
  return {
    model_sex: '',
    ...(spec.cohort ? { cohort: '' } : {}),
    ...Object.fromEntries(spec.numbers.map(([key]) => [key, defaults[key] ?? ''])),
    snapshot_date: defaults.snapshot_date ?? '',
    ...Object.fromEntries(spec.choices.map(([key]) => [key, null])),
  };
}

/**
 * Doctor-confirmed inputs for a 10-year risk equation, in a dialog. Nothing
 * is assumed: every yes/no starts unanswered and Calculate stays disabled
 * until every input is confirmed (the engines reject missing values anyway).
 * BMI may be left blank: PREVENT then reports every outcome except heart
 * failure instead of guessing one.
 */
export default function RiskForm({ model = 'prevent', open, onOpenChange, defaults = {}, onSubmit, running }) {
  const spec = MODELS[model];
  const [form, setForm] = useState(() => emptyForm(model, defaults));

  // Start from the latest measured values each time the dialog opens
  useEffect(() => {
    if (open) setForm(emptyForm(model, defaults));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, model]);

  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));
  const optional = (key) => model === 'prevent' && key === 'bmi';
  const complete = Object.entries(form).every(([key, value]) => optional(key) || (value !== '' && value !== null));

  function submit() {
    const numbers = Object.fromEntries(
      spec.numbers.map(([key]) => [key, form[key] === '' ? null : Number(form[key])])
    );
    onSubmit({ model, ...form, ...numbers });
  }

  const choice = (key, label) => (
    <fieldset key={key} className="space-y-1">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {[
          [true, 'Yes'],
          [false, 'No'],
        ].map(([value, text]) => (
          <button
            type="button"
            key={text}
            aria-pressed={form[key] === value}
            onClick={() => set(key, value)}
            className={cn(
              'rounded-md border px-3 py-1 text-sm transition-colors',
              form[key] === value ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted'
            )}
          >
            {text}
          </button>
        ))}
      </div>
    </fieldset>
  );

  const number = ([key, label, props]) => (
    <div key={key} className="space-y-1">
      <Label htmlFor={`risk-${key}`}>{label}</Label>
      <Input id={`risk-${key}`} type="number" value={form[key]} onChange={(e) => set(key, e.target.value)} {...props} />
      {defaults[key] !== undefined && defaults[key] !== '' && defaults.snapshot_date && (
        <p className="text-[11px] text-muted-foreground">latest reading, {formatDate(defaults.snapshot_date)}</p>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>{spec.title}</DialogTitle>
          <DialogDescription>
            The system never guesses an input. Confirm every value before calculating.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Sex (model)</legend>
            <div className="flex flex-wrap gap-2">
              {['Male', 'Female'].map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={form.model_sex === value}
                  onClick={() => set('model_sex', value)}
                  className={cn(
                    'rounded-md border px-3 py-1 text-sm transition-colors',
                    form.model_sex === value ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted'
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
          </fieldset>
          {spec.cohort && (
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Cohort (per equation)</legend>
              <div className="flex flex-wrap gap-2">
                {[
                  ['White', 'White'],
                  ['Black', 'Black'],
                  ['Other', 'Other (not supported)'],
                ].map(([value, text]) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={form.cohort === value}
                    onClick={() => set('cohort', value)}
                    className={cn(
                      'rounded-md border px-3 py-1 text-sm transition-colors',
                      form.cohort === value ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted'
                    )}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          {spec.numbers.map(number)}
          {spec.choices.map(([key, label]) => choice(key, label))}
          <div className="space-y-1">
            <Label htmlFor="risk-date">Values measured on</Label>
            <Input id="risk-date" type="date" value={form.snapshot_date} onChange={(e) => set('snapshot_date', e.target.value)} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{spec.note}</p>
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
