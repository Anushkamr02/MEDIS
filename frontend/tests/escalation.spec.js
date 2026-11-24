import { test, expect } from '@playwright/test';
import { mockApp, mockPublication, PATIENT } from './fixtures';

// escalation_events (migration v15): the database writes them; the UI only reads.
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
const events = [
  { id: 'esc-1', patient_id: PATIENT, assessment_id: 'assessment-1', ecg_analysis_id: null, level: 1, reason: 'critical_priority', finding_at: hoursAgo(5), created_at: hoursAgo(1), doctors_notified: 1 },
  { id: 'esc-0', patient_id: PATIENT, assessment_id: 'assessment-1', ecg_analysis_id: null, level: 0, reason: 'critical_priority', finding_at: hoursAgo(5), created_at: hoursAgo(5), doctors_notified: 1 },
];

async function mockEscalations(page, { legacy = false } = {}) {
  await page.route('**/rest/v1/escalation_events**', (route) =>
    legacy
      ? route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.escalation_events'" }) })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(events) }));
}

test('an overdue urgent finding is pinned in red on the Overview until it is reviewed', async ({ page }) => {
  const state = await mockApp(page);
  await mockPublication(page, state);
  await mockEscalations(page);
  await page.goto('/doctor');
  const pinned = page.getByRole('region', { name: 'Overdue urgent reviews' });
  await expect(pinned.getByText('1 overdue urgent review.')).toBeVisible();
  await expect(pinned.getByText('Overdue urgent review', { exact: true })).toBeVisible();
  await expect(pinned.getByText(/Review priority: Critical/)).toBeVisible();

  await pinned.getByRole('button', { name: 'Review', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review finding' });
  await dialog.getByLabel('Outcome').click();
  await page.getByRole('option', { name: 'Patient contacted' }).click();
  await dialog.getByRole('button', { name: 'Record review' }).click();
  await expect(pinned).toHaveCount(0);
});

test('the Monitoring card shows the escalation history', async ({ page }) => {
  const state = await mockApp(page);
  await mockPublication(page, state);
  await mockEscalations(page);
  await page.goto(`/doctor/patients/${PATIENT}`);
  const history = page.getByRole('region', { name: 'Monitoring' }).getByRole('group', { name: 'Escalation history' });
  await expect(history.getByText('Overdue urgent review')).toBeVisible();
  await expect(history.getByText('Urgent: review needed')).toBeVisible();
});

test('nothing is pinned on a database without migration v15', async ({ page }) => {
  const state = await mockApp(page);
  await mockPublication(page, state);
  await mockEscalations(page, { legacy: true });
  await page.goto('/doctor');
  await expect(page.getByRole('heading', { name: /Patient monitoring/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Overdue urgent reviews' })).toHaveCount(0);
});
