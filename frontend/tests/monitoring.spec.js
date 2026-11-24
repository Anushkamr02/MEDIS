import { test, expect } from '@playwright/test';
import { mockApp, DOCTOR, DRAFT, PATIENT } from './fixtures';

// Synthetic monitoring runs (migration v12 columns), newest first.
const at = new Date().toISOString();
const runs = [
  { id: 'run-2', patient_id: PATIENT, requested_by: DOCTOR, review_priority: 'REVIEW', created_at: at, health_trend: 'WORSENING', trigger_event: 'visit_finalized',
    reasons: ['LDL 120 → 150 mg/dL (10 Jan 2026 → 10 Mar 2026), moving away from target < 100'],
    monitoring: {
      health_trend: 'WORSENING',
      reasons: ['LDL 120 → 150 mg/dL (10 Jan 2026 → 10 Mar 2026), moving away from target < 100'],
      metric_changes: [{ metric: 'ldl_cholesterol', label: 'LDL', unit: 'mg/dL', target: '< 100', status: 'worsening',
        previous: { date: '2026-01-10', value: 120 }, latest: { date: '2026-03-10', value: 150 } }],
      treatment_responses: [{ medicine: 'Atorvastatin', class_label: 'Statin', metric: 'ldl_cholesterol', metric_label: 'LDL', started: '2026-03-10',
        status: 'awaiting_follow_up', due_from: '2026-04-07', due_by: '2026-06-02', overdue: false }],
    } },
  { id: 'run-1', patient_id: PATIENT, requested_by: DOCTOR, review_priority: 'REVIEW', created_at: '2026-01-10T10:00:00Z', health_trend: 'STABLE', trigger_event: 'manual',
    monitoring: { health_trend: 'STABLE', reasons: [], metric_changes: [], treatment_responses: [] } },
];

async function mockMonitoring(page, state, { legacy = false } = {}) {
  await page.route('**/rest/v1/cad_assessments**', async (route) => {
    const select = new URL(route.request().url()).searchParams.get('select') ?? '';
    if (legacy && select.includes('health_trend')) {
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '42703', message: 'column cad_assessments.health_trend does not exist' }) });
    }
    const rows = legacy || !select.includes('health_trend') ? [state.assessment] : runs.map((r) => ({ ...state.assessment, ...r, treatments: r.monitoring.treatment_responses, report: state.assessment.report }));
    const single = route.request().headers().accept?.includes('vnd.pgrst.object');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(single ? rows[0] : rows) });
  });
  await page.route('**/ai/monitor/**', async (route) => {
    state.requests.push({ name: new URL(route.request().url()).pathname, method: 'POST', body: route.request().postDataJSON() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      patient_id: PATIENT, assessment_id: 'run-3', review_priority: 'REVIEW', health_trend: 'WORSENING', reasons: runs[0].reasons, treatment_responses: [],
    }) });
  });
}

test('My Patients shows the trend column and filters by trend', async ({ page }) => {
  const state = await mockApp(page);
  await mockMonitoring(page, state);
  await page.goto('/doctor/patients');
  await expect(page.getByRole('columnheader', { name: 'Trend' })).toBeVisible();
  await expect(page.getByLabel('Trend: Worsening')).toBeVisible();

  await page.goto('/doctor/patients?trend=improving');
  await expect(page.getByText('No patients in this group.', { exact: false })).toBeVisible();
  await page.getByRole('tablist', { name: 'Trend filter' }).getByRole('tab', { name: 'Worsening' }).click();
  await expect(page).toHaveURL(/trend=worsening/);
  await expect(page.getByLabel('Trend: Worsening')).toBeVisible();
});

test('patient profile shows the monitoring timeline, changes and treatment response', async ({ page }) => {
  const state = await mockApp(page);
  await mockMonitoring(page, state);
  await page.goto(`/doctor/patients/${PATIENT}`);
  const card = page.getByRole('region', { name: 'Monitoring' });
  await expect(card.getByRole('heading', { name: 'Since last check' })).toBeVisible();
  await expect(card.getByText('moving away from target < 100').first()).toBeVisible();
  await expect(card.getByText('Atorvastatin')).toBeVisible();
  await expect(card.getByText('Awaiting follow-up')).toBeVisible();

  await card.getByRole('button', { name: /Manual analysis.*Stable/ }).click();
  await expect(card.getByRole('heading', { name: 'Since last check' })).toHaveCount(0);
});

test('finalizing a visit re-checks the patient and shows the new trend', async ({ page }) => {
  const state = await mockApp(page);
  await mockMonitoring(page, state);
  await page.goto(`/doctor/consultations/${DRAFT}`);
  await page.locator('#dx-final').fill('Synthetic final diagnosis');
  await page.getByRole('button', { name: 'Finalize consultation', exact: true }).click();
  await page.getByRole('button', { name: 'Finalize', exact: true }).click();
  await expect(page.getByText(/Monitoring updated: Worsening/)).toBeVisible();
  const call = state.requests.find((r) => r.name === `/ai/monitor/${PATIENT}`);
  expect(call.body).toEqual({ trigger_event: 'visit_finalized', trigger_ref: DRAFT });
});

test('Overview shows trend tiles, monitoring lists and processes the queue', async ({ page }) => {
  const state = await mockApp(page);
  await mockMonitoring(page, state);
  await page.route('**/rest/v1/monitoring_queue**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ patient_id: PATIENT }]) }));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route('**/ai/monitor/queue', async (route) => {
    state.requests.push({ name: '/ai/monitor/queue' });
    await held;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ processed: [], failed: [], remaining: 0 }) });
  });
  await page.goto('/doctor');

  await expect(page.getByRole('status').filter({ hasText: 'Updating 1 patient…' })).toBeVisible();
  release();
  await expect(page.getByText('Updating 1 patient…')).toHaveCount(0);
  expect(state.requests.filter((r) => r.name === '/ai/monitor/queue')).toHaveLength(1);

  const board = page.locator('section', { has: page.getByRole('heading', { name: /Patient monitoring/ }) });
  await expect(board.getByText('moving away from target < 100').first()).toBeVisible();
  await expect(board.getByText('Atorvastatin: Awaiting follow-up')).toBeVisible();
  await expect(board.getByText(/Atorvastatin: LDL due/)).toBeVisible();
  await expect(board.getByText('No patient is improving yet.')).toBeVisible();
  await board.getByRole('link', { name: '1 Worsening' }).click();
  await expect(page).toHaveURL(/\/doctor\/patients\?trend=worsening/);
});

test('monitoring is hidden on a database without migration v12', async ({ page }) => {
  const state = await mockApp(page);
  await mockMonitoring(page, state, { legacy: true });
  await page.goto('/doctor/patients');
  await expect(page.getByLabel('Review AI check for Test Patient: Needs review')).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Trend' })).toHaveCount(0);
  await page.goto(`/doctor/patients/${PATIENT}`);
  await expect(page.getByRole('region', { name: 'AI insights' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Monitoring' })).toHaveCount(0);
  await page.goto('/doctor');
  await expect(page.getByText("Today's consultations")).toBeVisible();
  await expect(page.getByRole('heading', { name: /Patient monitoring/ })).toHaveCount(0);
});
