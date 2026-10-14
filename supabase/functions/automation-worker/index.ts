import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { verifyBridgeSignature } from '../../../shared/workspace-bridge.ts';
import { processAutomation } from '../_shared/automation-worker.ts';

export async function handleWorker(request: Request): Promise<Response> {
  const reply = (status: number, message: string) =>
    new Response(JSON.stringify({ message }), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  if (request.method !== 'POST') return reply(405, 'POST is required.');
  const secret = Deno.env.get('AUTOMATION_WORKER_SECRET'),
    workspace = Deno.env.get('AUTOMATION_WORKSPACE_ID');
  if (!secret || !workspace) return reply(503, 'Automation worker is not configured.');
  const reader = request.body?.getReader();
  let raw = '',
    bytes = 0;
  const decoder = new TextDecoder();
  if (reader)
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4096) {
        await reader.cancel();
        return reply(413, 'Request too large.');
      }
      raw += decoder.decode(part.value, { stream: true });
    }
  raw += decoder.decode();
  const nonce = request.headers.get('x-handoff-nonce') || '';
  if (
    !(await verifyBridgeSignature(
      secret,
      raw,
      request.headers.get('x-handoff-timestamp') || '',
      nonce,
      request.headers.get('x-handoff-signature') || '',
    ))
  )
    return reply(401, 'Internal authorization is required.');
  try {
    z.object({ action: z.literal('run') })
      .strict()
      .parse(JSON.parse(raw));
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const replay = await admin.rpc('automation_nonce', { p_nonce: nonce });
    if (replay.error) return reply(409, 'This internal request was already processed.');
    const reminders = await admin.rpc('automation_remind', { p_workspace: workspace });
    if (reminders.error) return reply(500, 'Reminders could not be processed.');
    await processAutomation(admin, workspace);
    return reply(200, 'Automation tasks processed.');
  } catch {
    return reply(500, 'Automation could not finish. Check the task status.');
  }
}
if (import.meta.main) Deno.serve(handleWorker);
