import { test, expect } from '@playwright/test';
import { mockApp, mockPublication, published, PATIENT } from './fixtures';

// Governance requirements (IMPROVEMENT_PLAN §3.5, §3.6) as far as the browser can show them.
// What RLS enforces in the database (zero rows for patients, revocation, non-doctor
// requests) is checked against a real database by supabase/governance_check.sql.
const AI_TABLES = ['cad_assessments', 'ecg_analyses', 'finding_reviews', 'monitoring_queue', 'escalation_events'];

test('a patient never requests or sees AI fields, only the published summary', async ({ page }) => {
  const state = await mockApp(page, 'patient');
  await mockPublication(page, state, { summaries: [published] });
  for (const path of ['/patient/prescriptions', '/patient/documents', '/patient/visits', '/patient/access']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
  }
  await page.goto('/patient');
  await expect(page.getByRole('region', { name: 'Health summary from your doctor' })).toBeVisible();
  expect(state.requests.filter((r) => AI_TABLES.includes(r.name)).map((r) => r.name)).toEqual([]);
  await expect(page.getByText(/Needs review|Critical|possible MI|myocardial|Synthetic review result/i)).toHaveCount(0);
});

test('publishing stays blocked without a review, even when everything else is filled in', async ({ page }) => {
  const state = await mockApp(page);
  await mockPublication(page, state);
  await page.goto(`/doctor/patients/${PATIENT}`);
  await page.getByRole('button', { name: 'Publish summary to patient' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish a health summary' });
  await dialog.getByLabel('Status message').click();
  await page.getByRole('option', { name: 'Your results look steady' }).click();
  await dialog.getByLabel('Headline').fill('Your results look steady.');
  await dialog.getByLabel('Points (one per line, plain words)').fill('Your blood pressure was checked.');
  await dialog.getByRole('checkbox', { name: 'I have reviewed this summary and it is accurate' }).click();
  await expect(dialog.getByText(/Review the significant findings/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Publish' })).toBeDisabled();
  expect(state.rpcs).toEqual([]);
});

test('a withdrawn summary is no longer shown to the patient', async ({ page }) => {
  const state = await mockApp(page, 'patient');
  await mockPublication(page, state, { summaries: [published] });
  await page.goto('/patient');
  await expect(page.getByRole('region', { name: 'Health summary from your doctor' })).toBeVisible();
  state.summaries = [{ ...published, withdrawn_at: new Date().toISOString() }];
  await page.reload();
  await expect(page.getByRole('heading', { name: 'ECG and heart health' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Health summary from your doctor' })).toHaveCount(0);
});

test('opening Clinical Insights is audited through log_patient_access', async ({ page }) => {
  const state = await mockApp(page);
  await mockPublication(page, state);
  await page.goto(`/doctor/patients/${PATIENT}`);
  await expect(page.getByRole('region', { name: 'Clinical Insights' }).first()).toBeVisible();
  await expect
    .poll(() => state.requests.filter((r) => r.name === 'log_patient_access' && r.body?.p_action === 'viewed_clinical_insights').length)
    .toBe(1);
  expect(state.requests.find((r) => r.body?.p_action === 'viewed_clinical_insights').body.p_patient_id).toBe(PATIENT);
});

test('a revoked doctor loads no review, queue, escalation or summary data', async ({ page }) => {
  const state = await mockApp(page, 'doctor', { assignment: null });
  await mockPublication(page, state);
  // With no active assignment RLS returns no profile row, so the record does not open.
  await page.route('**/rest/v1/profiles?*', (route) =>
    route.request().url().includes(`id=eq.${PATIENT}`)
      ? route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
      : route.fallback());
  await page.goto(`/doctor/patients/${PATIENT}`);
  await expect(page.getByRole('region', { name: 'Clinical Insights' })).toHaveCount(0);
  const governed = [...AI_TABLES, 'patient_health_summaries'];
  expect(state.requests.filter((r) => governed.includes(r.name)).map((r) => r.name)).toEqual([]);
  expect(state.requests.some((r) => r.body?.p_action === 'viewed_clinical_insights')).toBe(false);
});

test('a patient account cannot reach the doctor portal to request access', async ({ page }) => {
  const state = await mockApp(page, 'patient');
  await page.goto(`/doctor/patients/${PATIENT}`);
  await expect(page).not.toHaveURL(/\/doctor\//);
  expect(state.requests.some((r) => r.name === 'request_patient_access')).toBe(false);
});
