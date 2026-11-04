import { test, expect } from '@playwright/test';
import { mockApp, DOCTOR } from './fixtures';

test('older migrations show a doctor summary when event RPC is absent', async ({ page }) => {
  await mockApp(page, 'patient', {
    missingDashboardRpcs: true,
    accessSummary: [{ doctor_id: DOCTOR, doctor_name: 'Legacy Doctor', doctor_display_id: 'MEDIS-D-000001', first_access: '2026-01-01T10:00:00Z', last_accessed: '2026-01-10T10:00:00Z', visit_count: 2 }],
  });
  await page.goto('/patient/access');
  await expect(page.getByText('Access summary by doctor.', { exact: false })).toBeVisible();
  await expect(page.getByText('Dr. Legacy Doctor').first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('Search access history by doctor').fill('Nobody');
  await expect(page.getByText('No access summaries match these filters.')).toBeVisible();
});

test('older migrations open visit details using existing table queries', async ({ page }) => {
  await mockApp(page, 'patient', { missingDashboardRpcs: true });
  // A patient cannot SELECT an unshared consultation under the older RLS.
  await page.route('**/rest/v1/consultations?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }));
  await page.goto('/patient/visits');
  await page.getByRole('button', { name: 'View details' }).nth(1).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('MEDIS-V-000002')).toBeVisible();
  await expect(dialog.getByText('has not shared the clinical details', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByText('Synthetic diagnosis')).toHaveCount(0);
});
