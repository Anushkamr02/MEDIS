import { test, expect } from '@playwright/test';
import { mockApp, mockPublication as mockV14, published, PATIENT } from './fixtures';

test('publishing is blocked until the finding is reviewed and unverified numbers are corrected', async ({ page }) => {
  const state = await mockApp(page);
  await mockV14(page, state);
  await page.goto(`/doctor/patients/${PATIENT}`);
  const ai = page.getByRole('region', { name: 'AI insights' });
  await expect(ai.getByText('Synthetic overview.')).toBeVisible();

  await ai.getByRole('button', { name: 'Publish summary to patient' }).click();
  let dialog = page.getByRole('dialog', { name: 'Publish a health summary' });
  await expect(dialog.getByLabel('Headline')).toHaveValue('Your blood pressure was 777 at your last visit.');
  await expect(dialog.getByText(/Review the significant findings/)).toBeVisible();
  await expect(dialog.getByText(/Correct or remove 777/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await ai.getByRole('button', { name: 'Review', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review finding' });
  await review.getByLabel('Outcome').click();
  await page.getByRole('option', { name: 'No action needed' }).click();
  await review.getByRole('button', { name: 'Record review' }).click();
  await expect(ai.getByText('Reviewed: No action needed')).toBeVisible();

  await ai.getByRole('button', { name: 'Publish summary to patient' }).click();
  dialog = page.getByRole('dialog', { name: 'Publish a health summary' });
  await expect(dialog.getByText(/Review the significant findings/)).toHaveCount(0);
  await dialog.getByLabel('Status message').click();
  await page.getByRole('option', { name: 'Some results to keep an eye on' }).click();
  await dialog.getByRole('checkbox', { name: 'I have reviewed this summary and it is accurate' }).click();
  await expect(dialog.getByRole('button', { name: 'Publish' })).toBeDisabled();

  await dialog.getByLabel('Headline').fill('Your blood pressure went up a little.');
  await dialog.getByRole('checkbox', { name: 'Blood pressure (top number)' }).click();
  await dialog.getByRole('button', { name: 'Publish' }).click();
  await expect(ai.getByText(/Published to patient/)).toBeVisible();
  expect(state.rpcs[0].body).toEqual({
    p_patient_id: PATIENT, p_assessment_id: 'assessment-1', p_status_message: 'keep_an_eye',
    p_headline: 'Your blood pressure went up a little.', p_points: ['Synthetic draft point'], p_next_step: 'Synthetic draft step.',
    p_shown_metrics: { systolic_bp: { label: 'Blood pressure (top number)', unit: 'mmHg', count: 2, points: [{ date: '2026-01-10', value: 120 }, { date: '2026-03-10', value: 140 }] } },
  });

  await ai.getByRole('button', { name: 'Withdraw' }).click();
  await expect(ai.getByRole('button', { name: 'Publish summary to patient' })).toBeVisible();
  expect(state.rpcs[1]).toEqual({ name: 'withdraw_health_summary', body: { p_summary_id: 'summary-2' } });
});

test('the patient sees only the published summary, never AI output', async ({ page }) => {
  const state = await mockApp(page, 'patient');
  await mockV14(page, state, { summaries: [published] });
  await page.goto('/patient');
  const card = page.getByRole('region', { name: 'Health summary from your doctor' });
  await expect(card.getByText('Synthetic headline from the doctor.')).toBeVisible();
  await expect(card.getByText('Some results to keep an eye on')).toBeVisible();
  await expect(card.getByText(/went up from 120 to 140 mmHg/)).toBeVisible();
  await expect(card.getByText(/Needs review|Critical|Synthetic review result|risk/i)).toHaveCount(0);
  expect(state.requests.some((r) => r.name === 'cad_assessments')).toBe(false);
});

test('a withdrawn summary disappears; publishing hides on a database without v14', async ({ page }) => {
  const state = await mockApp(page, 'patient');
  await mockV14(page, state, { summaries: [{ ...published, withdrawn_at: '2026-11-21T10:00:00Z' }] });
  await page.goto('/patient');
  await expect(page.getByRole('heading', { name: 'ECG and heart health' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Health summary from your doctor' })).toHaveCount(0);

  const doctorPage = await page.context().newPage();
  const doctorState = await mockApp(doctorPage);
  await mockV14(doctorPage, doctorState, { legacy: true });
  await doctorPage.goto(`/doctor/patients/${PATIENT}`);
  const ai = doctorPage.getByRole('region', { name: 'AI insights' });
  await expect(ai.getByText('Publishing to the patient needs database migration v14.')).toBeVisible();
  await expect(ai.getByRole('button', { name: /Publish/ })).toHaveCount(0);
});
