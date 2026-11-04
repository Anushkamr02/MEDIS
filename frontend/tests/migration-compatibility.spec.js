import { test, expect } from '@playwright/test';
import { mockApp, DOCTOR } from './fixtures';

for (const scenario of ['current schema', 'missing file size', 'permission denied', 'another missing column']) {
  test(`document upload handles ${scenario}`, async ({ page }) => {
    const state = await mockApp(page, 'patient');
    const inserts = [];
    await page.route('**/rest/v1/medical_reports**', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const row = route.request().postDataJSON();
      inserts.push(row);
      let error;
      if (scenario === 'missing file size' && 'file_size_bytes' in row) {
        error = { code: 'PGRST204', message: "Could not find the 'file_size_bytes' column of 'medical_reports' in the schema cache" };
      } else if (scenario === 'permission denied') {
        error = { code: '42501', message: 'Upload permission denied' };
      } else if (scenario === 'another missing column') {
        error = { code: 'PGRST204', message: "Could not find the 'category' column of 'medical_reports' in the schema cache" };
      }
      await route.fulfill({ status: error ? 400 : 201, contentType: 'application/json', body: JSON.stringify(error ?? null) });
    });
    await page.goto('/patient/documents');
    await page.getByRole('button', { name: 'Upload document' }).click();
    await page.getByText('Select type', { exact: true }).click();
    await page.getByRole('option', { name: 'Blood Report', exact: true }).click();
    const buffer = Buffer.from('%PDF-1.4 synthetic report');
    await page.getByLabel('File (PDF or image)').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer });
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    if (scenario === 'permission denied' || scenario === 'another missing column') {
      await expect(page.getByRole('alert')).toContainText(scenario === 'permission denied' ? 'Upload permission denied' : "'category'");
    } else {
      await expect(page.getByText('Report uploaded', { exact: true })).toBeVisible();
    }
    expect(inserts).toHaveLength(scenario === 'missing file size' ? 2 : 1);
    expect(inserts[0].file_size_bytes).toBe(buffer.length);
    if (scenario === 'missing file size') {
      const { file_size_bytes, ...expected } = inserts[0];
      expect(inserts[1]).toEqual(expected);
    }
    expect(state.requests.filter((r) => r.method === 'POST' && r.name.endsWith('-report.pdf'))).toHaveLength(1);
  });
}

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
