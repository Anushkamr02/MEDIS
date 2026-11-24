import { test, expect } from '@playwright/test';
import { mockApp, DOCTOR, PATIENT } from './fixtures';

// finding_reviews (migration v13): starts empty; record_finding_review() adds a row.
async function mockReviews(page, state, { legacy = false } = {}) {
  state.reviews = [];
  await page.route('**/rest/v1/finding_reviews**', (route) =>
    legacy
      ? route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.finding_reviews'" }) })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.reviews) }));
  await page.route('**/rest/v1/rpc/record_finding_review', async (route) => {
    const body = route.request().postDataJSON();
    state.reviewCalls = [...(state.reviewCalls ?? []), body];
    const row = { id: 'review-1', patient_id: PATIENT, assessment_id: body.p_assessment_id, ecg_analysis_id: body.p_ecg_analysis_id, reviewed_by: DOCTOR,
      reviewed_at: new Date().toISOString(), outcome: body.p_outcome, note: body.p_note, reviewer: { full_name: 'Test Doctor' } };
    state.reviews = [row];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(row) });
  });
}

async function recordReview(page, scope, outcome, note) {
  await scope.getByRole('button', { name: 'Review', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review finding' });
  await expect(dialog.getByText('Review priority: Needs review')).toBeVisible();
  await dialog.getByLabel('Outcome').click();
  await page.getByRole('option', { name: outcome }).click();
  if (note) await dialog.getByLabel('Note (optional)').fill(note);
  await dialog.getByRole('button', { name: 'Record review' }).click();
}

test('profile groups AI under doctor-only Clinical Insights and records a review', async ({ page }) => {
  const state = await mockApp(page);
  await mockReviews(page, state);
  await page.goto(`/doctor/patients/${PATIENT}`);
  const insights = page.getByRole('region', { name: 'Clinical Insights' });
  await expect(insights.getByText('Clinical Insights: doctor only, not visible to the patient')).toBeVisible();
  const ai = insights.getByRole('region', { name: 'AI insights' });
  await expect(ai.getByText('Awaiting doctor review')).toBeVisible();

  await recordReview(page, ai, 'No action needed', 'Synthetic note');
  expect(state.reviewCalls[0]).toEqual({ p_assessment_id: 'assessment-1', p_ecg_analysis_id: null, p_outcome: 'no_action', p_note: 'Synthetic note' });
  await expect(ai.getByText('Reviewed: No action needed')).toBeVisible();
  await expect(ai.getByText('Awaiting doctor review')).toHaveCount(0);
});

test('Overview lists unreviewed findings; "Follow-up booked" opens a pre-filled appointment form', async ({ page }) => {
  const state = await mockApp(page);
  await mockReviews(page, state);
  await page.goto('/doctor');
  const board = page.locator('section', { has: page.getByRole('heading', { name: /Patient monitoring/ }) });
  await expect(board.getByRole('heading', { name: 'Needs review' })).toBeVisible();
  await expect(board.getByText('Review priority: Needs review', { exact: true })).toBeVisible();

  await recordReview(page, board, 'Follow-up booked');
  await expect(page).toHaveURL(/\/doctor\/appointments\?patient=/);
  await expect(page.getByLabel('Reason')).toHaveValue('Follow-up: Review priority: Needs review');
});

test('review controls are hidden on a database without migration v13', async ({ page }) => {
  const state = await mockApp(page);
  await mockReviews(page, state, { legacy: true });
  await page.goto(`/doctor/patients/${PATIENT}`);
  await expect(page.getByRole('region', { name: 'AI insights' })).toBeVisible();
  await expect(page.getByText('Awaiting doctor review')).toHaveCount(0);
  await page.goto('/doctor');
  await expect(page.getByText("Today's consultations")).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Needs review' })).toHaveCount(0);
});
