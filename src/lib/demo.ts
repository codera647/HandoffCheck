import { openDB, type DBSchema } from 'idb';
import { z } from 'zod';
import {
  baselineFields,
  contextSchema,
  emptyFields,
  fileMetaSchema,
  invitationSchema,
  requestSchema,
  type AppContext,
  type DraftInput,
  type FeatureFields,
  type ListFilters,
  type RequestRecord,
} from '../../shared/contracts';
import {
  applyDemoCommand,
  canonicalJson,
  createDemoRecord,
  currentRevision,
  DomainError,
  sha256,
  validateFile,
} from '../../shared/domain';
import type { Repository } from './repository';

export const demoMembers = [
  {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'Maya Chen',
    role: 'member',
    status: 'active',
  },
  {
    id: '10000000-0000-4000-8000-000000000002',
    name: 'Alex Morgan',
    role: 'product_lead',
    status: 'active',
  },
  {
    id: '10000000-0000-4000-8000-000000000003',
    name: 'Sam Rivera',
    role: 'engineering_lead',
    status: 'active',
  },
  {
    id: '10000000-0000-4000-8000-000000000004',
    name: 'Jordan Lee',
    role: 'admin',
    status: 'active',
  },
] as const;
const stateSchema = z.object({
  context: contextSchema,
  requests: z.array(requestSchema),
  files: z.array(fileMetaSchema.extend({ requestId: z.string() })),
  invitations: z.array(invitationSchema),
  receipts: z.record(z.string(), z.object({ hash: z.string(), requestId: z.string() })),
});
type DemoState = z.infer<typeof stateSchema>;
interface DemoDB extends DBSchema {
  state: { key: string; value: DemoState };
  blobs: { key: string; value: Blob };
}
const database = () =>
  openDB<DemoDB>('handoffcheck-demo-v1', 1, {
    upgrade(db) {
      db.createObjectStore('state');
      db.createObjectStore('blobs');
    },
  });

export function sampleFields(title = 'Export reports by date range'): FeatureFields {
  return {
    ...emptyFields(),
    title,
    problem:
      'Analysts cannot download reports for a selected period. They currently copy individual rows into a spreadsheet. This synthetic example assumes three weekly reports.',
    audience: 'Workspace analysts with the report_export permission.',
    behavior:
      'An analyst selects a start and end date, then downloads a CSV containing matching report rows. The export uses the workspace timezone.',
    scope: 'Date-range selection and CSV export for the existing report view.',
    exclusions: 'Scheduled exports, PDF reports, and changing the report permissions model.',
    criteria: [
      'Given an analyst with report_export permission, when they select a valid date range, then the CSV contains only matching rows.',
      'Given a user without report_export permission, when they open a report, then export is unavailable and the API rejects export attempts.',
    ],
    edgeCases:
      'Reject an end date before the start date. An empty result exports column headers. Show a retry message if the export fails.',
    dependencies: 'Existing reports API and its permission checks. No new external integration.',
    dataImpact:
      'Exports the report rows the analyst can already read. No new stored personal data or permission grants.',
    successMeasure: 'An analyst can produce a matching CSV without manually copying rows.',
    rationale: 'Normal priority: reduces manual steps in the weekly report workflow.',
    references: [{ label: 'Design reference (example)', url: 'https://www.figma.com/' }],
  };
}
async function seed(): Promise<DemoState> {
  const now = new Date().toISOString();
  const context: AppContext = {
    workspace: {
      id: '20000000-0000-4000-8000-000000000001',
      name: 'Product & Engineering',
      timezone: 'Asia/Karachi',
      reviewMode: 'checklist_only',
      storageBytes: 0,
      retentionDays: 60,
    },
    currentUser: { ...demoMembers[0] },
    members: demoMembers.map((m) => ({ ...m })),
    checklist: {
      id: '30000000-0000-4000-8000-000000000001',
      name: 'Engineering handoff v1',
      requiredFields: baselineFields,
      createdAt: now,
    },
    invitations: [],
  };
  const draft = (fields: FeatureFields): DraftInput => ({
    fields,
    productReviewerId: demoMembers[1].id,
    engineeringReviewerId: demoMembers[2].id,
    checklistVersion: context.checklist.id,
    fileIds: [],
  });
  let ready = await createDemoRecord(draft(sampleFields()), context, 42);
  ready = await applyDemoCommand(ready, { action: 'review', expectedRevision: 1 }, context);
  const missing = sampleFields('Save reusable report filters');
  missing.edgeCases = '';
  missing.dataImpact = '';
  let incomplete = await createDemoRecord(draft(missing), context, 41);
  incomplete = await applyDemoCommand(
    incomplete,
    { action: 'review', expectedRevision: 1 },
    context,
  );
  const fresh = await createDemoRecord(
    draft({ ...emptyFields(), title: 'Team access overview' }),
    context,
    40,
  );
  return {
    context,
    requests: [ready, incomplete, fresh],
    files: [],
    invitations: [],
    receipts: {},
  };
}
async function lock<T>(work: () => Promise<T>): Promise<T> {
  if (!navigator.locks)
    throw new DomainError('BROWSER_SUPPORT', 'Use a current browser for the local demo.');
  return navigator.locks.request('handoffcheck-demo-state', work);
}
async function read(): Promise<DemoState> {
  const db = await database();
  const stored = await db.get('state', 'workspace');
  if (stored) return stateSchema.parse(stored);
  return lock(async () => {
    const existing = await db.get('state', 'workspace');
    if (existing) return stateSchema.parse(existing);
    const initial = await seed();
    await db.put('state', initial, 'workspace');
    return initial;
  });
}
function actorContext(state: DemoState, actorId: string): AppContext {
  const actor = state.context.members.find((m) => m.id === actorId && m.status === 'active');
  if (!actor)
    throw new DomainError(
      'ACCESS_REVOKED',
      'Your demo membership is inactive. Choose an active demo user.',
      403,
    );
  return {
    ...state.context,
    currentUser: actor,
    invitations: actor.role === 'admin' ? state.invitations : undefined,
    workspace: {
      ...state.context.workspace,
      storageBytes: state.files.reduce((n, f) => n + f.size, 0),
    },
  };
}
export function demoRepository(actorId: string): Repository {
  async function mutate<T>(
    work: (state: DemoState, context: AppContext) => Promise<T>,
  ): Promise<T> {
    await read();
    return lock(async () => {
      const db = await database();
      const state = stateSchema.parse(await db.get('state', 'workspace'));
      const result = await work(state, actorContext(state, actorId));
      await db.put('state', state, 'workspace');
      return result;
    });
  }
  return {
    mode: 'demo',
    async context() {
      return actorContext(await read(), actorId);
    },
    async list(filters: ListFilters) {
      const state = await read();
      actorContext(state, actorId);
      const all = state.requests
        .filter(
          (r) =>
            r.archived === !!filters.archived &&
            (!filters.status || r.status === filters.status) &&
            (!filters.author || r.authorId === filters.author) &&
            (!filters.assigned ||
              r.productReviewerId === filters.assigned ||
              r.engineeringReviewerId === filters.assigned) &&
            (!filters.search ||
              `${r.title} HC-${String(r.number).padStart(4, '0')}`
                .toLowerCase()
                .includes(filters.search.toLowerCase())),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number);
      const page = Math.max(1, filters.page ?? 1);
      return {
        items: all.slice((page - 1) * 25, page * 25),
        total: all.length,
        page,
        pageSize: 25,
      };
    },
    async get(id) {
      const state = await read();
      actorContext(state, actorId);
      const record = state.requests.find((r) => r.id === id);
      if (!record) throw new DomainError('NOT_FOUND', 'This request could not be found.', 404);
      return record;
    },
    async create(draft, key) {
      return mutate(async (state, ctx) => {
        const hash = await sha256(canonicalJson(draft)),
          receiptKey = `${actorId}:create:${key}`,
          receipt = state.receipts[receiptKey];
        if (receipt) {
          if (receipt.hash !== hash)
            throw new DomainError(
              'KEY_REUSED',
              'This command key was reused with different content.',
              409,
            );
          const existing = state.requests.find((r) => r.id === receipt.requestId);
          if (!existing)
            throw new DomainError('NOT_FOUND', 'The original request is unavailable.', 404);
          return existing;
        }
        const record = await createDemoRecord(
          draft,
          ctx,
          Math.max(0, ...state.requests.map((r) => r.number)) + 1,
        );
        state.requests.unshift(record);
        state.receipts[receiptKey] = { hash, requestId: record.id };
        return record;
      });
    },
    async command(id, command, key) {
      return mutate(async (state, ctx) => {
        const index = state.requests.findIndex((r) => r.id === id);
        if (index < 0) throw new DomainError('NOT_FOUND', 'This request could not be found.', 404);
        const hash = await sha256(canonicalJson(command)),
          receiptKey = `${actorId}:${id}:${command.action}:${key}`,
          receipt = state.receipts[receiptKey];
        if (receipt) {
          if (receipt.hash !== hash)
            throw new DomainError(
              'KEY_REUSED',
              'This command key was reused with different content.',
              409,
            );
          return state.requests[index];
        }
        if (command.action === 'review') {
          const recent = state.requests
            .flatMap((r) => r.events)
            .filter((e) => e.action === 'review');
          if (
            recent.filter(
              (e) => e.actorId === actorId && Date.now() - Date.parse(e.createdAt) < 3600000,
            ).length >= 10 ||
            recent.filter((e) => Date.now() - Date.parse(e.createdAt) < 86400000).length >= 50
          )
            throw new DomainError(
              'RATE_LIMIT',
              'The review limit has been reached. Try again later.',
              429,
            );
        }
        const files = state.files.filter((f) => f.requestId === id);
        const next = await applyDemoCommand(
          state.requests[index],
          command,
          ctx,
          new Date().toISOString(),
          files,
        );
        state.requests[index] = next;
        state.receipts[receiptKey] = { hash, requestId: id };
        return next;
      });
    },
    async upload(id, file) {
      const type = validateFile(
        new Uint8Array(await file.slice(0, 16).arrayBuffer()),
        file.type,
        file.size,
      );
      await read();
      return lock(async () => {
        const db = await database(),
          state = stateSchema.parse(await db.get('state', 'workspace')),
          ctx = actorContext(state, actorId),
          record = state.requests.find((r) => r.id === id);
        if (!record || record.authorId !== ctx.currentUser.id || record.archived)
          throw new DomainError(
            'FORBIDDEN',
            'Only the author can upload to an active request.',
            403,
          );
        if (state.files.filter((f) => f.requestId === id).length >= 5)
          throw new DomainError('FILE_LIMIT', 'This request already has 5 retained files.');
        if (state.files.reduce((n, f) => n + f.size, 0) + file.size > 700_000_000)
          throw new DomainError('STORAGE_LIMIT', 'The workspace file limit has been reached.');
        const metadata = {
          id: crypto.randomUUID(),
          name: file.name,
          type,
          size: file.size,
          requestId: id,
        };
        state.files.push(metadata);
        const tx = db.transaction(['state', 'blobs'], 'readwrite');
        await tx.objectStore('blobs').put(file, metadata.id);
        await tx.objectStore('state').put(state, 'workspace');
        await tx.done;
        return metadata;
      });
    },
    async download(id) {
      const state = await read();
      actorContext(state, actorId);
      const meta = state.files.find((f) => f.id === id);
      const blob = await (await database()).get('blobs', id);
      if (!meta || !blob) throw new DomainError('FILE_NOT_FOUND', 'This file is unavailable.', 404);
      const url = URL.createObjectURL(blob);
      return { url, name: meta.name, revoke: () => URL.revokeObjectURL(url) };
    },
    async invite(email, role) {
      return mutate(async (state, ctx) => {
        if (ctx.currentUser.role !== 'admin')
          throw new DomainError('FORBIDDEN', 'Administrator access is required.', 403);
        const valid = z.email().parse(email.trim().toLowerCase());
        if (
          state.invitations.some(
            (i) => i.email === valid && !i.consumed && Date.parse(i.expiresAt) > Date.now(),
          )
        )
          throw new DomainError(
            'INVITATION_EXISTS',
            'An active invitation already exists for this email.',
          );
        state.invitations.push({
          id: crypto.randomUUID(),
          email: valid,
          role,
          expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
          consumed: false,
        });
      });
    },
    async changeMember(id, role, status) {
      return mutate(async (state, ctx) => {
        if (ctx.currentUser.role !== 'admin')
          throw new DomainError('FORBIDDEN', 'Administrator access is required.', 403);
        const member = state.context.members.find((m) => m.id === id);
        if (!member) throw new DomainError('NOT_FOUND', 'Member not found.', 404);
        if (
          member.role === 'admin' &&
          member.status === 'active' &&
          (status !== 'active' || role !== 'admin') &&
          state.context.members.filter((m) => m.role === 'admin' && m.status === 'active')
            .length === 1
        )
          throw new DomainError(
            'LAST_ADMIN',
            'Assign another administrator before removing this one.',
          );
        member.role = role;
        member.status = status;
      });
    },
    async publishChecklist(name) {
      return mutate(async (state, ctx) => {
        if (ctx.currentUser.role !== 'admin')
          throw new DomainError('FORBIDDEN', 'Administrator access is required.', 403);
        state.context.checklist = {
          id: crypto.randomUUID(),
          name: z.string().trim().min(1).max(100).parse(name),
          requiredFields: baselineFields,
          createdAt: new Date().toISOString(),
        };
      });
    },
    async signOut() {
      localStorage.removeItem('handoffcheck-demo-user');
    },
    async workspaceConnection() {
      return null;
    },
    async googleDocument() {
      return null;
    },
    async setWorkspaceEnabled() {
      throw new DomainError('DEMO_ONLY', 'Google Workspace is available in the hosted workspace.');
    },
  };
}
export async function resetDemo(): Promise<void> {
  await lock(async () => {
    const db = await database();
    const tx = db.transaction(['state', 'blobs'], 'readwrite');
    await tx.objectStore('state').clear();
    await tx.objectStore('blobs').clear();
    await tx.done;
  });
}
export function draftFromRecord(record: RequestRecord): DraftInput {
  const rev = currentRevision(record);
  return {
    fields: rev.fields,
    productReviewerId: rev.productReviewerId,
    engineeringReviewerId: rev.engineeringReviewerId,
    checklistVersion: rev.checklistVersion,
    fileIds: rev.files.map((f) => f.id),
  };
}
