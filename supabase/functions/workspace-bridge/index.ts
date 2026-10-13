import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { bridgeActionSchema, verifyBridgeSignature } from '../../../shared/workspace-bridge.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const secret = Deno.env.get('WORKSPACE_BRIDGE_SECRET') || '';
const workspace = Deno.env.get('WORKSPACE_BRIDGE_WORKSPACE_ID') || '';
const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });
async function bodyText(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 64000) {
      await reader.cancel();
      throw new Error('BODY_LIMIT');
    }
    parts.push(value);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(combined);
}
Deno.serve(async (request) => {
  if (request.method !== 'POST' || request.headers.has('Origin'))
    return reply(
      { error: { code: 'FORBIDDEN', message: 'Use the signed Apps Script connection.' } },
      403,
    );
  if (!/^[a-f0-9]{64}$/.test(secret) || !z.uuid().safeParse(workspace).success)
    return reply(
      { error: { code: 'NOT_CONFIGURED', message: 'The Workspace bridge is not configured.' } },
      503,
    );
  try {
    const raw = await bodyText(request),
      timestamp = request.headers.get('X-Handoff-Timestamp') || '',
      nonce = request.headers.get('X-Handoff-Nonce') || '',
      signature = request.headers.get('X-Handoff-Signature') || '';
    if (!(await verifyBridgeSignature(secret, raw, timestamp, nonce, signature)))
      return reply(
        {
          error: {
            code: 'SIGNATURE_INVALID',
            message: 'The signed connection could not be verified.',
          },
        },
        401,
      );
    const action = bridgeActionSchema.parse(JSON.parse(raw));
    const call = async (name: string, params: Record<string, unknown>) => {
      const { data, error } = await admin.rpc(name, params);
      if (error) throw error;
      return data;
    };
    await call('workspace_bridge_nonce', { p_workspace: workspace, p_nonce: nonce });
    return reply(
      await call('workspace_bridge', {
        p_workspace: workspace,
        p_action: action.action,
        p_data: action.data,
      }),
    );
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError)
      return reply(
        {
          error: {
            code: 'INVALID_INPUT',
            message:
              'The Form response contains invalid or oversized fields. Correct the response and retry.',
          },
        },
        422,
      );
    const message =
      error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : '';
    if (message === 'BODY_LIMIT')
      return reply(
        { error: { code: 'BODY_LIMIT', message: 'Keep the Form response below 64 KB.' } },
        413,
      );
    const match = /^([A-Z_]+)\|(.+)$/.exec(message);
    if (match)
      return reply(
        { error: { code: match[1], message: match[2] } },
        match[1] === 'RATE_LIMIT'
          ? 429
          : ['ACCESS_DENIED', 'FORBIDDEN'].includes(match[1])
            ? 403
            : ['REPLAY', 'KEY_REUSED'].includes(match[1])
              ? 409
              : 422,
      );
    console.error('Workspace database operation failed.');
    return reply(
      {
        error: {
          code: 'SERVICE_ERROR',
          message: 'Workspace sync failed. Check the Apps Script execution log and retry.',
        },
      },
      500,
    );
  }
});
