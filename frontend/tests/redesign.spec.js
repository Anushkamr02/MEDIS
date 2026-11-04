import { test, expect } from '@playwright/test';
import { mockApp, PATIENT, DRAFT, FINAL } from './fixtures';

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.runtimeErrors = errors;
});
test.afterEach(async ({ page }) => {
  expect(page.runtimeErrors, 'No unhandled browser errors').toEqual([]);
});

async function noPageOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test('authentication shares one layout, validates, and expands for doctor registration', async ({ page }) => {
  await mockApp(page, 'anonymous');
  await page.goto('/login');
  await expect(page.locator('.auth-card')).toBeVisible();
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Enter your email and password.');
  await page.getByLabel('Password', { exact: true }).fill('synthetic-secret');
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await expect(page.locator('.auth-card')).toBeVisible();
  await page.getByRole('radio', { name: "I'm a doctor" }).click();
  await expect(page.getByLabel('Specialization')).toBeVisible();
  await page.getByLabel('Hospital', { exact: true }).click();
  await page.getByRole('option', { name: 'Test Hospital, Test City' }).click();
  await expect(page.getByLabel('Hospital', { exact: true })).toContainText('Test Hospital');
  await noPageOverflow(page);
});

test('login preserves server errors and routes a successful login', async ({ page }) => {
  const state = await mockApp(page, 'anonymous', { failLogin: true });
  await page.goto('/login');
  await page.getByLabel('Email or MEDIS ID', { exact: true }).fill('doctor@example.test');
  await page.getByLabel('Password', { exact: true }).fill('synthetic-secret');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid login credentials');
  state.failLogin = false;
  // The synthetic login response carries the doctor profile.
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL(/\/doctor$/);
});

test('patient appointments use existing rows, expand, refresh, and separate history', async ({ page }) => {
  const state = await mockApp(page, 'patient');
  await page.goto('/patient');
  const appointments = page.locator('#appointments');
  await expect(appointments.getByText('Synthetic follow-up')).toBeVisible();
  await appointments.locator('summary').click();
  await expect(appointments.getByText('30 minutes')).toBeVisible();
  await expect(appointments.getByText('Test Hospital')).toBeVisible();
  await expect(appointments.getByText('Cardiology')).toBeVisible();
  await appointments.getByRole('tab', { name: /Appointment history/ }).click();
  await expect(appointments.getByText('Synthetic previous visit')).toBeVisible();
  await expect(appointments.getByText('Synthetic follow-up')).toHaveCount(0);
  await appointments.getByRole('button', { name: 'Refresh appointments' }).click();
  await expect(appointments.getByText('Synthetic previous visit')).toBeVisible();
  expect(state.requests.filter((r) => r.name === 'appointments').every((r) => r.method === 'GET')).toBe(true);
  await noPageOverflow(page);
});

test('appointment errors recover on refresh', async ({ page }) => {
  const state = await mockApp(page, 'patient', { failAppointments: true });
  await page.goto('/patient');
  await expect(page.locator('#appointments').getByRole('alert')).toContainText('Appointments unavailable');
  state.failAppointments = false;
  await page.getByRole('button', { name: 'Refresh appointments' }).click();
  await expect(page.locator('#appointments').getByText('Synthetic follow-up')).toBeVisible();
});

test('old search links redirect with query and preserve logged record access', async ({ page }) => {
  const state = await mockApp(page);
  await page.goto('/doctor/search?q=MEDIS-P-000123&priority=attention');
  await expect(page).toHaveURL(/\/doctor\/patients\?q=MEDIS-P-000123&priority=attention/);
  await expect(page.getByRole('heading', { name: 'My patients', exact: true })).toBeVisible();
  await expect(page.getByText('Opening the record grants access', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Open record', exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/doctor/patients/${PATIENT}$`));
  expect(state.requests.some((r) => r.name === 'log_patient_access' && r.body?.p_action === 'opened_patient_record')).toBe(true);
});

test('merged patient panel has one search and filters existing patients by name or ID', async ({ page }) => {
  const state = await mockApp(page);
  await page.goto('/doctor/patients');
  await expect(page.getByRole('textbox')).toHaveCount(1);
  await expect(page.locator('nav').getByRole('link', { name: 'Search Patient', exact: true })).toHaveCount(0);
  const input = page.getByRole('textbox', { name: 'Patient ID', exact: true });
  const table = page.getByRole('table');
  await expect(table.getByText('Test Patient', { exact: true })).toBeVisible();
  await input.fill('unmatched name');
  await expect(table).toHaveCount(0);
  await input.fill('test patient');
  await expect(table.getByText('Test Patient', { exact: true })).toBeVisible();
  await input.fill('000123');
  await expect(table.getByText('Test Patient', { exact: true })).toBeVisible();
  expect(state.requests.filter((r) => r.name === 'search_patient_by_display_id')).toHaveLength(0);
  await noPageOverflow(page);
});

test('patient search validates, reports no match, clears, and keeps the priority filter', async ({ page }) => {
  const state = await mockApp(page);
  await page.goto('/doctor/patients?priority=attention');
  const input = page.getByRole('textbox', { name: 'Patient ID', exact: true });
  await input.fill('invalid');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a full Patient ID');
  expect(state.requests.filter((r) => r.name === 'search_patient_by_display_id')).toHaveLength(0);
  await input.fill('MEDIS-P-999999');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('No patient with ID', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page).toHaveURL(/priority=attention$/);
  await noPageOverflow(page);
});

test('six patient tabs replace content, retain direct links, and support keyboard navigation', async ({ page }) => {
  await mockApp(page);
  await page.goto(`/doctor/patients/${PATIENT}`);
  const tabs = page.getByRole('tablist', { name: 'Patient record', exact: true });
  await expect(tabs.getByRole('tab')).toHaveCount(6);
  await expect(page.getByRole('heading', { name: 'Vitals & lifestyle' })).toBeVisible();
  await tabs.getByRole('tab', { name: 'Add Record', exact: true }).click();
  await expect(page.getByLabel('Medicine name')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Vitals & lifestyle' })).toHaveCount(0);
  await tabs.getByRole('tab', { name: 'Visit History', exact: true }).click();
  await expect(page.getByText('Synthetic diagnosis', { exact: true })).toBeVisible();
  await tabs.getByRole('tab', { name: 'Prescriptions', exact: true }).click();
  await expect(page.getByText('Synthetic medicine', { exact: false })).toBeVisible();
  await expect(page.getByText('Issued', { exact: true })).toBeVisible();
  await page.reload();
  await expect(tabs.getByRole('tab', { name: 'Prescriptions', exact: true })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'Prescriptions', exact: true }).focus();
  await page.keyboard.press('Home');
  await expect(tabs.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await noPageOverflow(page);
});

test('sticky layers remain opaque and accessible after scrolling', async ({ page }, testInfo) => {
  await mockApp(page);
  await page.goto(`/doctor/patients/${PATIENT}`);
  await expect(page.getByRole('heading', { name: 'AI Insights', exact: false })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 500));
  const layers = await page.evaluate(() => {
    const header = document.querySelector('.app-header');
    const tabs = document.querySelector('.patient-tab-navigation');
    return { headerTop: header.getBoundingClientRect().top, tabsTop: tabs.getBoundingClientRect().top, headerHeight: header.getBoundingClientRect().height,
      headerColor: getComputedStyle(header).backgroundColor, tabsColor: getComputedStyle(tabs).backgroundColor,
      headerZ: Number(getComputedStyle(header).zIndex), tabsZ: Number(getComputedStyle(tabs).zIndex) };
  });
  expect(layers.headerTop).toBe(0);
  expect(layers.tabsTop).toBeCloseTo(layers.headerHeight, 0);
  expect(layers.headerColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(layers.tabsColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(layers.headerZ).toBeGreaterThan(layers.tabsZ);
  await page.screenshot({ path: testInfo.outputPath('patient-dashboard.png'), fullPage: false });
  await noPageOverflow(page);
});

test('ECG and medical documents retain analysis, secure viewing, extraction and filters', async ({ page }) => {
  const state = await mockApp(page);
  await page.goto(`/doctor/patients/${PATIENT}?tab=ecg`);
  await expect(page.getByRole('heading', { name: 'Available ECG reports' })).toBeVisible();
  await page.getByRole('button', { name: 'Re-run analysis', exact: true }).click();
  await expect.poll(() => state.requests.some((r) => r.name === '/ai/ecg/document/ecg-doc')).toBe(true);
  await page.getByRole('tab', { name: 'Medical Documents', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search medical documents' }).fill('synthetic-lab');
  await expect(page.getByText('synthetic-ecg.pdf', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Extract values (AI)' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Synthetic LDL 120')).toBeVisible();
  await expect(page.getByRole('button', { name: /Apply selected/ })).toHaveCount(0);
  const layer = await page.getByRole('dialog').evaluate((e) => Number(getComputedStyle(e).zIndex));
  expect(layer).toBeGreaterThan(30);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await noPageOverflow(page);
});

test('draft deletion confirms, retains failed rows, and updates count only after success', async ({ page }) => {
  const state = await mockApp(page, 'doctor', { failDelete: true });
  await page.goto('/doctor/drafts');
  await expect(page.getByRole('heading', { name: '1 unfinished' })).toBeVisible();
  await expect(page.getByText('MEDIS-V-000002', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Delete draft', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('This action cannot be undone.');
  await dialog.getByRole('button', { name: 'Keep draft' }).click();
  expect(state.requests.filter((r) => r.name === 'delete_own_draft')).toHaveLength(0);
  await page.getByRole('button', { name: 'Delete draft', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete draft', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Draft deletion rejected');
  expect(state.consultations.some((d) => d.id === DRAFT)).toBe(true);
  await dialog.getByRole('button', { name: 'Keep draft' }).click();
  await expect(page.getByRole('heading', { name: '1 unfinished' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete draft', exact: true }).click();
  state.failDelete = false;
  await dialog.getByRole('button', { name: 'Delete draft', exact: true }).click();
  await expect(page.getByRole('heading', { name: '0 unfinished' })).toBeVisible();
  expect(state.consultations.some((d) => d.id === FINAL)).toBe(true);
  expect(state.requests.filter((r) => r.name === 'delete_own_draft').every((r) => r.body.p_consultation_id === DRAFT)).toBe(true);
  expect(state.requests.some((r) => r.name === 'consultations' && r.method === 'DELETE')).toBe(false);
});

test('PCE requires explicit choices and does not calculate for known ASCVD', async ({ page }) => {
  const state = await mockApp(page);
  await page.goto(`/doctor/patients/${PATIENT}`);
  await page.getByRole('button', { name: 'Calculate', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Calculate', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Male', exact: true }).click();
  await dialog.getByRole('button', { name: 'White', exact: true }).click();
  await dialog.getByLabel('Total cholesterol (mg/dL)', { exact: true }).fill('200');
  await dialog.getByLabel('HDL (mg/dL)', { exact: true }).fill('50');
  await dialog.getByLabel('Systolic BP (mmHg)', { exact: true }).fill('130');
  for (const legend of ['On BP treatment?', 'Diabetes?', 'Current smoker?']) await dialog.locator('fieldset').filter({ has: page.locator('legend', { hasText: legend }) }).getByRole('button', { name: 'No', exact: true }).click();
  await dialog.locator('fieldset').filter({ has: page.locator('legend', { hasText: 'Known heart disease or stroke' }) }).getByRole('button', { name: 'Yes', exact: true }).click();
  await dialog.getByLabel('Values measured on').fill(new Date().toISOString().slice(0, 10));
  await dialog.getByRole('button', { name: 'Calculate', exact: true }).click();
  await expect(page.getByText('Not applicable: patient has known ASCVD.', { exact: true })).toBeVisible();
  const request = state.requests.find((r) => r.name.includes('/longitudinal/') && r.body?.pce_inputs);
  expect(request.body.pce_inputs.known_ascvd).toBe(true);
});

test('notifications navigate and chart readings remain keyboard accessible without missing-value zeros', async ({ page }) => {
  const state = await mockApp(page, 'patient');
  await page.goto('/patient');
  await page.getByRole('button', { name: 'Notifications, 1 unread' }).click();
  await page.getByRole('button', { name: /Appointment scheduled/ }).click();
  await expect(page).toHaveURL(/\/patient#appointments$/);
  await expect(page.getByRole('button', { name: 'Notifications, 0 unread' })).toBeVisible();
  expect(state.requests.some((r) => r.name === 'notifications' && r.method === 'PATCH')).toBe(true);
});

test('trend data skips missing values and exposes accessible readings', async ({ page }) => {
  await mockApp(page);
  await page.goto(`/doctor/patients/${PATIENT}`);
  await page.getByText('View measurement data', { exact: true }).click();
  const dataTable = page.locator('details').filter({ hasText: 'View measurement data' });
  await expect(dataTable.locator('tbody tr')).toHaveCount(2);
  await expect(dataTable).toContainText('120 mmHg');
  await expect(dataTable).toContainText('140 mmHg');
  const point = page.locator('circle[role="img"]').first();
  await point.focus();
  await expect(page.getByRole('status').filter({ hasText: 'Systolic BP: 120 mmHg' })).toBeVisible();
});

test('doctor signup submits validated professional metadata', async ({ page }) => {
  const state = await mockApp(page, 'anonymous');
  await page.goto('/register');
  await page.getByRole('radio', { name: "I'm a doctor" }).click();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByText('Full name is required.', { exact: true })).toBeVisible();
  await page.getByLabel('Full name', { exact: true }).fill('New Test Doctor');
  await page.getByLabel('Email', { exact: true }).fill('new-doctor@example.test');
  await page.getByLabel('Password', { exact: true }).fill('synthetic-secret');
  await page.getByLabel('Hospital', { exact: true }).click();
  await page.getByRole('option', { name: 'Test Hospital, Test City' }).click();
  await page.getByLabel('Specialization', { exact: true }).fill('Cardiology');
  await page.getByLabel('Qualification', { exact: true }).fill('MD');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  expect(state.requests.find((r) => r.name === 'signup').body.data).toMatchObject({ role: 'doctor', full_name: 'New Test Doctor', specialization: 'Cardiology', qualification: 'MD' });
});

test('record forms save through existing tables and warn before losing edits', async ({ page }) => {
  const state = await mockApp(page);
  await page.goto(`/doctor/patients/${PATIENT}?tab=add-record`);
  await page.getByLabel('Medicine name', { exact: true }).fill('Synthetic new medication');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page.getByLabel('Medicine name', { exact: true })).toHaveValue('Synthetic new medication');
  await page.getByLabel('Dosage', { exact: true }).fill('5 mg');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.requests.some((r) => r.name === 'current_medications' && r.method === 'POST' && r.body.medicine_name === 'Synthetic new medication' && r.body.patient_id === PATIENT)).toBe(true);
  await expect(page.getByText('Added to record', { exact: true })).toBeVisible();
});

test('finalized consultations and issued prescriptions remain read only', async ({ page }) => {
  const state = await mockApp(page);
  await page.goto(`/doctor/consultations/${FINAL}`);
  await expect(page.getByRole('heading', { name: 'Consultation', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Finalize consultation', exact: true })).toHaveCount(0);
  await expect(page.locator('fieldset[disabled]')).toHaveCount(1);
  expect(state.requests.some((r) => r.name === 'consultations' && r.method === 'PATCH')).toBe(false);
});
