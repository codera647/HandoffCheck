import { expect, it } from 'vitest';
import { emailConfigured, sendReminderEmail } from '../shared/reminder-email';
import { reminderInputSchema } from '../shared/reminders';
import { ids } from './fixtures';

const config = { key: 'synthetic-secret', from: 'HandoffCheck <reminders@example.com>' };
const payload = {
  to: 'reviewer@example.com',
  title: 'CSV export\nReminder',
  requestId: ids.workspace,
  revision: 3,
};
it('sends only a request link to one verified destination with a stable provider key', async () => {
  const bodies: string[] = [],
    keys: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    expect(url).toBe('https://api.resend.com/emails');
    bodies.push(String(init?.body));
    keys.push(new Headers(init?.headers).get('Idempotency-Key')!);
    return new Response(JSON.stringify({ id: 'synthetic-message' }));
  };
  await sendReminderEmail(payload, ids.author, config, transport);
  await sendReminderEmail(payload, ids.author, config, transport);
  expect(bodies[0]).toBe(bodies[1]);
  expect(keys).toEqual([`handoff-reminder-${ids.author}`, `handoff-reminder-${ids.author}`]);
  const body = JSON.parse(bodies[0]);
  expect(body.to).toEqual([payload.to]);
  expect(body.subject).not.toContain('\n');
  expect(body.text).toContain(
    `https://handoffcheck.vercel.app/requests/${ids.workspace}?tab=approvals`,
  );
  expect(bodies[0]).not.toContain(config.key);
  expect(body).not.toHaveProperty('html');
});
it.each([
  [403, false],
  [429, true],
  [503, true],
])(
  'sanitizes email HTTP %s failures with bounded retry classification',
  async (status, retryable) => {
    await expect(
      sendReminderEmail(
        payload,
        ids.author,
        config,
        async () =>
          new Response('synthetic-secret private provider error', { status: Number(status) }),
      ),
    ).rejects.toMatchObject({ retryable });
    try {
      await sendReminderEmail(
        payload,
        ids.author,
        config,
        async () => new Response('synthetic-secret', { status: Number(status) }),
      );
    } catch (error) {
      expect(String(error)).not.toContain('synthetic-secret');
    }
  },
);
it('reports uncertain transport failure for an idempotent retry and blocks malformed sender settings', async () => {
  await expect(
    sendReminderEmail(payload, ids.author, config, async () => {
      throw new Error('raw transport');
    }),
  ).rejects.toMatchObject({ retryable: true });
  expect(emailConfigured(config)).toBe(true);
  expect(emailConfigured({ ...config, from: 'sender@example.com\nBcc: other@example.com' })).toBe(
    false,
  );
  expect(emailConfigured({ from: config.from })).toBe(false);
});
it('validates schedule bounds and requires explicit email opt-in in the stored command', () => {
  const base = {
    enabled: true,
    emailEnabled: true,
    intervalMinutes: 15,
    expectedRevision: 1,
    expectedVersion: 0,
  };
  expect(reminderInputSchema.safeParse(base).success).toBe(true);
  for (const intervalMinutes of [0, 14, 10081, 15.5])
    expect(reminderInputSchema.safeParse({ ...base, intervalMinutes }).success).toBe(false);
  expect(reminderInputSchema.safeParse({ ...base, recipientId: ids.admin }).success).toBe(false);
});
