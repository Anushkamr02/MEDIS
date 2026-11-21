import { test, expect } from '@playwright/test';
import { mockApp, DOCTOR, PATIENT } from './fixtures';

// Patient-controlled access (migration v11): a search sends a request, the
// patient approves, declines or revokes, and emergency access needs a reason.

const OTHER_DOCTOR = '66666666-6666-4666-8666-666666666666';
const at = '2026-11-10T08:00:00Z';
const pendingRow = {
  doctor_id: OTHER_DOCTOR, doctor_name: 'Second Doctor', doctor_display_id: 'MEDIS-D-000002', specialization: 'Diabetology',
  hospital_name: 'Other Hospital', first_access: null, last_accessed: null, last_visit: null, visit_count: 0,
  is_active: false, access_status: 'pending', is_emergency: false, access_reason: 'Referred for a cardiac risk review', requested_at: at,
  responded_at: null, revoked_at: null,
};
const activeRow = {
  doctor_id: DOCTOR, doctor_name: 'Test Doctor', doctor_display_id: 'MEDIS-D-000001', specialization: 'Cardiology',
  hospital_name: 'Test Hospital', first_access: '2026-01-10T10:00:00Z', last_accessed: at, last_visit: '2026-01-10T10:00:00Z', visit_count: 1,
  is_active: true, access_status: 'active', is_emergency: false, access_reason: null, requested_at: '2026-01-10T09:00:00Z',
  responded_at: '2026-01-10T10:00:00Z', revoked_at: null,
};

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.runtimeErrors = errors;
});
test.afterEach(async ({ page }) => {
  expect(page.runtimeErrors, 'No unhandled browser errors').toEqual([]);
});

test('a doctor without access sends a request instead of opening the record', async ({ page }) => {
  const state = await mockApp(page, 'doctor', { assignment: null });
  await page.goto('/doctor/patients');
  const input = page.getByRole('textbox', { name: 'Patient ID', exact: true });
  await input.fill('MEDIS-P-000123');
  await page.getByRole('button', { name: 'Search', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Open record', exact: true })).toHaveCount(0);
  await expect(page.getByText('The patient approves access from their MEDIS account', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Request access', exact: true }).click();

  await expect(page.getByText('Pending approval').first()).toBeVisible();
  await expect(page.getByText('Waiting for the patient to approve it', { exact: false })).toBeVisible();
  await expect(page).toHaveURL(/\/doctor\/patients(\?.*)?$/);
  await expect(page.getByRole('heading', { name: 'Access requests', exact: true })).toBeVisible();

  const request = state.requests.find((r) => r.name === 'request_patient_access');
  expect(request?.body).toMatchObject({ p_patient_id: PATIENT, p_emergency: false, p_reason: null });
  expect(state.requests.some((r) => r.name === 'log_patient_access' && r.body?.p_action === 'opened_patient_record')).toBe(false);
});

test('emergency access needs a reason, then opens the record and is logged', async ({ page }) => {
  const state = await mockApp(page, 'doctor', { assignment: null });
  await page.goto('/doctor/patients?q=MEDIS-P-000123');
  await page.getByRole('button', { name: 'Emergency access', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Emergency access' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Open record now', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('at least 10 characters');
  expect(state.requests.filter((r) => r.name === 'request_patient_access')).toHaveLength(0);

  await dialog.getByLabel('Reason (required)').fill('Acute chest pain in the emergency department; patient cannot respond');
  await dialog.getByRole('button', { name: 'Open record now', exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/doctor/patients/${PATIENT}$`));
  const request = state.requests.find((r) => r.name === 'request_patient_access');
  expect(request?.body).toMatchObject({ p_patient_id: PATIENT, p_emergency: true });
  expect(request?.body?.p_reason).toContain('Acute chest pain');
  const logged = state.requests.find((r) => r.name === 'log_patient_access' && r.body?.p_action === 'opened_patient_record');
  expect(logged?.body?.p_metadata?.source).toBe('emergency');
});

test('a doctor who already has access still opens the record directly', async ({ page }) => {
  const state = await mockApp(page);
  await page.goto('/doctor/patients?q=MEDIS-P-000123');
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/doctor/patients/${PATIENT}$`));
  expect(state.requests.some((r) => r.name === 'request_patient_access')).toBe(true);
  expect(state.requests.some((r) => r.name === 'log_patient_access' && r.body?.p_action === 'opened_patient_record')).toBe(true);
});

test('the patient is told about a waiting request on the dashboard', async ({ page }) => {
  await mockApp(page, 'patient', { accessSummary: [pendingRow, activeRow] });
  await page.goto('/patient');
  await expect(page.getByText('A doctor is asking to open your record.', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Review the request', exact: true }).click();
  await expect(page).toHaveURL(/\/patient\/access$/);
});

test('the patient approves a request, then revokes a doctor', async ({ page }) => {
  const state = await mockApp(page, 'patient', { accessSummary: [pendingRow, activeRow] });
  await page.goto('/patient/access');

  await expect(page.getByRole('heading', { name: '1 access request waiting for you' })).toBeVisible();
  const request = page.getByRole('list', { name: 'Access requests' }).getByRole('listitem');
  await expect(request).toContainText('Dr. Second Doctor');
  await expect(request).toContainText('Referred for a cardiac risk review');
  await request.getByRole('button', { name: 'Approve access', exact: true }).click();

  await expect(page.getByRole('heading', { name: /access request/ })).toHaveCount(0);
  expect(state.requests.find((r) => r.name === 'respond_access_request')?.body).toEqual({ p_doctor_id: OTHER_DOCTOR, p_approve: true });

  const withAccess = page.locator('section', { has: page.getByRole('heading', { name: 'Doctors with access to your record' }) });
  await expect(withAccess.getByText('Dr. Second Doctor')).toBeVisible();
  await expect(withAccess.getByText('Dr. Test Doctor')).toBeVisible();
  await expect(withAccess.getByText('Access granted')).toHaveCount(2);

  await withAccess.getByRole('listitem').filter({ hasText: 'Dr. Test Doctor' }).getByRole('button', { name: 'Revoke', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Dr. Test Doctor will lose access');
  await dialog.getByRole('button', { name: 'Revoke access', exact: true }).click();

  expect(state.requests.find((r) => r.name === 'revoke_doctor_access')?.body).toEqual({ p_doctor_id: DOCTOR });
  await expect(withAccess.getByText('Dr. Test Doctor')).toHaveCount(0);
  const past = page.locator('section', { has: page.getByRole('heading', { name: 'Past requests and revoked access' }) });
  await expect(past.getByText('Dr. Test Doctor')).toBeVisible();
  await expect(past.getByText('Revoked', { exact: true })).toBeVisible();
});

test('declining a request keeps the doctor out and records the answer', async ({ page }) => {
  const state = await mockApp(page, 'patient', { accessSummary: [pendingRow] });
  await page.goto('/patient/access');
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  expect(state.requests.find((r) => r.name === 'respond_access_request')?.body).toEqual({ p_doctor_id: OTHER_DOCTOR, p_approve: false });
  await expect(page.getByText('No doctor currently has access to your record.')).toBeVisible();
  const past = page.locator('section', { has: page.getByRole('heading', { name: 'Past requests and revoked access' }) });
  await expect(past.getByText('Declined', { exact: true })).toBeVisible();
});

test('emergency access is flagged to the patient with its reason', async ({ page }) => {
  await mockApp(page, 'patient', {
    accessSummary: [{ ...activeRow, is_emergency: true, access_reason: 'Collapsed in the emergency department' }],
    accessEvents: [{
      event_id: 'event-9', doctor_id: DOCTOR, doctor_name: 'Test Doctor', doctor_display_id: 'MEDIS-D-000001', specialization: 'Cardiology',
      hospital_name: 'Test Hospital', action: 'emergency_access', access_type: 'Emergency access', accessed_at: at,
      metadata: { reason: 'Collapsed in the emergency department' }, total_count: 1,
    }],
  });
  await page.goto('/patient/access');
  await expect(page.getByText('Emergency access', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Emergency reason: Collapsed in the emergency department')).toBeVisible();
});
