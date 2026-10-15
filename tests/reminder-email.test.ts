import { expect, it } from 'vitest';
import { sendReminderEmail } from '../shared/reminder-email';
import { reminderInputSchema } from '../shared/reminders';
import { ids } from './fixtures';

const payload = {
  from: 'author@example.com',
  to: 'reviewer@example.com',
  title: 'CSV export\nReminder',
  requestId: ids.workspace,
  revision: 3,
};
it('sends a MIME message directly from the author to one reviewer without exposing credentials', async () => {
  await sendReminderEmail(payload, ids.author, 'synthetic-access-token', async (url, init) => {
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBeNull();
    const raw = JSON.parse(String(init?.body)).raw;
    const mime = atob(raw.replaceAll('-', '+').replaceAll('_', '/'));
    expect(mime).toContain(`From: ${payload.from}\r\nTo: ${payload.to}`);
    expect(mime).toContain(`Message-ID: <handoff-reminder-${ids.author}@handoffcheck.vercel.app>`);
    const [headers, body] = mime.split('\r\n\r\n');
    expect(atob(headers.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)![1])).toBe(
      'Approval reminder: CSV export Reminder',
    );
    expect(atob(body.replaceAll('\r\n', ''))).toContain(
      `https://handoffcheck.vercel.app/requests/${ids.workspace}?tab=approvals`,
    );
    expect(mime).not.toContain('synthetic-access-token');
    return new Response('{}');
  });
});
it('folds long Unicode subjects into valid encoded words without corrupting characters', async () => {
  const title = '例'.repeat(20) + '😀'.repeat(45);
  await sendReminderEmail({ ...payload, title }, ids.author, 'synthetic', async (_url, init) => {
    const mime = atob(JSON.parse(String(init?.body)).raw.replaceAll('-', '+').replaceAll('_', '/'));
    const words = [...mime.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
    expect(words.length).toBeGreaterThan(1);
    expect(words.every((word) => word[0].length <= 75)).toBe(true);
    const bytes = Uint8Array.from(words.map((word) => atob(word[1])).join(''), (c) =>
      c.charCodeAt(0),
    );
    expect(new TextDecoder().decode(bytes)).toBe(`Approval reminder: ${title}`);
    return new Response('{}');
  });
});
it.each([
  [403, false, false],
  [429, true, false],
  [503, false, true],
])(
  'classifies Gmail HTTP %s without unsafe ambiguous retries',
  async (status, retryable, uncertain) => {
    await expect(
      sendReminderEmail(
        payload,
        ids.author,
        'synthetic-access-token',
        async () => new Response('private provider error', { status: Number(status) }),
      ),
    ).rejects.toMatchObject({ retryable, uncertain });
  },
);
it('does not retry a possibly accepted message and rejects header injection before network use', async () => {
  await expect(
    sendReminderEmail(payload, ids.author, 'synthetic', async () => {
      throw new Error('raw private transport error');
    }),
  ).rejects.toMatchObject({ retryable: false, uncertain: true });
  let calls = 0;
  await expect(
    sendReminderEmail(
      { ...payload, from: 'author@example.com\r\nBcc: other@example.com' },
      ids.author,
      'synthetic',
      async () => {
        calls++;
        return new Response('{}');
      },
    ),
  ).rejects.toThrow();
  expect(calls).toBe(0);
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
