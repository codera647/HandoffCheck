import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  emailConfigured,
  reminderPayloadSchema,
  sendReminderEmail,
  ReminderEmailFailure,
} from '../../../shared/reminder-email.ts';

export const reminderEmailConfig = () => ({
  key: Deno.env.get('RESEND_API_KEY'),
  from: Deno.env.get('REMINDER_EMAIL_FROM'),
});
const claimSchema = z.object({
  id: z.uuid(),
  deliveryKey: z.uuid(),
  leaseToken: z.uuid(),
  payload: reminderPayloadSchema,
});

export async function processReminderEmails(
  admin: SupabaseClient,
  workspace: string,
): Promise<void> {
  const config = reminderEmailConfig();
  // Bound each worker invocation. Each email has a separate lease and stable provider key.
  for (let count = 0; count < 2; count++) {
    const claimed = await admin.rpc('reminder_email_claim', {
      p_workspace: workspace,
      p_configured: emailConfigured(config),
    });
    if (claimed.error) throw new Error('Reminder email work could not be claimed.');
    if (!claimed.data) return;
    const claim = claimSchema.parse(claimed.data);
    let error: string | null = null,
      retry = false;
    try {
      await sendReminderEmail(claim.payload, claim.deliveryKey, config);
    } catch (failure) {
      error =
        failure instanceof ReminderEmailFailure
          ? failure.message
          : 'The reminder email could not be prepared.';
      retry = failure instanceof ReminderEmailFailure && failure.retryable;
    }
    const finished = await admin.rpc('reminder_email_finish', {
      p_id: claim.id,
      p_lease: claim.leaseToken,
      p_error: error,
      p_retry: retry,
    });
    if (finished.error) throw new Error('Reminder email status could not be stored.');
  }
}
