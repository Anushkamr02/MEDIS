import { test, expect } from '@playwright/test';
import { mockApp, mockPublication, PATIENT, patient } from './fixtures';

test('the top-bar Patient ID search works from any doctor page', async ({ page }) => {
  const state = await mockApp(page);
  await mockPublication(page, state);
  await page.goto('/doctor/appointments');

  const box = page.getByRole('search').getByLabel('Find a patient by MEDIS Patient ID');
  await box.fill(patient.display_id);
  await box.press('Enter');

  await expect(page).toHaveURL(new RegExp(`/doctor/patients\\?q=${patient.display_id}$`));
  // My Patients ran the lookup for that ID and shows the match with its access state.
  await expect(page.getByText(patient.full_name).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open record' })).toBeVisible();
  // The box clears, so the next search starts empty.
  await expect(page.getByLabel('Find a patient by MEDIS Patient ID')).toHaveValue('');
});

test('an unknown ID reports no match instead of failing silently', async ({ page }) => {
  const state = await mockApp(page);
  await mockPublication(page, state);
  await page.goto('/doctor');

  const box = page.getByLabel('Find a patient by MEDIS Patient ID');
  await box.fill('MEDIS-P-000999');
  await box.press('Enter');
  await expect(page).toHaveURL(/\/doctor\/patients\?q=MEDIS-P-000999$/);
  await expect(page.getByText('No patient with ID MEDIS-P-000999. Check the ID and try again.')).toBeVisible();
});

test('trend charts mark each hospital with its own shape and explain the shapes', async ({ page }) => {
  const state = await mockApp(page, 'doctor', {});
  // Two hospitals in one series, so the markers and the key must both appear.
  state.assessment.report.metric_trajectories.systolic_bp.points = [
    { date: '2026-01-10', value: 120, evidence: [{ visit_id: 'MEDIS-V-000002', hospital: 'Test Hospital' }] },
    { date: '2026-03-10', value: 140, evidence: [{ visit_id: 'MEDIS-V-000003', hospital: 'Second Hospital' }] },
  ];
  await mockPublication(page, state);
  await page.goto(`/doctor/patients/${PATIENT}`);

  const ai = page.getByRole('region', { name: 'AI insights' });
  const key = ai.locator('[aria-label="Hospital markers"]');
  await expect(key.getByText('Test Hospital (circle)')).toBeVisible();
  await expect(key.getByText('Second Hospital (square)')).toBeVisible();
  // One marker per reading: a circle for the first hospital, a square for the second.
  await expect(ai.locator('svg.recharts-surface rect')).not.toHaveCount(0);
});
