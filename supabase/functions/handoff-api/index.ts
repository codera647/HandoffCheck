import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { commandSchema, draftSchema, roleSchema } from '../../../shared/contracts.ts';
import { DomainError, validateFile } from '../../../shared/domain.ts';
import { policyInputSchema, taskKindSchema } from '../../../shared/automation.ts';
import {
  providerConfigured,
  generateAI,
  generateIntake,
  ProviderFailure,
} from '../../../shared/ai-provider.ts';
import { intakeInputSchema, intakeResponseSchema } from '../../../shared/intake.ts';
import { emptyFields } from '../../../shared/contracts.ts';
import { aiConfig, schedulerConfigured, processAutomation } from '../_shared/automation-worker.ts';
import {
  fetchLinearTeams,
  publishLinearIssue,
  ticketPreviewSchema,
  LinearFailure,
} from '../../../shared/linear.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const origins = new Set(
  (Deno.env.get('ALLOWED_APP_ORIGINS') || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
);
const uuid = z.uuid();
declare const EdgeRuntime: { waitUntil(work: Promise<unknown>): void };

function databaseError(error: { message: string; code?: string }): never {
  const match = /^([A-Z_]+)\|(.+)$/.exec(error.message);
  if (match) {
    const status =
      match[1] === 'NOT_FOUND'
        ? 404
        : ['FORBIDDEN', 'ACCESS_DENIED'].includes(match[1])
          ? 403
          : match[1] === 'RATE_LIMIT'
            ? 429
            : ['STALE_REVISION', 'KEY_REUSED', 'REVIEW_RUNNING', 'CHAT_RUNNING'].includes(match[1])
              ? 409
              : 422;
    throw new DomainError(match[1], match[2], status);
  }
  if (error.code === '23505')
    throw new DomainError(
      'ALREADY_EXISTS',
      'This item already exists. Refresh before continuing.',
      409,
    );
  throw new DomainError(
    'DATABASE_ERROR',
    'The request could not be saved. Check the input or contact the administrator.',
    500,
  );
}

export async function handleRequest(request: Request): Promise<Response> {
  const origin = request.headers.get('Origin');
  const cors: Record<string, string> = {
    Vary: 'Origin',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (origin && origins.has(origin))
    Object.assign(cors, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, idempotency-key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  if (origin && !origins.has(origin))
    return respond(
      { error: { code: 'ORIGIN_DENIED', message: 'This application origin is not allowed.' } },
      403,
    );
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const authorization = request.headers.get('Authorization') || '';
    if (!/^Bearer \S+$/.test(authorization))
      throw new DomainError('SESSION_EXPIRED', 'Sign in to continue.', 401);
    const token = authorization.slice(7);
    const {
      data: { user },
      error: authError,
    } = await admin.auth.getUser(token);
    if (authError || !user)
      throw new DomainError('SESSION_EXPIRED', 'Your session expired. Sign in again.', 401);
    const scoped = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const rpc = async (
      name: string,
      parameters: Record<string, unknown> = {},
    ): Promise<unknown> => {
      const { data, error } = await scoped.rpc(name, parameters);
      if (error) databaseError(error);
      return data;
    };
    const privileged = async (
      name: string,
      parameters: Record<string, unknown>,
    ): Promise<unknown> => {
      const { data, error } = await admin.rpc(name, parameters);
      if (error) databaseError(error);
      return data;
    };
    const address = new URL(request.url),
      path = address.pathname.replace(/^.*\/handoff-api/, '');
    let body: unknown = {};
    if (request.method === 'POST') {
      if (Number(request.headers.get('Content-Length')) > 64000)
        throw new DomainError('BODY_LIMIT', 'Keep request content below 64 KB.', 413);
      // Bound streamed input even when Content-Length is omitted.
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 64000) {
            await reader.cancel();
            throw new DomainError('BODY_LIMIT', 'Keep request content below 64 KB.', 413);
          }
          chunks.push(part.value);
        }
      }
      const combined = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      body = bytes ? JSON.parse(new TextDecoder().decode(combined)) : {};
    }
    const key = request.headers.get('Idempotency-Key');
    if (request.method === 'POST' && path === '/intake/turn') {
      const input = intakeInputSchema.parse(body);
      if (!providerConfigured(aiConfig()))
        throw new DomainError(
          'NOT_CONFIGURED',
          'Gemini is not configured. You can still fill the form manually.',
        );
      const claim = z
        .object({
          created: z.boolean(),
          id: uuid.optional(),
          leaseToken: uuid.optional(),
          state: z.string().optional(),
          response: z.unknown().optional(),
          error: z.string().nullable().optional(),
          model: z.string().nullable().optional(),
        })
        .parse(await rpc('intake_claim', { p_key: uuid.parse(key), p_input: input }));
      if (!claim.created) {
        if (claim.state !== 'ready')
          throw new ProviderFailure(
            claim.error || 'The assistant turn failed. Retry this message.',
          );
        return respond({
          response: intakeResponseSchema.parse(claim.response),
          model: claim.model ?? null,
          demo: false,
        });
      }
      let output: unknown = null,
        error: string | null = null,
        model: string | null = null,
        usage: object = {};
      try {
        const result = await generateIntake(input, aiConfig());
        output = result.output;
        model = result.model;
        usage = result.usage;
      } catch (failure) {
        error =
          failure instanceof ProviderFailure
            ? failure.message
            : 'The assistant could not prepare a draft. Retry this message.';
      }
      const finished = z
        .object({
          state: z.string(),
          response: z.unknown(),
          error: z.string().nullable(),
          model: z.string().nullable(),
        })
        .parse(
          await privileged('intake_finish', {
            p_id: claim.id,
            p_actor: user.id,
            p_lease: claim.leaseToken,
            p_response: output,
            p_error: error,
            p_model: model,
            p_usage: usage,
          }),
        );
      if (finished.state !== 'ready')
        throw new ProviderFailure(
          finished.error || 'The assistant turn failed. Retry this message.',
        );
      return respond({
        response: intakeResponseSchema.parse(finished.response),
        model: finished.model,
        demo: false,
      });
    }
    const linearKey = Deno.env.get('LINEAR_API_KEY') || '';
    if (request.method === 'GET' && path === '/linear/connection')
      return respond({
        ...((await rpc('linear_connection')) as object),
        configured: !!linearKey,
        demo: false,
      });
    if (request.method === 'GET' && path === '/admin/linear/teams') {
      await rpc('linear_admin');
      return respond(await fetchLinearTeams(linearKey));
    }
    if (request.method === 'POST' && path === '/admin/linear') {
      const workspace = uuid.parse(await rpc('linear_admin'));
      const input = z
        .object({
          teamId: uuid,
          organizationId: uuid,
          expectedVersion: z.number().int().nonnegative(),
        })
        .strict()
        .parse(body);
      const available = await fetchLinearTeams(linearKey);
      if (available.organization.id !== input.organizationId)
        throw new DomainError(
          'DESTINATION_CHANGED',
          'The accessible Linear organization changed. Load teams and confirm again.',
        );
      const team = available.teams.find((t) => t.id === input.teamId);
      if (!team)
        throw new DomainError(
          'INVALID_TEAM',
          'Select a team accessible to the configured Linear key.',
        );
      await privileged('linear_configure', {
        p_actor: user.id,
        p_workspace: workspace,
        p_organization: available.organization.id,
        p_name: available.organization.name,
        p_team: team.id,
        p_team_name: team.name,
        p_expected: input.expectedVersion,
      });
      return respond({ saved: true });
    }
    const linearBrief = /^\/briefs\/([^/]+)\/linear$/.exec(path);
    if (linearBrief && request.method === 'GET')
      return respond(await rpc('linear_preview', { p_brief: uuid.parse(linearBrief[1]) }));
    if (linearBrief && request.method === 'POST') {
      if (!linearKey)
        throw new DomainError(
          'NOT_CONFIGURED',
          'Linear is not configured. Ask the administrator to add its backend key.',
        );
      const input = z
        .object({ payloadHash: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(body);
      const claim = z
        .object({
          created: z.boolean(),
          id: uuid.optional(),
          issueId: uuid.optional(),
          leaseToken: uuid.optional(),
          preview: ticketPreviewSchema,
        })
        .parse(
          await privileged('linear_claim', {
            p_actor: user.id,
            p_brief: uuid.parse(linearBrief[1]),
            p_hash: input.payloadHash,
          }),
        );
      if (!claim.created) {
        try {
          // Verify the configured key still points to the previewed organization and team.
          const available = await fetchLinearTeams(linearKey);
          if (
            available.organization.id !== claim.preview.organizationId ||
            !available.teams.some((t) => t.id === claim.preview.teamId)
          )
            throw new LinearFailure(
              'The backend key no longer has access to the confirmed organization and team.',
            );
          const issue = await publishLinearIssue(
            claim.issueId!,
            claim.preview,
            linearKey,
            fetch,
            async () => {
              await privileged('linear_check_outbound', {
                p_id: claim.id,
                p_lease: claim.leaseToken,
                p_actor: user.id,
              });
            },
          );
          await privileged('linear_finish', {
            p_id: claim.id,
            p_lease: claim.leaseToken,
            p_url: issue.url,
            p_identifier: issue.identifier,
            p_error: null,
          });
        } catch (error) {
          const message =
            error instanceof LinearFailure
              ? error.message
              : 'The handoff could not finish. Refresh and retry to reconcile the saved issue.';
          await privileged('linear_finish', {
            p_id: claim.id,
            p_lease: claim.leaseToken,
            p_url: null,
            p_identifier: null,
            p_error: message,
          });
          throw new LinearFailure(message);
        }
      }
      return respond(await rpc('linear_preview', { p_brief: uuid.parse(linearBrief[1]) }));
    }
    async function runTask(job?: string) {
      const context = (await rpc('handoff_context')) as { workspace: { id: string } };
      const policy = (await rpc('automation_policy')) as { background: boolean };
      const work = () => processAutomation(admin, context.workspace.id, job);
      if (policy.background && typeof EdgeRuntime !== 'undefined')
        EdgeRuntime.waitUntil(
          work().catch(() =>
            console.error('Automation dispatch failed; queued work remains for recovery.'),
          ),
        );
      else await work();
    }
    if (request.method === 'GET' && path === '/automation/policy')
      return respond({
        ...((await rpc('automation_policy')) as object),
        providerConfigured: providerConfigured(aiConfig()),
        schedulerConfigured: schedulerConfigured(),
        demo: false,
      });
    if (request.method === 'POST' && path === '/admin/automation') {
      const input = policyInputSchema.parse(body);
      if (input.aiEnabled && !providerConfigured(aiConfig()))
        throw new DomainError(
          'NOT_CONFIGURED',
          'Save Gemini credentials in backend secrets before enabling AI.',
        );
      if ((input.background || input.reminders) && !schedulerConfigured())
        throw new DomainError(
          'NOT_CONFIGURED',
          'Configure the private automation scheduler before enabling background work or reminders.',
        );
      return respond(await rpc('automation_set_policy', { p_input: input }));
    }
    if (request.method === 'POST' && path === '/admin/automation/test-provider') {
      if (!providerConfigured(aiConfig()))
        throw new DomainError('NOT_CONFIGURED', 'Gemini is not configured.');
      await rpc('automation_reserve_probe');
      const result = await generateAI(
        'summary',
        {
          ...emptyFields(),
          title: 'Synthetic provider check',
          behavior: 'A user selects Export and receives a CSV of tasks they may already read.',
          criteria: ['The CSV contains only tasks the user can read.'],
        },
        aiConfig(),
      );
      return respond({ verified: true, model: result.model });
    }
    if (request.method === 'GET' && path === '/notifications')
      return respond(await rpc('automation_notifications'));
    const notification = /^\/notifications\/([^/]+)\/read$/.exec(path);
    if (request.method === 'POST' && notification) {
      await rpc('automation_read_notification', { p_id: uuid.parse(notification[1]) });
      return respond({ saved: true });
    }
    const tasksPath = /^\/requests\/([^/]+)\/assistance$/.exec(path);
    if (tasksPath) {
      const id = uuid.parse(tasksPath[1]);
      if (request.method === 'GET')
        return respond(await rpc('automation_tasks', { p_request: id }));
      if (request.method === 'POST') {
        if (!providerConfigured(aiConfig()))
          throw new DomainError('NOT_CONFIGURED', 'Gemini is not configured.');
        const input = z
          .object({
            kind: taskKindSchema,
            expectedRevision: z.number().int(),
            briefId: z.uuid().nullable(),
          })
          .strict()
          .parse(body);
        const task = (await rpc('automation_request', {
          p_request: id,
          p_kind: input.kind,
          p_expected: input.expectedRevision,
          p_brief: input.briefId,
        })) as { id: string };
        await runTask(task.id);
        return respond(await rpc('automation_tasks', { p_request: id }));
      }
    }
    const acceptTask = /^\/assistance\/([^/]+)\/accept$/.exec(path);
    if (request.method === 'POST' && acceptTask) {
      const input = z
        .object({ index: z.number().int().min(0).max(5), expectedRevision: z.number().int() })
        .strict()
        .parse(body);
      return respond(
        await rpc('automation_accept_edit', {
          p_job: uuid.parse(acceptTask[1]),
          p_index: input.index,
          p_expected: input.expectedRevision,
        }),
      );
    }
    const reviewedTask = /^\/assistance\/([^/]+)\/reviewed$/.exec(path);
    if (request.method === 'POST' && reviewedTask) {
      await rpc('automation_review_qa', { p_job: uuid.parse(reviewedTask[1]) });
      return respond({ saved: true });
    }
    if (request.method === 'GET' && path === '/me') return respond(await rpc('handoff_context'));
    if (request.method === 'GET' && path === '/workspace')
      return respond(await rpc('handoff_workspace_connection'));
    if (request.method === 'POST' && path === '/workspace') {
      const input = z.object({ enabled: z.boolean() }).strict().parse(body);
      await rpc('handoff_workspace_enabled', { p_enabled: input.enabled });
      return respond({ saved: true });
    }
    const googleBrief = /^\/briefs\/([^/]+)\/google-document$/.exec(path);
    if (request.method === 'GET' && googleBrief)
      return respond(await rpc('handoff_google_document', { p_brief: uuid.parse(googleBrief[1]) }));
    if (request.method === 'POST' && path === '/membership/accept') {
      await rpc('handoff_accept_membership');
      return respond({ accepted: true });
    }
    if (request.method === 'GET' && path === '/requests') {
      const filters = z
        .object({
          search: z.string().max(120).optional(),
          status: z.string().max(40).optional(),
          author: z.uuid().optional(),
          assigned: z.uuid().optional(),
          archived: z
            .enum(['true', 'false'])
            .transform((v) => v === 'true')
            .optional(),
          page: z.coerce.number().int().min(1).max(10000).optional(),
        })
        .parse(Object.fromEntries(address.searchParams));
      return respond(await rpc('handoff_list', { p_filters: filters }));
    }
    if (request.method === 'POST' && path === '/requests') {
      const { draft } = z.object({ draft: draftSchema }).parse(body);
      return respond(await rpc('handoff_create', { p_draft: draft, p_key: key }), 201);
    }
    const detail = /^\/requests\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && detail)
      return respond(await rpc('handoff_get', { p_id: uuid.parse(detail[1]) }));
    const commandPath = /^\/requests\/([^/]+)\/commands$/.exec(path);
    if (request.method === 'POST' && commandPath) {
      const id = uuid.parse(commandPath[1]),
        command = commandSchema.parse(body);
      if (command.action !== 'review')
        return respond(await rpc('handoff_command', { p_id: id, p_command: command, p_key: key }));
      const policy = (await rpc('automation_policy')) as { aiEnabled: boolean };
      if (policy.aiEnabled && !providerConfigured(aiConfig()))
        throw new DomainError(
          'NOT_CONFIGURED',
          'Gemini is unavailable. Ask the administrator to configure it or switch to checklist-only review.',
        );
      const claim = z
        .object({
          record: z.unknown(),
          claimed: z.boolean(),
          queued: z.boolean().optional(),
          jobId: z.uuid().optional(),
        })
        .parse(
          await rpc('handoff_start_review', {
            p_id: id,
            p_expected: command.expectedRevision,
            p_key: key,
          }),
        );
      if (claim.queued) {
        await runTask(claim.jobId);
        return respond(await rpc('handoff_get', { p_id: id }));
      }
      return respond(claim.record);
    }
    const reservation = /^\/requests\/([^/]+)\/files\/reservations$/.exec(path);
    if (request.method === 'POST' && reservation) {
      const file = z
        .object({
          name: z.string().min(1).max(250),
          type: z.enum(['image/png', 'image/jpeg', 'application/pdf']),
          size: z.number().int().min(1).max(5000000),
        })
        .parse(body);
      return respond(
        await rpc('handoff_reserve_file', {
          p_request: uuid.parse(reservation[1]),
          p_name: file.name,
          p_type: file.type,
          p_size: file.size,
        }),
        201,
      );
    }
    const filePath = /^\/files\/([^/]+)\/(complete|download)$/.exec(path);
    if (
      filePath &&
      ((filePath[2] === 'complete' && request.method === 'POST') ||
        (filePath[2] === 'download' && request.method === 'GET'))
    ) {
      const id = uuid.parse(filePath[1]);
      // User-scoped query enforces current membership before service access to Storage.
      const { data: stored, error } = await scoped
        .from('stored_files')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) databaseError(error);
      if (!stored) throw new DomainError('NOT_FOUND', 'This file is unavailable.', 404);
      if (filePath[2] === 'download') {
        if (stored.state !== 'verified')
          throw new DomainError('FILE_NOT_READY', 'This file has not been verified.');
        const { data, error: signError } = await admin.storage
          .from('request-files')
          .createSignedUrl(stored.path, 300, { download: stored.name });
        if (signError || !data)
          throw new DomainError('DOWNLOAD_FAILED', 'The file download could not be created.', 502);
        return respond({ url: data.signedUrl, name: stored.name });
      }
      if (stored.owner_id !== user.id)
        throw new DomainError('FORBIDDEN', 'Only the uploader can complete this file.', 403);
      if (stored.state === 'verified')
        return respond({ id: stored.id, name: stored.name, type: stored.type, size: stored.size });
      const { data: blob, error: downloadError } = await admin.storage
        .from('request-files')
        .download(stored.path);
      if (downloadError || !blob)
        throw new DomainError(
          'UPLOAD_MISSING',
          'The uploaded file is unavailable. Try uploading again.',
        );
      let valid = true;
      try {
        validateFile(new Uint8Array(await blob.slice(0, 16).arrayBuffer()), stored.type, blob.size);
        if (blob.size !== stored.size) valid = false;
      } catch {
        valid = false;
      }
      const result = await privileged('handoff_verify_file', {
        p_file: id,
        p_actor: user.id,
        p_valid: valid,
      });
      if (!valid)
        throw new DomainError(
          'INVALID_FILE',
          'The uploaded contents do not match the declared file.',
        );
      return respond(result);
    }
    if (request.method === 'POST' && path === '/admin/invitations') {
      const input = z.object({ email: z.email().max(254), role: roleSchema }).parse(body);
      await rpc('handoff_invite', { p_email: input.email, p_role: input.role });
      return respond({ saved: true });
    }
    const memberPath = /^\/admin\/members\/([^/]+)$/.exec(path);
    if (request.method === 'POST' && memberPath) {
      const input = z
        .object({ role: roleSchema, status: z.enum(['active', 'revoked']) })
        .parse(body);
      await rpc('handoff_change_member', {
        p_user: uuid.parse(memberPath[1]),
        p_role: input.role,
        p_status: input.status,
      });
      return respond({ saved: true });
    }
    if (request.method === 'POST' && path === '/admin/checklists') {
      const input = z.object({ name: z.string().trim().min(1).max(100) }).parse(body);
      await rpc('handoff_publish_checklist', { p_name: input.name });
      return respond({ saved: true });
    }
    throw new DomainError('NOT_FOUND', 'This endpoint could not be found.', 404);
  } catch (error) {
    if (error instanceof LinearFailure)
      return respond({ error: { code: 'LINEAR_PROVIDER', message: error.message } }, 503);
    if (error instanceof ProviderFailure)
      return respond({ error: { code: 'AI_PROVIDER', message: error.message } }, 503);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return respond(
        { error: { code: 'INVALID_INPUT', message: 'Check the request fields and try again.' } },
        422,
      );
    if (error instanceof DomainError)
      return respond({ error: { code: error.code, message: error.message } }, error.status);
    return respond(
      {
        error: {
          code: 'SERVER_ERROR',
          message: 'The request could not be completed. Try again or contact the administrator.',
        },
      },
      500,
    );
  }
}
Deno.serve(handleRequest);
