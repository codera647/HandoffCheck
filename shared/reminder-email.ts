import { z } from 'zod';
import { base64url, GmailFailure } from './gmail.ts';

export const reminderPayloadSchema = z
  .object({
    to: z.email(),
    from: z.email(),
    title: z.string().max(120),
    requestId: z.uuid(),
    revision: z.number().int().positive(),
  })
  .strict();
export type ReminderPayload = z.infer<typeof reminderPayloadSchema>;

function subjectHeader(value: string) {
  const words: string[] = [];
  let chunk = '';
  const encode = (text: string) =>
    `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(text)))}?=`;
  for (const character of value) {
    if (new TextEncoder().encode(chunk + character).length > 42) {
      words.push(encode(chunk));
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) words.push(encode(chunk));
  return words.join('\r\n ');
}

export async function sendReminderEmail(
  input: ReminderPayload,
  deliveryKey: string,
  accessToken: string,
  transport: typeof fetch = fetch,
) {
  const payload = reminderPayloadSchema.parse(input);
  z.uuid().parse(deliveryKey);
  const title = payload.title.replace(/[\r\n\t]+/g, ' ');
  const subject = subjectHeader(`Approval reminder: ${title}`);
  const link = `https://handoffcheck.vercel.app/requests/${payload.requestId}?tab=approvals`;
  const text = `Your approval is still pending for "${title}", revision ${payload.revision}.\n\nReview your assigned stage or request changes:\n${link}\n\nSent by HandoffCheck from the author's connected Gmail account on their selected schedule. Reminders stop after your approval or when the request leaves approval. Use the request discussion for comments.`;
  const message = [
    `From: ${payload.from}`,
    `To: ${payload.to}`,
    `Subject: ${subject}`,
    // Trace identifier only. Gmail does not promise deduplication by Message-ID.
    `Message-ID: <handoff-reminder-${deliveryKey}@handoffcheck.vercel.app>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    btoa(String.fromCharCode(...new TextEncoder().encode(text)))
      .match(/.{1,76}/g)!
      .join('\r\n'),
    '',
  ].join('\r\n');
  let response: Response;
  try {
    response = await transport('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: base64url(new TextEncoder().encode(message)) }),
    });
  } catch {
    throw new GmailFailure(
      'Gmail delivery could not be confirmed. This cycle will not be resent.',
      false,
      true,
    );
  }
  await response.body?.cancel();
  if (response.ok) return;
  if (response.status >= 500)
    throw new GmailFailure(
      'Gmail delivery could not be confirmed. This cycle will not be resent.',
      false,
      true,
    );
  throw new GmailFailure(
    response.status === 429
      ? 'Gmail rate limit reached. A delayed retry is scheduled.'
      : 'Gmail rejected this reminder. Check the connected account and sending permission.',
    response.status === 429,
    false,
    response.status === 401,
  );
}
