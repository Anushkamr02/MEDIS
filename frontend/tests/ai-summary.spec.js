import { test, expect } from '@playwright/test';
import { mockApp, PATIENT } from './fixtures';

const gemini = {
  format: 'gemini-summary-v1',
  overview: 'Synthetic overview: blood pressure 140/90 on 10 Mar 2026, trend Worsening.',
  changes: [{ text: 'Synthetic systolic BP rose from 120 to 140 mmHg.', visit_ids: ['MEDIS-V-000002'] }],
  review_points: ['Synthetic review point'],
  data_gaps: ['Synthetic data gap'],
  unverified_numbers: ['999'],
};
const draft = { headline: 'Synthetic patient headline.', points: ['Synthetic patient point'], next_step: 'Synthetic next step.', unverified_numbers: [] };

async function mockSummary(page, state, response) {
  state.summaryCalls = 0;
  await page.route('**/ai/summary/**', async (route) => {
    state.summaryCalls += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      assessment_id: 'assessment-1', summary_model: 'test-model', summary_created_at: new Date().toISOString(), ...response }) });
  });
}

test('Gemini summary shows the doctor version, the patient draft and unverified numbers; generates once', async ({ page }) => {
  const state = await mockApp(page);
  await mockSummary(page, state, { ai_summary: gemini, patient_draft: draft, fallback_reason: null });
  await page.goto(`/doctor/patients/${PATIENT}`);
  const panel = page.getByRole('region', { name: 'Patient record summary' });
  await expect(panel.getByText(gemini.overview)).toBeVisible();
  await expect(panel.getByText('Synthetic review point')).toBeVisible();
  await expect(panel.getByText(/999 could not be traced/)).toBeVisible();
  const preview = panel.getByRole('group', { name: 'Patient draft' });
  await expect(preview.getByText('Patient draft (not visible to the patient)')).toBeVisible();
  await expect(preview.getByText('Synthetic patient headline.')).toBeVisible();
  expect(state.summaryCalls).toBe(1);

  await panel.getByRole('button', { name: 'Refresh summary' }).click();
  await expect.poll(() => state.summaryCalls).toBe(2);
});

test('a stored summary is not regenerated when the panel opens', async ({ page }) => {
  const state = await mockApp(page);
  state.assessment.ai_summary = gemini;
  await mockSummary(page, state, { ai_summary: gemini, patient_draft: draft, fallback_reason: null });
  await page.goto(`/doctor/patients/${PATIENT}`);
  const panel = page.getByRole('region', { name: 'Patient record summary' });
  await expect(panel.getByText(gemini.overview)).toBeVisible();
  await expect(panel.getByText('No patient draft yet. Press Refresh to write one.')).toBeVisible();
  expect(state.summaryCalls).toBe(0);
});

test('without Gemini the rule-based summary shows with a fallback note', async ({ page }) => {
  const state = await mockApp(page);
  const reason = 'AI text features are not configured: set GEMINI_API_KEY in backend/.env';
  await mockSummary(page, state, {
    ai_summary: { format: 'clinical-highlights-v1', overview: 'Synthetic record summary.', key_points: ['Synthetic key point'], unverified_numbers: [], fallback_reason: reason },
    patient_draft: null, fallback_reason: reason,
  });
  await page.goto(`/doctor/patients/${PATIENT}`);
  const panel = page.getByRole('region', { name: 'Patient record summary' });
  await expect(panel.getByText('Synthetic record summary.')).toBeVisible();
  await expect(panel.getByText(/Written from the record without Gemini/)).toBeVisible();
  await expect(panel.getByRole('group', { name: 'Patient draft' })).toHaveCount(0);
});
