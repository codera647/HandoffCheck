import { z } from 'zod';

export const reminderPayloadSchema = z
  .object({
    to: z.email(),
    title: z.string().max(120),
    requestId: z.uuid(),
    revision: z.number().int().positive(),
  })
  .strict();
export type ReminderPayload = z.infer<typeof reminderPayloadSchema>;
export interface ReminderEmailConfig {
  key?: string;
  from?: string;
}
export const emailConfigured = (config: ReminderEmailConfig) =>
  !!config.key &&
  !!config.from &&
  config.from.length <= 250 &&
  !/[\r\n]/.test(config.from) &&
  z.email().safeParse(config.from.match(/<([^<>]+)>$/)?.[1] ?? config.from).success;
export class ReminderEmailFailure extends Error {
  constructor(
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

export async function sendReminderEmail(
  input: ReminderPayload,
  deliveryKey: string,
  config: ReminderEmailConfig,
  transport: typeof fetch = fetch,
) {
  const payload = reminderPayloadSchema.parse(input);
  z.uuid().parse(deliveryKey);
  if (!emailConfigured(config)) throw new ReminderEmailFailure('Reminder email is not configured.');
  const link = `https://handoffcheck.vercel.app/requests/${payload.requestId}?tab=approvals`;
  const title = payload.title.replace(/[\r\n\t]+/g, ' ');
  let response: Response;
  try {
    response = await transport('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `handoff-reminder-${deliveryKey}`,
      },
      body: JSON.stringify({
        from: config.from,
        to: [payload.to],
        subject: `Approval reminder: ${title}`,
        text: `Your approval is still pending for “${title}”, revision ${payload.revision}.\n\nOpen the request to review it, approve your assigned stage or request changes:\n${link}\n\nHandoffCheck sends this reminder on the schedule selected by the request author. Reminders stop after your approval or when the request leaves approval. Do not reply to this automated message; use the request discussion.`,
      }),
    });
  } catch {
    throw new ReminderEmailFailure(
      'The email provider could not be reached. A retry will be attempted.',
      true,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ReminderEmailFailure(
      response.status === 429
        ? 'The email provider rate limit was reached.'
        : response.status >= 500
          ? 'The email provider is temporarily unavailable.'
          : 'The email provider rejected this reminder. Ask the administrator to check the sender and API key.',
      response.status === 429 || response.status >= 500,
    );
  }
  // Acceptance is not inbox delivery. The provider handles downstream delivery/bounces.
  await response.body?.cancel();
}
