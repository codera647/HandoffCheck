import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { fieldsSchema, emptyFields } from '../../../shared/contracts.ts';
import { generateAI, ProviderFailure, providerConfigured } from '../../../shared/ai-provider.ts';

export const aiConfig = () => ({
  key: Deno.env.get('GEMINI_API_KEY'),
  model: Deno.env.get('GEMINI_MODEL_ID'),
});
export const schedulerConfigured = () =>
  !!Deno.env.get('AUTOMATION_WORKER_SECRET') && !!Deno.env.get('AUTOMATION_WORKSPACE_ID');
const claimSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['review', 'edits', 'summary', 'qa']),
  fields: z.unknown(),
  leaseToken: z.uuid(),
  attempts: z.number(),
});
export async function processAutomation(
  admin: SupabaseClient,
  workspace: string,
  job?: string,
): Promise<number> {
  if (!providerConfigured(aiConfig())) return 0;
  let processed = 0;
  for (let i = 0; i < (job ? 1 : 2); i++) {
    const claimed = await admin.rpc('automation_claim', {
      p_workspace: workspace,
      p_job: job ?? null,
    });
    if (claimed.error) throw new Error('Automation tasks could not be claimed.');
    if (!claimed.data) continue;
    const claim = claimSchema.parse(claimed.data);
    let output: unknown = null,
      error: string | null = null,
      retry = false,
      usage: object = {};
    try {
      const fields = fieldsSchema.parse({
        ...emptyFields(),
        ...(claim.fields as object),
        references: [],
      });
      const result = await generateAI(claim.kind, fields, aiConfig());
      output = result.output;
      usage = result.usage;
    } catch (failure) {
      error =
        failure instanceof ProviderFailure
          ? failure.message
          : 'The AI task could not finish. Try again.';
      retry =
        failure instanceof ProviderFailure &&
        failure.retryable &&
        (claim.kind !== 'review' || schedulerConfigured());
    }
    const result = await admin.rpc('automation_finish', {
      p_job: claim.id,
      p_lease: claim.leaseToken,
      p_output: output,
      p_error: error,
      p_model: aiConfig().model ?? null,
      p_retry: retry,
      p_usage: usage,
    });
    if (result.error && !result.error.message.startsWith('INVALID_LEASE|')) {
      // Invalid output must leave a visible failure, not an endlessly working task.
      const failed = await admin.rpc('automation_finish', {
        p_job: claim.id,
        p_lease: claim.leaseToken,
        p_output: null,
        p_error: 'The AI response could not be stored safely. Regenerate the task.',
        p_model: null,
      });
      if (failed.error && !failed.error.message.startsWith('INVALID_LEASE|'))
        throw new Error('Automation finalization failed.');
    }
    processed++;
  }
  return processed;
}
