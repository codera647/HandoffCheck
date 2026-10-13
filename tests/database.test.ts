import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contextSchema, requestSchema, type RequestRecord } from '../shared/contracts';
import { canonicalJson, sha256, snapshotInput } from '../shared/domain';
import { draft, ids } from './fixtures';

let db: PGlite;
async function actor<T>(id: string, sql: string, params: unknown[] = []): Promise<T> {
  await db.exec('begin; set local role authenticated;');
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [id]);
    const result = await db.query<{ value: T }>(sql, params);
    await db.exec('commit');
    return result.rows[0]?.value;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}
const rpc = (id: string, name: string, args: unknown[], casts: string[]) =>
  actor<unknown>(
    id,
    `select public.${name}(${casts.map((c, i) => `$${i + 1}::${c}`).join(',')}) as value`,
    args,
  );
async function create() {
  return requestSchema.parse(
    await rpc(ids.author, 'handoff_create', [draft(), crypto.randomUUID()], ['jsonb', 'text']),
  );
}
async function command(
  id: string,
  record: RequestRecord,
  input: object,
  key = crypto.randomUUID(),
) {
  return requestSchema.parse(
    await rpc(
      id,
      'handoff_command',
      [record.id, { expectedRevision: record.currentRevision, ...input }, key],
      ['uuid', 'jsonb', 'text'],
    ),
  );
}
async function review(record: RequestRecord) {
  const result = (await rpc(
    ids.author,
    'handoff_start_review',
    [record.id, record.currentRevision, crypto.randomUUID()],
    ['uuid', 'integer', 'text'],
  )) as { record: unknown };
  return requestSchema.parse(result.record);
}
beforeAll(async () => {
  db = new PGlite();
  // Supabase services are stubs; policies and workflow SQL run in real PostgreSQL.
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
    create table auth.identities(user_id uuid references auth.users(id),provider text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public,storage to authenticated,anon,service_role; grant execute on function auth.uid() to authenticated,anon,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name)); alter table storage.objects enable row level security;
    grant select,insert,update,delete on storage.objects to authenticated;`);
  for (const name of [
    '202610130001_initial.sql',
    '202610130002_workflows.sql',
    '202610130003_google_workspace.sql',
  ]) {
    const source = await readFile(`supabase/migrations/${name}`, 'utf8');
    try {
      await db.exec(source);
    } catch (error) {
      const details = error as {
        message: string;
        position?: string;
        internalQuery?: string;
        internalPosition?: string;
        where?: string;
      };
      const at = Number(details.position) || 0;
      throw new Error(
        `${name}: ${details.message}; ${details.where || ''}; ${details.internalQuery || source.slice(Math.max(0, at - 200), at + 200)}`,
      );
    }
  }
  for (const [name, id] of Object.entries(ids).filter(
    ([name]) => !['workspace', 'checklist'].includes(name),
  ))
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [
      id,
      `${name}@example.com`,
    ]);
  await db.query('insert into public.workspaces(id,name) values($1,$2)', [ids.workspace, 'Pilot']);
  await db.query('insert into public.checklist_versions(id,workspace_id,name) values($1,$2,$3)', [
    ids.checklist,
    ids.workspace,
    'Pilot v1',
  ]);
  for (const [id, role] of [
    [ids.author, 'member'],
    [ids.product, 'product_lead'],
    [ids.engineering, 'engineering_lead'],
    [ids.admin, 'admin'],
  ])
    await db.query(
      'insert into public.memberships(workspace_id,user_id,name,role) values($1,$2,$3,$4)',
      [ids.workspace, id, role, role],
    );
}, 60000);
afterAll(async () => {
  await db?.close();
});

describe('database access and workflow', () => {
  it('serializes valid context and creates server-hashed immutable revisions', async () => {
    contextSchema.parse(await rpc(ids.author, 'handoff_context', [], []));
    const record = await create();
    expect(record.revisions[0].inputHash).toBe(
      await sha256(canonicalJson(snapshotInput(record.revisions[0]))),
    );
    expect(
      (await db.query<{ value: string }>('select public.md($1) as value', ['<script> *bold*']))
        .rows[0].value,
    ).toBe('\\<script\\> \\*bold\\*');
  });
  it('denies direct table writes, outsider reads and missing expected revisions', async () => {
    const record = await create();
    await expect(
      actor(ids.author, 'insert into public.approvals default values returning id as value'),
    ).rejects.toThrow('permission denied');
    await expect(rpc(ids.outsider, 'handoff_get', [record.id], ['uuid'])).rejects.toThrow(
      'NOT_FOUND',
    );
    const rows = await actor(
      ids.outsider,
      'select count(*)::integer as value from public.requests',
    );
    expect(rows).toBe(0);
    await expect(
      rpc(
        ids.author,
        'handoff_command',
        [record.id, { action: 'comment', body: 'Bypass' }, crypto.randomUUID()],
        ['uuid', 'jsonb', 'text'],
      ),
    ).rejects.toThrow('REVISION_CHANGED');
  });
  it('retries create safely and rejects changed payloads under the same key', async () => {
    const key = crypto.randomUUID(),
      a = await rpc(ids.author, 'handoff_create', [draft(), key], ['jsonb', 'text']),
      b = await rpc(ids.author, 'handoff_create', [draft(), key], ['jsonb', 'text']);
    expect(a).toEqual(b);
    const changed = draft();
    changed.fields.title = 'Different';
    await expect(
      rpc(ids.author, 'handoff_create', [changed, key], ['jsonb', 'text']),
    ).rejects.toThrow('KEY_REUSED');
  });
  it('requires two current, distinct leads and invalidates approval after edits', async () => {
    let record = await review(await create());
    await expect(
      command(ids.author, record, {
        action: 'approve',
        reviewId: record.currentReviewId,
        stage: 'product',
      }),
    ).rejects.toThrow('FORBIDDEN');
    record = await command(ids.product, record, {
      action: 'approve',
      reviewId: record.currentReviewId,
      stage: 'product',
    });
    await expect(command(ids.author, record, { action: 'generate' })).rejects.toThrow(
      'NOT_APPROVED',
    );
    await expect(
      command(ids.product, record, {
        action: 'approve',
        reviewId: record.currentReviewId,
        stage: 'engineering',
      }),
    ).rejects.toThrow('FORBIDDEN');
    record = await command(ids.engineering, record, {
      action: 'approve',
      reviewId: record.currentReviewId,
      stage: 'engineering',
    });
    record = await command(ids.author, record, { action: 'generate' });
    expect(record.status).toBe('brief_ready');
    expect(record.briefs[0].contentHash).toBe(await sha256(record.briefs[0].markdown));
    expect(record.briefs[0].markdown).toContain('Given a permitted user');
    record = await command(ids.author, record, { action: 'generate' });
    expect(record.briefs).toHaveLength(1);
    const old = record;
    record = await command(ids.author, record, { action: 'save', draft: draft() });
    expect(record.currentReviewId).toBeNull();
    expect(record.briefs).toHaveLength(1);
    await expect(
      command(ids.product, old, {
        action: 'approve',
        reviewId: old.currentReviewId,
        stage: 'product',
      }),
    ).rejects.toThrow('REVISION_CHANGED');
    await expect(command(ids.author, record, { action: 'generate' })).rejects.toThrow(
      'NOT_APPROVED',
    );
  });
  it('keeps deterministic findings authoritative and requires revision after requested changes', async () => {
    const input = draft();
    input.fields.dataImpact = '';
    let record = requestSchema.parse(
      await rpc(ids.author, 'handoff_create', [input, crypto.randomUUID()], ['jsonb', 'text']),
    );
    record = await review(record);
    expect(record.status).toBe('needs_clarification');
    const finding = record.reviews[0].findings[0];
    await expect(
      command(ids.product, record, {
        action: 'dismiss',
        reviewId: record.currentReviewId,
        findingId: finding.id,
        reason: 'Ignore',
      }),
    ).rejects.toThrow('INVALID_FINDING');
    record = await command(ids.product, record, {
      action: 'changes',
      reason: 'Define data access',
    });
    await expect(review(record)).rejects.toThrow('REVISION_REQUIRED');
  });
  it('prevents removing the last admin and enforces invite-only membership', async () => {
    await expect(
      rpc(
        ids.admin,
        'handoff_change_member',
        [ids.admin, 'member', 'active'],
        ['uuid', 'text', 'text'],
      ),
    ).rejects.toThrow('LAST_ADMIN');
    await expect(
      rpc(ids.author, 'handoff_invite', ['outsider@example.com', 'admin'], ['text', 'text']),
    ).rejects.toThrow('FORBIDDEN');
    await expect(rpc(ids.outsider, 'handoff_accept_membership', [], [])).rejects.toThrow(
      'ACCESS_DENIED',
    );
    await rpc(ids.admin, 'handoff_invite', ['outsider@example.com', 'member'], ['text', 'text']);
    await rpc(ids.outsider, 'handoff_accept_membership', [], []);
    contextSchema.parse(await rpc(ids.outsider, 'handoff_context', [], []));
    await rpc(
      ids.admin,
      'handoff_change_member',
      [ids.outsider, 'member', 'revoked'],
      ['uuid', 'text', 'text'],
    );
    await expect(rpc(ids.outsider, 'handoff_context', [], [])).rejects.toThrow('ACCESS_DENIED');
  });
  it('only permits reserved uploads and refuses browser verification calls', async () => {
    const record = await create();
    await expect(
      rpc(
        ids.product,
        'handoff_reserve_file',
        [record.id, 'test.pdf', 'application/pdf', 12],
        ['uuid', 'text', 'text', 'bigint'],
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      actor(
        ids.author,
        "insert into storage.objects(bucket_id,name) values('request-files','unreserved') returning name as value",
      ),
    ).rejects.toThrow('row-level security');
    const reserved = (await rpc(
      ids.author,
      'handoff_reserve_file',
      [record.id, 'test.pdf', 'application/pdf', 12],
      ['uuid', 'text', 'text', 'bigint'],
    )) as { id: string; path: string };
    await actor(
      ids.author,
      "insert into storage.objects(bucket_id,name) values('request-files',$1)",
      [reserved.path],
    );
    await expect(
      rpc(
        ids.author,
        'handoff_verify_file',
        [reserved.id, ids.author, true],
        ['uuid', 'uuid', 'boolean'],
      ),
    ).rejects.toThrow('permission denied');
    const pending = draft();
    pending.fileIds = [reserved.id];
    await expect(command(ids.author, record, { action: 'save', draft: pending })).rejects.toThrow(
      'FILE_NOT_READY',
    );
  });
  it('imports verified active Google members once and cannot bypass app permissions', async () => {
    await db.query(
      'insert into public.workspace_connections(workspace_id,owner_id) values($1,$2)',
      [ids.workspace, ids.admin],
    );
    const bridge = async (action: string, data: object) =>
      (
        await db.query<{ value: any }>('select public.workspace_bridge($1,$2,$3) as value', [
          ids.workspace,
          action,
          data,
        ])
      ).rows[0].value;
    const assets = {
      formId: 'form_1234567890',
      sheetId: 'sheet_1234567890',
      folderId: 'folder_1234567890',
    };
    await bridge('configure', assets);
    await expect(bridge('configure', { ...assets, formId: 'different_form_123' })).rejects.toThrow(
      'KEY_REUSED',
    );
    await expect(
      rpc(
        ids.author,
        'workspace_bridge',
        [ids.workspace, 'sync', { after: 0 }],
        ['uuid', 'text', 'jsonb'],
      ),
    ).rejects.toThrow('permission denied');
    await expect(rpc(ids.author, 'handoff_workspace_connection', [], [])).rejects.toThrow(
      'FORBIDDEN',
    );
    await expect(actor(ids.admin, 'truncate public.workspace_bridge_nonces')).rejects.toThrow(
      'permission denied',
    );
    await expect(
      actor(ids.admin, 'update public.workspace_connections set owner_id=$1', [ids.author]),
    ).rejects.toThrow('permission denied');
    const input = {
      formId: assets.formId,
      responseId: 'response-one',
      email: 'author@example.com',
      fields: draft().fields,
    };
    await expect(bridge('import', input)).rejects.toThrow('ACCESS_DENIED');
    await db.query("insert into auth.identities(user_id,provider) values($1,'google')", [
      ids.author,
    ]);
    await expect(bridge('import', { ...input, email: 'uninvited@example.com' })).rejects.toThrow(
      'ACCESS_DENIED',
    );
    await expect(bridge('import', { ...input, formId: 'different_form_123' })).rejects.toThrow(
      'FORBIDDEN',
    );
    const result = await bridge('import', input);
    expect(result.imported).toBe(true);
    expect((await bridge('import', input)).requestId).toBe(result.requestId);
    expect((await bridge('import', input)).imported).toBe(false);
    await expect(
      bridge('import', { ...input, fields: { ...input.fields, title: 'Changed' } }),
    ).rejects.toThrow('KEY_REUSED');
    const record = requestSchema.parse(
      await rpc(ids.author, 'handoff_get', [result.requestId], ['uuid']),
    );
    expect(record.authorId).toBe(ids.author);
    expect(record.status).toBe('draft');
    expect(record.productReviewerId).toBe('');
    expect(record.briefs).toEqual([]);
    await expect(command(ids.product, record, { action: 'save', draft: draft() })).rejects.toThrow(
      'FORBIDDEN',
    );
    await db.query("update public.memberships set status='revoked' where user_id=$1", [ids.author]);
    await expect(bridge('import', { ...input, responseId: 'response-two' })).rejects.toThrow(
      'ACCESS_DENIED',
    );
    await db.query("update public.memberships set status='active' where user_id=$1", [ids.author]);
    const nonce = crypto.randomUUID();
    await db.query('select public.workspace_bridge_nonce($1,$2)', [ids.workspace, nonce]);
    await expect(
      db.query('select public.workspace_bridge_nonce($1,$2)', [ids.workspace, nonce]),
    ).rejects.toThrow('REPLAY');
    const page = await bridge('sync', { after: 0 });
    expect(page.requests.some((r: { id: string }) => r.id === result.requestId)).toBe(true);
    expect(page.briefs.every((b: { id: string }) => b.id !== result.requestId)).toBe(true);
    const brief = page.briefs[0];
    expect(brief).toBeDefined();
    await expect(
      bridge('document', {
        briefId: crypto.randomUUID(),
        documentId: 'google_doc_12345',
        contentHash: brief.contentHash,
      }),
    ).rejects.toThrow('NOT_FOUND');
    await expect(
      bridge('document', {
        briefId: brief.id,
        documentId: 'google_doc_12345',
        contentHash: '0'.repeat(64),
      }),
    ).rejects.toThrow('KEY_REUSED');
    await bridge('document', {
      briefId: brief.id,
      documentId: 'google_doc_12345',
      contentHash: brief.contentHash,
    });
    expect(await rpc(ids.author, 'handoff_google_document', [brief.id], ['uuid'])).toMatchObject({
      documentId: 'google_doc_12345',
    });
    await expect(
      bridge('document', {
        briefId: brief.id,
        documentId: 'different_doc_123',
        contentHash: brief.contentHash,
      }),
    ).rejects.toThrow('KEY_REUSED');
    await rpc(ids.admin, 'handoff_workspace_enabled', [false], ['boolean']);
    await expect(bridge('sync', { after: 0 })).rejects.toThrow('ACCESS_DENIED');
    await rpc(ids.admin, 'handoff_workspace_enabled', [true], ['boolean']);
    await db.query("update public.memberships set role='member' where user_id=$1", [ids.admin]);
    await expect(bridge('sync', { after: 0 })).rejects.toThrow('ACCESS_DENIED');
    await db.query("update public.memberships set role='admin' where user_id=$1", [ids.admin]);
  });
  it('rejects invalid provider evidence, fences stale reviews and enforces review quotas', async () => {
    await db.exec(
      "update public.review_runs set created_at=now()-interval '2 hours'; update public.workspaces set review_mode='ai';",
    );
    let record = await create();
    const start = async (key = crypto.randomUUID()) =>
      (await rpc(
        ids.author,
        'handoff_start_review',
        [record.id, record.currentRevision, key],
        ['uuid', 'integer', 'text'],
      )) as { record: unknown; runId: string; leaseToken: string; claimed: boolean };
    const key = crypto.randomUUID(),
      claim = await start(key);
    expect(claim.claimed).toBe(true);
    expect((await start(key)).claimed).toBe(false);
    await expect(
      rpc(
        ids.author,
        'handoff_finish_review',
        [claim.runId, claim.leaseToken, null, null, null],
        ['uuid', 'uuid', 'jsonb', 'text', 'text'],
      ),
    ).rejects.toThrow('permission denied');
    const invalid = {
      schema_version: '1',
      findings: [
        {
          kind: 'ambiguity',
          field: 'scope',
          severity: 'blocking',
          evidence_quote: 'Invented quote',
          question: 'What?',
          explanation: 'Unclear',
        },
      ],
      potential_misunderstandings: [],
      unknowns: [],
    };
    await db.query('select public.handoff_finish_review($1,$2,$3,null,$4)', [
      claim.runId,
      claim.leaseToken,
      invalid,
      'test-model',
    ]);
    record = requestSchema.parse(await rpc(ids.author, 'handoff_get', [record.id], ['uuid']));
    expect(record.status).toBe('review_error');
    const stale = await start();
    record = await command(ids.author, record, { action: 'save', draft: draft() });
    await db.query('select public.handoff_finish_review($1,$2,$3,null,$4)', [
      stale.runId,
      stale.leaseToken,
      { schema_version: '1', findings: [], potential_misunderstandings: [], unknowns: [] },
      'test-model',
    ]);
    record = requestSchema.parse(await rpc(ids.author, 'handoff_get', [record.id], ['uuid']));
    expect(record.status).toBe('draft');
    expect(record.reviews.at(-1)?.state).toBe('superseded');
    await db.exec("update public.workspaces set review_mode='checklist_only';");
    const n = Number(
      (
        await db.query<{ n: number }>(
          "select count(*) as n from public.review_runs where actor_id=$1 and created_at>now()-interval '1 hour'",
          [ids.author],
        )
      ).rows[0].n,
    );
    for (let i = n; i < 10; i++) record = await review(record);
    await expect(review(record)).rejects.toThrow('RATE_LIMIT');
  });
});
