import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { reminderPayloadSchema, sendReminderEmail } from '../../../shared/reminder-email.ts';
import { gmailConfigured, googleGrant, openGmail, GmailFailure } from '../../../shared/gmail.ts';
import { gmailConfig } from './gmail-config.ts';
import { gmailPurpose } from '../../../shared/gmail-callback.ts';

const claimSchema = z.object({
  id: z.uuid(),
  deliveryKey: z.uuid(),
  leaseToken: z.uuid(),
  payload: reminderPayloadSchema,
  senderId: z.uuid(),
  generation: z.number().int(),
  googleSub: z.string(),
  encryptedToken: z.string(),
});

export async function processReminderEmails(
  admin: SupabaseClient,
  workspace: string,
): Promise<void> {
  const config = gmailConfig();
  for (let count = 0; count < 2; count++) {
    const claimed = await admin.rpc('reminder_email_claim', {
      p_workspace: workspace,
      p_configured: gmailConfigured(config),
    });
    if (claimed.error) throw new Error('Reminder email work could not be claimed.');
    if (!claimed.data) return;
    const claim = claimSchema.parse(claimed.data);
    let error: string | null = null,
      retry = false,
      uncertain = false;
    try {
      const refresh = await openGmail(
        claim.encryptedToken,
        config.encryptionKey!,
        gmailPurpose(workspace, claim.senderId),
      );
      const grant = await googleGrant(config, {
        grant_type: 'refresh_token',
        refresh_token: refresh,
      });
      if (grant.email !== claim.payload.from || grant.sub !== claim.googleSub)
        throw new GmailFailure(
          'The connected Google account changed. Connect Gmail again.',
          false,
          false,
          true,
        );
      const started = await admin.rpc('gmail_email_begin_send', {
        p_id: claim.id,
        p_lease: claim.leaseToken,
        p_generation: claim.generation,
      });
      if (started.error) throw new Error('Sending permission could not be checked.');
      if (started.data !== true) continue;
      await sendReminderEmail(claim.payload, claim.deliveryKey, grant.accessToken);
    } catch (failure) {
      error =
        failure instanceof GmailFailure
          ? failure.message
          : 'The reminder email could not be prepared. Ask the administrator to check Gmail configuration.';
      retry = failure instanceof GmailFailure && failure.retryable;
      uncertain = failure instanceof GmailFailure && failure.uncertain;
      if (failure instanceof GmailFailure && failure.reconnect) {
        const invalidated = await admin.rpc('gmail_connection_invalid', {
          p_actor: claim.senderId,
          p_generation: claim.generation,
        });
        if (invalidated.error) throw new Error('The Gmail connection status could not be stored.');
      }
    }
    const finished = await admin.rpc('reminder_email_finish', {
      p_id: claim.id,
      p_lease: claim.leaseToken,
      p_error: error,
      p_retry: retry,
      p_uncertain: uncertain,
    });
    if (finished.error) throw new Error('Reminder email status could not be stored.');
  }
}
