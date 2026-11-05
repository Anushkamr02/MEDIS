import { test, expect } from '@playwright/test';
import { mockApp, PATIENT } from './fixtures';

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.runtimeErrors = errors;
});
test.afterEach(async ({ page }) => {
  expect(page.runtimeErrors, 'No unhandled browser errors').toEqual([]);
});

async function noPageOverflow(page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    'The page must not scroll sideways'
  ).toBe(true);
}

/** The scrollable body of the panel whose header has this title. */
function panelBody(page, title) {
  return page.locator('section', { has: page.getByRole('heading', { name: title }) }).locator('.medis-scroll').first();
}

// ----------------------------------------------------------------
// Doctor record: tabs and the constrained Visit History panel
// ----------------------------------------------------------------

test('the AI check badge opens its review reason and evidence in Patient Overview', async ({ page }) => {
  const state = await mockApp(page);
  state.assessment.report.overall_assessment = 'Blood pressure has increased across recorded visits.';
  state.assessment.report.clinical_flags = [{
    metric: 'systolic_bp', severity: 'REVIEW', message: 'Systolic blood pressure increased to 140 mmHg.',
    evidence: [{ visit_id: 'MEDIS-V-000002', date: '2026-01-10', value: 120 }],
  }];
  state.assessment.report.recommendations = ['Review repeat blood pressure measurements.'];
  await page.goto('/doctor/patients');
  const review = page.getByRole('link', { name: 'Review AI check for Test Patient: Needs review', exact: true });
  await expect(review).toBeVisible();
  await review.click();
  await expect(page).toHaveURL(`/doctor/patients/${PATIENT}?review=ai#ai-review`);
  await expect(page.getByRole('tab', { name: 'Patient Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#ai-review')).toBeFocused();
  await expect(page.locator('#ai-review')).toContainText('Blood pressure has increased across recorded visits.');
  await expect(page.locator('#ai-review')).toContainText('Systolic blood pressure increased to 140 mmHg.');
  await page.getByRole('button', { name: 'Show evidence' }).click();
  await expect(page.locator('#ai-review').getByRole('button', { name: 'MEDIS-V-000002', exact: true })).toBeVisible();
  await expect(page.getByText('Review repeat blood pressure measurements.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh analysis', exact: true })).toBeVisible();
});

test('the doctor patient record has the five record sections and keeps direct links', async ({ page }) => {
  await mockApp(page);
  await page.goto(`/doctor/patients/${PATIENT}`);

  const tabs = page.getByRole('tablist', { name: 'Patient record' });
  for (const label of ['Patient Overview', 'ECG Analysis', 'Add Record & Medical Documents', 'Visit History', 'Prescriptions']) {
    await expect(tabs.getByRole('tab', { name: label })).toBeVisible();
  }
  await expect(tabs.getByRole('tab', { name: 'Patient Overview' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Vitals & lifestyle' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Latest ECG analysis', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Trends', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Findings to review', exact: true })).toBeVisible();
  await expect(page.getByLabel('Digital ECG files')).toHaveCount(0);

  await tabs.getByRole('tab', { name: 'ECG Analysis', exact: true }).click();
  await expect(page).toHaveURL(/tab=ecg/);
  await expect(page.getByRole('heading', { name: 'Latest ECG analysis', exact: true })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Trends', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Findings to review', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Digital ECG files')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Available ECG reports', exact: true })).toBeVisible();
  await noPageOverflow(page);

  await page.reload();
  await expect(tabs.getByRole('tab', { name: 'ECG Analysis', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Trends', exact: true })).toHaveCount(0);
  await tabs.getByRole('tab', { name: 'Patient Overview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Trends', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Latest ECG analysis', exact: true })).toHaveCount(0);

  await tabs.getByRole('tab', { name: 'Visit History' }).click();
  await expect(page).toHaveURL(/tab=visits/);
  await expect(page.getByRole('heading', { name: 'Vitals & lifestyle' })).toHaveCount(0);

  // A shared link opens on the same section.
  await page.reload();
  await expect(tabs.getByRole('tab', { name: 'Visit History' })).toHaveAttribute('aria-selected', 'true');
  await noPageOverflow(page);
});

test('visit history stays inside its panel with many records and long text', async ({ page }) => {
  await mockApp(page);
  await page.goto(`/doctor/patients/${PATIENT}?tab=visits`);

  const body = panelBody(page, /Visit history/);
  await expect(body).toBeVisible();

  const box = await body.evaluate((el) => {
    const panel = el.closest('section');
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      panelHeight: panel.getBoundingClientRect().height,
      panelMax: parseFloat(getComputedStyle(panel).maxHeight),
      overflowX: getComputedStyle(el).overflowX,
      overflowY: getComputedStyle(el).overflowY,
      panelOverflow: getComputedStyle(panel).overflow,
    };
  });

  // The content is taller than the panel, but the panel respects its cap.
  expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
  expect(box.panelHeight).toBeLessThanOrEqual(box.panelMax + 1);
  expect(box.overflowY).toBe('auto');
  expect(box.overflowX).toBe('hidden');
  expect(box.panelOverflow).toBe('hidden');
  // Long diagnosis text wraps rather than widening the panel.
  expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
  await noPageOverflow(page);
});

test('the panel header stays put while the records scroll, by wheel and by keyboard', async ({ page }) => {
  await mockApp(page);
  await page.goto(`/doctor/patients/${PATIENT}?tab=visits`);

  const body = panelBody(page, /Visit history/);
  // Measured against the panel, not the viewport: the page may scroll too,
  // what must not move is the header relative to the records below it.
  const headerOffset = () =>
    body.evaluate((el) => {
      const panel = el.closest('section');
      const header = panel.querySelector('h2');
      return Math.round(header.getBoundingClientRect().top - panel.getBoundingClientRect().top);
    });

  const before = await headerOffset();

  await body.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await headerOffset()).toBe(before);

  // The same container is reachable and scrollable from the keyboard.
  await body.evaluate((el) => {
    el.scrollTop = 0;
    el.focus();
  });
  expect(await body.evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press('PageDown');
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test('a panel beside visit history keeps its own size', async ({ page }) => {
  await mockApp(page, 'patient');
  await page.goto('/patient');
  await expect(page.getByRole('heading', { name: 'Health overview' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();

  const sizes = await page.evaluate(() => {
    const panels = [...document.querySelectorAll('section')].filter((s) => s.querySelector('.medis-scroll'));
    return panels.map((p) => p.getBoundingClientRect().height);
  });
  // Health overview and Recent activity sit side by side with the same cap.
  expect(sizes.length).toBeGreaterThanOrEqual(2);
  for (const height of sizes) expect(height).toBeLessThanOrEqual(30 * 16 + 1);
  await noPageOverflow(page);
});

// ----------------------------------------------------------------
// Visit details modal
// ----------------------------------------------------------------

test('view details opens the full visit, closes on Escape and restores focus', async ({ page }) => {
  await mockApp(page);
  await page.goto(`/doctor/patients/${PATIENT}?tab=visits`);

  const trigger = page.getByRole('button', { name: 'View details' }).nth(1);
  await trigger.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('MEDIS-V-000002').first()).toBeVisible();
  await expect(dialog.getByText('Cardiology')).toBeVisible();
  await expect(dialog.getByText('Synthetic chest discomfort')).toBeVisible();
  await expect(dialog.getByText('Synthetic diagnosis')).toBeVisible();
  await expect(dialog.getByText('Synthetic medicine', { exact: false })).toBeVisible();
  await expect(dialog.getByText('synthetic-lab.pdf')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('a patient sees no clinical detail for a visit that was not shared', async ({ page }) => {
  const state = await mockApp(page, 'patient');
  state.visits = state.visits.map((v) =>
    v.visit_id === 'MEDIS-V-000002' ? { ...v, is_shared_with_patient: false, final_diagnosis: null, reason: null } : v
  );
  await page.goto('/patient/visits');

  await page.getByRole('button', { name: 'View details' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('has not shared the clinical details', { exact: false })).toBeVisible();
  await expect(dialog.getByText('Synthetic diagnosis')).toHaveCount(0);
});

// ----------------------------------------------------------------
// Patient navigation
// ----------------------------------------------------------------

test('patient navigation shows five sections, defaults to Dashboard and switches without reloading', async ({ page, viewport }) => {
  // Narrow screens get the drawer instead of the row; covered by the next test.
  test.skip(viewport.width < 768, 'The section row is replaced by a drawer below md');
  await mockApp(page, 'patient');
  await page.goto('/patient');

  const nav = page.getByRole('navigation', { name: 'Patient sections' });
  for (const label of ['Dashboard', 'Prescriptions', 'Medical Documents', 'Visit History', 'Doctors Who Accessed Profile']) {
    await expect(nav.getByRole('link', { name: label })).toBeVisible();
  }
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: /Hello,/ })).toBeVisible();

  // A marker on window survives a client-side route change but not a reload.
  await page.evaluate(() => { window.__medisNoReload = true; });
  await nav.getByRole('link', { name: 'Prescriptions' }).click();
  await expect(page).toHaveURL(/\/patient\/prescriptions$/);
  await expect(page.getByRole('heading', { name: 'Prescriptions', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__medisNoReload)).toBe(true);
  await expect(nav.getByRole('link', { name: 'Prescriptions' })).toHaveAttribute('aria-current', 'page');

  await nav.getByRole('link', { name: 'Doctors Who Accessed Profile' }).click();
  await expect(page).toHaveURL(/\/patient\/access$/);
  expect(await page.evaluate(() => window.__medisNoReload)).toBe(true);
  await noPageOverflow(page);
});

test('narrow screens reach the same sections through the drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApp(page, 'patient');
  await page.goto('/patient');

  await expect(page.getByRole('navigation', { name: 'Patient sections' }).getByRole('link', { name: 'Dashboard' })).toBeHidden();
  await page.getByRole('button', { name: 'Sections' }).click();
  const drawer = page.getByRole('dialog', { name: 'Patient sections' });
  await expect(drawer.getByRole('link', { name: 'Visit History' })).toBeVisible();
  await drawer.getByRole('link', { name: 'Visit History' }).click();
  await expect(page).toHaveURL(/\/patient\/visits$/);
  await expect(drawer).toHaveCount(0);
  await noPageOverflow(page);
});

test('dashboard quick actions all lead somewhere real', async ({ page }) => {
  await mockApp(page, 'patient');
  await page.goto('/patient');

  await expect(page.getByRole('link', { name: 'View Prescriptions' })).toHaveAttribute('href', '/patient/prescriptions');
  await expect(page.getByRole('link', { name: 'View Medical Documents' })).toHaveAttribute('href', '/patient/documents');
  await expect(page.getByRole('link', { name: 'View Visit History' })).toHaveAttribute('href', '/patient/visits');

  await page.getByRole('button', { name: 'View Appointments' }).click();
  await expect(page.locator('#appointments')).toBeInViewport();
  await page.getByRole('button', { name: 'View ECG Reports' }).click();
  await expect(page.locator('#ecg')).toBeInViewport();
});

test('the dashboard shows the patient identity card from the record', async ({ page }) => {
  await mockApp(page, 'patient');
  await page.goto('/patient');

  const card = page.locator('section').filter({ hasText: 'Your permanent MEDIS Patient ID' }).first();
  await expect(card.getByRole('heading', { name: 'Test Patient' })).toBeVisible();
  await expect(card.getByText('MEDIS-P-000123')).toBeVisible();
  await expect(card.getByText('O+')).toBeVisible();
  await expect(card.getByRole('link', { name: 'Edit profile' })).toHaveAttribute('href', '/patient/onboarding');
});

// ----------------------------------------------------------------
// Prescriptions
// ----------------------------------------------------------------

test('prescriptions filter, open in a modal and offer a download', async ({ page }) => {
  await mockApp(page, 'patient');
  await page.goto('/patient/prescriptions');

  await expect(page.getByText('Synthetic medicine', { exact: false }).first()).toBeVisible();

  await page.getByLabel('Search prescriptions').fill('nothing-matches-this');
  await expect(page.getByText('No prescriptions match these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).first().click();

  await page.getByRole('button', { name: 'View prescription' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Prescription' })).toBeVisible();
  await expect(dialog.getByText('Once daily')).toBeVisible();
  await expect(dialog.getByText('Synthetic instructions')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Download prescription' })).toBeVisible();
  await noPageOverflow(page);
});

// ----------------------------------------------------------------
// Medical documents
// ----------------------------------------------------------------

test('documents list size and type, filter by type, and only offer delete on own uploads', async ({ page }) => {
  const state = await mockApp(page, 'patient');
  await page.goto('/patient/documents');

  await expect(page.getByText('synthetic-ecg.pdf')).toBeVisible();
  await expect(page.getByText('240 KB', { exact: false })).toBeVisible();

  // A patient may delete only the document they uploaded themselves.
  const own = page.locator('li', { hasText: 'synthetic-scan.pdf' }).first();
  const theirs = page.locator('li', { hasText: 'synthetic-ecg.pdf' }).first();
  await expect(own.getByRole('button', { name: 'Delete' })).toBeVisible();
  await expect(theirs.getByRole('button', { name: 'Delete' })).toHaveCount(0);

  await page.getByLabel('Filter by document type').click();
  await page.getByRole('option', { name: 'ECG Reports' }).click();
  await expect(page.getByText('synthetic-lab.pdf')).toHaveCount(0);
  await expect(page.getByText('synthetic-ecg.pdf')).toBeVisible();

  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  page.on('dialog', (d) => d.accept());
  await own.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('synthetic-scan.pdf')).toHaveCount(0);
  expect(state.requests.some((r) => r.name === 'delete_medical_report')).toBe(true);
  await noPageOverflow(page);
});

test('a delete the server refuses leaves the document in place and says why', async ({ page }) => {
  const state = await mockApp(page, 'patient');
  // The document is now owned by someone else, as the database would see it.
  state.documents = state.documents.map((d) => (d.id === 'own-doc' ? { ...d, uploaded_by: 'someone-else' } : d));
  await page.goto('/patient/documents');

  // Nothing offers the delete any more, because this account did not upload it…
  const own = page.locator('li', { hasText: 'synthetic-scan.pdf' }).first();
  await expect(own.getByRole('button', { name: 'Delete' })).toHaveCount(0);

  // …and calling the function anyway is refused by the server, not by the UI.
  const refused = await page.evaluate(async () => {
    const response = await fetch('https://medis-test.supabase.co/rest/v1/rpc/delete_medical_report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ p_report_id: 'own-doc' }),
    });
    return response.status;
  });
  expect(refused).toBe(403);
  await page.reload();
  await expect(page.getByText('synthetic-scan.pdf')).toBeVisible();
});

// ----------------------------------------------------------------
// Doctors who accessed the profile
// ----------------------------------------------------------------

test('access history lists real recorded events and opens one in detail', async ({ page }) => {
  await mockApp(page, 'patient');
  await page.goto('/patient/access');

  await expect(page.getByRole('heading', { name: 'Doctors who accessed your profile' })).toBeVisible();
  await expect(page.getByText('Record opened')).toBeVisible();
  await expect(page.getByText('Document view')).toBeVisible();
  await expect(page.getByText('Showing 1–2 of 2 access records')).toBeVisible();

  await page.getByRole('button', { name: 'View access details' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Recorded by the server on', { exact: false })).toBeVisible();
  await expect(dialog.getByText('MEDIS-D-000001')).toBeVisible();
  await expect(dialog.getByText('Cardiology')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByLabel('Search access history by doctor').fill('Nobody');
  await expect(page.getByText('No recorded access matches these filters.')).toBeVisible();
  await noPageOverflow(page);
});

test('an empty access history says so instead of showing sample activity', async ({ page }) => {
  const state = await mockApp(page, 'patient');
  state.accessEvents = [];
  await page.goto('/patient/access');

  await expect(page.getByText('No doctor access has been recorded for this profile yet.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View access details' })).toHaveCount(0);
});

test('an access history failure is reported and can be retried', async ({ page }) => {
  const state = await mockApp(page, 'patient', { failAccessEvents: true });
  await page.goto('/patient/access');

  await expect(page.getByRole('alert')).toContainText('Access history unavailable');
  state.failAccessEvents = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Record opened')).toBeVisible();
});

test('opening a patient record logs the access through the server function', async ({ page }) => {
  const state = await mockApp(page);
  await page.goto(`/doctor/patients/${PATIENT}`);
  await expect(page.getByRole('heading', { name: 'Test Patient' })).toBeVisible();

  await expect
    .poll(() => state.requests.some((r) => r.name === 'log_patient_access' && r.body?.p_action === 'viewed_patient'))
    .toBe(true);
  // The timestamp is never sent by the browser.
  const logged = state.requests.find((r) => r.name === 'log_patient_access');
  expect(Object.keys(logged.body)).toEqual(['p_patient_id', 'p_action', 'p_metadata']);
  expect(state.requests.some((r) => r.name === 'audit_logs' && r.method === 'POST')).toBe(false);
});
