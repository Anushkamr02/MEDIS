import { test, expect } from '@playwright/test';
import { mockApp, PATIENT, DRAFT } from './fixtures';

for (const blankMedicationRow of [false, true]) {
  test(`profile setup completes without medication (${blankMedicationRow ? 'blank row' : 'no rows'})`, async ({ page }) => {
    const state = await mockApp(page, 'patient');
    let savedProfile = null;
    await page.route('**/rest/v1/patient_profiles**', async (route) => {
      if (route.request().method() === 'POST') {
        savedProfile = route.request().postDataJSON();
        await route.fulfill({ status: 201, contentType: 'application/json', body: 'null' });
      } else {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(savedProfile ? [savedProfile] : []) });
      }
    });
    await page.goto('/patient');
    await expect(page.getByText("You haven't completed your profile yet.", { exact: false })).toBeVisible();
    await page.getByRole('link', { name: 'Fill it in now' }).click();
    await expect(page.getByRole('heading', { name: 'Tell us about yourself' })).toBeVisible();
    if (blankMedicationRow) await page.getByRole('button', { name: 'Add medication' }).click();
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL('/patient');
    await expect(page.getByRole('heading', { name: 'Health Overview' })).toBeVisible();
    await expect(page.getByText("You haven't completed your profile yet.", { exact: false })).toHaveCount(0);
    expect(savedProfile.id).toBe(PATIENT);
    expect(state.requests.filter((r) => r.name === 'current_medications' && r.method === 'POST')).toHaveLength(0);
    await page.goto('/patient/profile');
    await expect(page.getByRole('heading', { name: 'Personal details' })).toBeVisible();
    await expect(page.getByText('Your profile is incomplete.', { exact: true })).toHaveCount(0);
  });
}

test('a partially entered medication still needs a name', async ({ page }) => {
  const state = await mockApp(page, 'patient');
  await page.goto('/patient/onboarding');
  await page.getByRole('button', { name: 'Add medication' }).click();
  await page.getByRole('textbox', { name: 'Dosage', exact: true }).fill('5 mg');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toContainText('Each new medication needs a name.');
  expect(state.requests.some((r) => r.name === 'patient_profiles' && r.method === 'POST')).toBe(false);
});

test('drafts retain a resume link alongside deletion', async ({ page }) => {
  await mockApp(page);
  await page.goto('/doctor/drafts');
  await expect(page.getByRole('link', { name: 'Resume', exact: true })).toHaveAttribute('href', `/doctor/consultations/${DRAFT}`);
  await expect(page.getByRole('button', { name: 'Delete draft', exact: true })).toBeVisible();
});
