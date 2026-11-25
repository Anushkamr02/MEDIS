import { test, expect } from '@playwright/test';
import { mockApp, PATIENT } from './fixtures';

// chat_messages (v5) with the v16 feedback column, plus the /ai/chat reply.
const at = '2026-11-20T10:00:00Z';
const reply = {
  id: 'chat-2', patient_id: PATIENT, role: 'assistant', created_at: at, feedback: null, is_emergency: false,
  content: 'Your LDL was 140 mg/dL at your visit on 10 January 2026.',
  sources: [{ label: 'Visit MEDIS-V-000002', anchor: 'visit-MEDIS-V-000002' }],
};
const question = { id: 'chat-1', patient_id: PATIENT, role: 'user', content: 'What was my latest LDL?', created_at: at, is_emergency: false };

// Registered after mockApp so these routes take precedence over its defaults.
async function mockChat(page, { legacy = false } = {}) {
  const state = { rpcs: [], messages: [] };
  const json = (route, data, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

  await page.route('**/rest/v1/chat_messages**', (route) => {
    const url = new URL(route.request().url());
    const wantsFeedback = (url.searchParams.get('select') ?? '').includes('feedback');
    if (legacy && wantsFeedback) {
      return json(route, { code: '42703', message: 'column chat_messages.feedback does not exist' }, 400);
    }
    if (route.request().method() === 'DELETE') {
      state.messages = [];
      return json(route, null, 204);
    }
    return json(route, state.messages);
  });

  await page.route('**/rest/v1/rpc/rate_chat_message', (route) => {
    const body = route.request().postDataJSON();
    if (legacy) {
      return json(route, { code: 'PGRST202', message: 'Could not find the function public.rate_chat_message' }, 404);
    }
    state.rpcs.push(body);
    return json(route, { ...reply, feedback: body.p_feedback });
  });

  await page.route('**/ai/chat', (route) => {
    state.messages = [question, reply];
    return json(route, { question, reply, suggest_contact_doctor: false, emergency_notice: null });
  });
  return state;
}

async function ask(page) {
  await page.getByRole('button', { name: 'Ask MEDIS' }).first().click();
  const drawer = page.getByRole('dialog');
  await drawer.getByLabel('Your question').fill('What was my latest LDL?');
  await drawer.getByRole('button', { name: 'Send' }).click();
  await expect(drawer.getByText(/Your LDL was 140/)).toBeVisible();
  return drawer;
}

test('a source chip opens the visit it cites and highlights it', async ({ page }) => {
  await mockApp(page, 'patient');
  await mockChat(page);
  await page.goto('/patient');
  const drawer = await ask(page);

  await drawer.getByRole('button', { name: 'Visit MEDIS-V-000002' }).click();
  // The chip leaves the dashboard for the page that lists that visit.
  await expect(page).toHaveURL(/\/patient\/visits#visit-MEDIS-V-000002$/);
  const cited = page.locator('#visit-MEDIS-V-000002');
  await expect(cited).toBeVisible();
  await expect(cited).toHaveClass(/source-highlight/);
  // The drawer covers the page on a phone, so it closes first.
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('feedback on a reply is saved, and clicking it again clears it', async ({ page }) => {
  await mockApp(page, 'patient');
  const chat = await mockChat(page);
  await page.goto('/patient');
  const drawer = await ask(page);

  const helpful = drawer.getByRole('button', { name: 'Helpful', exact: true });
  await helpful.click();
  await expect(helpful).toHaveAttribute('aria-pressed', 'true');
  expect(chat.rpcs).toEqual([{ p_message_id: 'chat-2', p_feedback: 'up' }]);

  await helpful.click();
  await expect(helpful).toHaveAttribute('aria-pressed', 'false');
  expect(chat.rpcs.at(-1)).toEqual({ p_message_id: 'chat-2', p_feedback: null });

  const notHelpful = drawer.getByRole('button', { name: 'Not helpful' });
  await notHelpful.click();
  expect(chat.rpcs.at(-1)).toEqual({ p_message_id: 'chat-2', p_feedback: 'down' });
});

test('on a database without migration v16 the chat works without rating buttons', async ({ page }) => {
  await mockApp(page, 'patient');
  await mockChat(page, { legacy: true });
  await page.goto('/patient');
  const drawer = await ask(page);

  await expect(drawer.getByRole('button', { name: 'Helpful', exact: true })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'Not helpful' })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'Visit MEDIS-V-000002' })).toBeVisible();
});
