import { test, expect } from '@playwright/test';
import { mockApp, mockPublication, PATIENT } from './fixtures';

// The AI service runs the equations (backend/medis/ai/prevent.py and ascvd.py);
// this mock stands in for /ai/risk and records what the form confirmed.
async function mockRisk(page) {
  const state = { calls: [] };
  await page.route('**/ai/risk/**', (route) => {
    const body = route.request().postDataJSON();
    state.calls.push(body);
    const confirmed = {
      confirmed_by_name: 'Test Doctor', confirmed_at: new Date().toISOString(),
      inputs: body, limitations: ['Not calibrated for Indian populations.'],
    };
    const result = body.known_ascvd
      ? { model: 'PREVENT_2023_BASE_10YR', status: 'NOT_APPLICABLE', risks: {}, unavailable: {}, ...confirmed }
      : body.model === 'pce'
        ? { model: 'PCE_2013_LEGACY', status: 'CALCULATED', risk_percent: 12.9, category: 'INTERMEDIATE',
            outcome: 'First nonfatal MI, coronary heart disease death, or fatal/nonfatal stroke within 10 years', ...confirmed }
        : { model: 'PREVENT_2023_BASE_10YR', status: 'CALCULATED', category: 'LOW',
            risks: { total_cvd: 3.4, ascvd: 2.1, heart_failure: 1.7 }, unavailable: {}, ...confirmed };
    const pce = body.model === 'pce' ? { ...result } : { prevent: result };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assessment_id: 'assessment-1', model: body.model, result, pce }) });
  });
  return state;
}

async function openForm(page, name) {
  const card = page.getByRole('region', { name: 'AI insights' }).locator('[aria-label="10-year risk"]');
  await expect(card.getByText('PREVENT (2023, base model)')).toBeVisible();
  await card.getByRole('button', { name }).click();
  return { card, dialog: page.getByRole('dialog') };
}

async function fill(dialog, page, { sex = 'Female', values = {}, answers = {} }) {
  await dialog.getByRole('button', { name: sex, exact: true }).click();
  for (const [label, value] of Object.entries(values)) await dialog.getByLabel(label, { exact: true }).fill(String(value));
  for (const [legend, answer] of Object.entries(answers)) {
    await dialog.locator('fieldset').filter({ has: page.locator('legend', { hasText: legend }) })
      .getByRole('button', { name: answer, exact: true }).click();
  }
  await dialog.getByLabel('Values measured on').fill(new Date().toISOString().slice(0, 10));
}

const PREVENT_VALUES = {
  'Age (30–79)': 45,
  'Total cholesterol (mg/dL)': 200,
  'HDL (mg/dL)': 60,
  'Systolic BP (mmHg)': 120,
  'eGFR (mL/min/1.73m²)': 95,
  'BMI (18.5–39.9, heart failure only)': 25,
};
const PREVENT_ANSWERS = {
  'On BP treatment?': 'No', 'On a statin': 'No', 'Diabetes?': 'Yes', 'Current smoker?': 'No',
  'Known heart disease or stroke': 'No',
};

test('PREVENT needs every input confirmed, then shows a risk per outcome', async ({ page }) => {
  const state = await mockApp(page);
  await mockPublication(page, state);
  const risk = await mockRisk(page);
  await page.goto(`/doctor/patients/${PATIENT}`);

  const { card, dialog } = await openForm(page, 'Calculate PREVENT');
  // Nothing is guessed: Calculate stays disabled until each answer is given.
  await expect(dialog.getByRole('button', { name: 'Calculate', exact: true })).toBeDisabled();
  await fill(dialog, page, { values: PREVENT_VALUES, answers: PREVENT_ANSWERS });
  await dialog.getByRole('button', { name: 'Calculate', exact: true }).click();

  await expect(card.getByText('3.4%')).toBeVisible();
  await expect(card.getByText('2.1%')).toBeVisible();
  await expect(card.getByText('1.7%')).toBeVisible();
  await expect(card.getByText(/ASCVD risk band: Low/)).toBeVisible();
  await expect(card.getByText(/Inputs confirmed by Test Doctor/)).toBeVisible();
  await card.getByRole('group').filter({ hasText: 'Limitations' }).count(); // details element
  await expect(card.getByText(/doctor only/)).toBeVisible();

  expect(risk.calls[0]).toMatchObject({ model: 'prevent', model_sex: 'Female', age: 45, egfr: 95, bmi: 25, diabetes: true, known_ascvd: false });
});

test('a patient with known cardiovascular disease gets no number', async ({ page }) => {
  const state = await mockApp(page);
  await mockPublication(page, state);
  const risk = await mockRisk(page);
  await page.goto(`/doctor/patients/${PATIENT}`);

  const { card, dialog } = await openForm(page, 'Calculate PREVENT');
  await fill(dialog, page, { values: PREVENT_VALUES, answers: { ...PREVENT_ANSWERS, 'Known heart disease or stroke': 'Yes' } });
  await dialog.getByRole('button', { name: 'Calculate', exact: true }).click();

  await expect(card.getByText(/Not applicable: the patient has known cardiovascular disease/)).toBeVisible();
  await expect(card.getByText('%', { exact: false })).toHaveCount(0);
  expect(risk.calls[0].known_ascvd).toBe(true);
});

test('the legacy 2013 PCE can be run alongside PREVENT for comparison', async ({ page }) => {
  const state = await mockApp(page);
  await mockPublication(page, state);
  const risk = await mockRisk(page);
  await page.goto(`/doctor/patients/${PATIENT}`);

  const { card, dialog } = await openForm(page, 'Compare 2013 PCE');
  await dialog.getByRole('button', { name: 'White', exact: true }).click();
  await fill(dialog, page, {
    sex: 'Male',
    values: { 'Age (40–79)': 55, 'Total cholesterol (mg/dL)': 213, 'HDL (mg/dL)': 50, 'Systolic BP (mmHg)': 140 },
    answers: { 'On BP treatment?': 'No', 'Diabetes?': 'No', 'Current smoker?': 'Yes', 'Known heart disease or stroke': 'No' },
  });
  await dialog.getByRole('button', { name: 'Calculate', exact: true }).click();

  await expect(card.getByText('Legacy 2013 Pooled Cohort Equations')).toBeVisible();
  await expect(card.getByText('12.9%')).toBeVisible();
  await expect(card.getByText('Intermediate (7.5–19.9%)')).toBeVisible();
  expect(risk.calls[0]).toMatchObject({ model: 'pce', cohort: 'White', model_sex: 'Male', age: 55 });
});

test('the patient never sees a risk estimate', async ({ page }) => {
  const state = await mockApp(page, 'patient');
  await mockPublication(page, state, { summaries: [] });
  await page.goto('/patient');
  await expect(page.locator('[aria-label="10-year risk"]')).toHaveCount(0);
  await expect(page.getByText(/PREVENT|Pooled Cohort/)).toHaveCount(0);
});
