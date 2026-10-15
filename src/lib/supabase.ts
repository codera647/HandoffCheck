import { createClient, type Session } from '@supabase/supabase-js';
import {
  contextSchema,
  fileMetaSchema,
  listSchema,
  requestSchema,
  type Command,
  type DraftInput,
  type ListFilters,
  type Role,
} from '../../shared/contracts';
import { DomainError } from '../../shared/domain';
import type { Repository } from './repository';
import { resumeGoogleSession } from './google-auth';
import { workspaceConnectionSchema, googleDocumentSchema } from '../../shared/workspace-bridge';
import { z } from 'zod';
import { policySchema, taskSchema, notificationSchema } from '../../shared/automation';
import { intakeResultSchema } from '../../shared/intake';
import {
  linearConnectionSchema,
  linearTeamsSchema,
  ticketPreviewSchema,
} from '../../shared/linear';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
export const supabase =
  url && key
    ? createClient(url, key, { auth: { flowType: 'pkce', detectSessionInUrl: false } })
    : null;
export const demoEnabled = import.meta.env.VITE_ENABLE_DEMO !== 'false';
export const googleLoginConfigured = !!supabase;
let callbackSession: Promise<Session | null> | undefined;

export function restoreHostedSession(): Promise<Session | null> {
  if (!supabase) return Promise.resolve(null);
  const address = new URL(location.href);
  const restore = () =>
    resumeGoogleSession(supabase!.auth, address, () => {
      history.replaceState(history.state, '', '/auth/callback');
    });
  return address.pathname === '/auth/callback' ? (callbackSession ??= restore()) : restore();
}

export async function startGoogleLogin(): Promise<void> {
  if (!supabase) throw new DomainError('NOT_CONFIGURED', 'Google login has not been configured.');
  if (window.handoffDesktop) {
    const tokens = await window.handoffDesktop.signInWithGoogle();
    const { error } = await supabase.auth.setSession(tokens);
    if (error)
      throw new DomainError('OAUTH_FAILED', 'Google sign-in could not finish. Try again.', 401);
    return;
  }
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${location.origin}/auth/callback` },
  });
  if (error) throw error;
}
async function api(
  path: string,
  method = 'GET',
  body?: unknown,
  commandKey?: string,
): Promise<unknown> {
  if (!supabase) throw new DomainError('NOT_CONFIGURED', 'Supabase is not configured.');
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session)
    throw new DomainError(
      'SESSION_EXPIRED',
      'Your session expired. Sign in again to continue.',
      401,
    );
  const response = await fetch(`${url}/functions/v1/handoff-api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${data.session.access_token}`,
      apikey: key!,
      'Content-Type': 'application/json',
      ...(commandKey ? { 'Idempotency-Key': commandKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  }).catch(() => {
    throw new DomainError(
      'API_UNREACHABLE',
      'The workspace service could not be reached. Try again or contact the workspace administrator.',
      503,
    );
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const err =
      result && typeof result === 'object' && 'error' in result ? result.error : undefined;
    const message =
      err && typeof err === 'object' && 'message' in err && typeof err.message === 'string'
        ? err.message
        : 'The request could not be completed.';
    const code =
      err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
        ? err.code
        : 'REQUEST_FAILED';
    throw new DomainError(code, message, response.status);
  }
  return result;
}
export async function acceptMembership(): Promise<void> {
  await api('/membership/accept', 'POST', {});
}
export const hostedRepository: Repository = {
  mode: 'supabase',
  async intake(input, key) {
    return intakeResultSchema.parse(await api('/intake/turn', 'POST', input, key));
  },
  async context() {
    return contextSchema.parse(await api('/me'));
  },
  async list(filters: ListFilters) {
    const search = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => {
      if (v !== undefined && v !== '') search.set(k, String(v));
    });
    return listSchema.parse(await api(`/requests?${search}`));
  },
  async get(id) {
    return requestSchema.parse(await api(`/requests/${encodeURIComponent(id)}`));
  },
  async create(draft: DraftInput, key) {
    return requestSchema.parse(await api('/requests', 'POST', { draft }, key));
  },
  async command(id, command: Command, key) {
    return requestSchema.parse(
      await api(`/requests/${encodeURIComponent(id)}/commands`, 'POST', command, key),
    );
  },
  async upload(id, file) {
    if (!supabase) throw new DomainError('NOT_CONFIGURED', 'Supabase is not configured.');
    const reservation = await api(
      `/requests/${id}/files/reservations`,
      'POST',
      { name: file.name, type: file.type, size: file.size },
      crypto.randomUUID(),
    );
    if (
      !reservation ||
      typeof reservation !== 'object' ||
      !('id' in reservation) ||
      !('path' in reservation) ||
      typeof reservation.id !== 'string' ||
      typeof reservation.path !== 'string'
    )
      throw new DomainError('INVALID_RESPONSE', 'The upload could not be reserved.', 502);
    const { error } = await supabase.storage
      .from('request-files')
      .upload(reservation.path, file, { contentType: file.type, upsert: false });
    if (error)
      throw new DomainError(
        'UPLOAD_FAILED',
        'The file upload failed. Retry the upload or contact the administrator.',
      );
    return fileMetaSchema.parse(await api(`/files/${reservation.id}/complete`, 'POST', {}));
  },
  async download(id) {
    const result = await api(`/files/${id}/download`);
    if (
      !result ||
      typeof result !== 'object' ||
      !('url' in result) ||
      !('name' in result) ||
      typeof result.url !== 'string' ||
      typeof result.name !== 'string'
    )
      throw new DomainError('INVALID_RESPONSE', 'The file could not be downloaded.', 502);
    return { url: result.url, name: result.name };
  },
  async invite(email: string, role: Role) {
    await api('/admin/invitations', 'POST', { email, role }, crypto.randomUUID());
  },
  async changeMember(id, role, status) {
    await api(`/admin/members/${id}`, 'POST', { role, status }, crypto.randomUUID());
  },
  async publishChecklist(name) {
    await api('/admin/checklists', 'POST', { name }, crypto.randomUUID());
  },
  async signOut() {
    if (supabase) {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    }
  },
  async workspaceConnection() {
    return workspaceConnectionSchema.parse(await api('/workspace'));
  },
  async setWorkspaceEnabled(enabled) {
    await api('/workspace', 'POST', { enabled });
  },
  async googleDocument(briefId) {
    return googleDocumentSchema.parse(
      await api(`/briefs/${encodeURIComponent(briefId)}/google-document`),
    );
  },
  async automationPolicy() {
    return policySchema.parse(await api('/automation/policy'));
  },
  async saveAutomationPolicy(input) {
    await api('/admin/automation', 'POST', input);
  },
  async testAIProvider() {
    return z
      .object({ verified: z.boolean(), model: z.string() })
      .parse(await api('/admin/automation/test-provider', 'POST', {}));
  },
  async assistance(id) {
    return z.array(taskSchema).parse(await api(`/requests/${encodeURIComponent(id)}/assistance`));
  },
  async requestAssistance(id, kind, expectedRevision, briefId) {
    await api(`/requests/${encodeURIComponent(id)}/assistance`, 'POST', {
      kind,
      expectedRevision,
      briefId,
    });
  },
  async acceptEdit(id, index, expectedRevision) {
    return requestSchema.parse(
      await api(`/assistance/${encodeURIComponent(id)}/accept`, 'POST', {
        index,
        expectedRevision,
      }),
    );
  },
  async reviewQA(id) {
    await api(`/assistance/${encodeURIComponent(id)}/reviewed`, 'POST', {});
  },
  async notifications() {
    return z.array(notificationSchema).parse(await api('/notifications'));
  },
  async readNotification(id) {
    await api(`/notifications/${encodeURIComponent(id)}/read`, 'POST', {});
  },
  async linearConnection() {
    return linearConnectionSchema.parse(await api('/linear/connection'));
  },
  async linearTeams() {
    return linearTeamsSchema.parse(await api('/admin/linear/teams'));
  },
  async saveLinearTeam(teamId, organizationId, expectedVersion) {
    await api('/admin/linear', 'POST', { teamId, organizationId, expectedVersion });
  },
  async ticketPreview(id) {
    return ticketPreviewSchema.parse(await api(`/briefs/${encodeURIComponent(id)}/linear`));
  },
  async createTicket(id, payloadHash) {
    return ticketPreviewSchema.parse(
      await api(`/briefs/${encodeURIComponent(id)}/linear`, 'POST', { payloadHash }),
    );
  },
};
