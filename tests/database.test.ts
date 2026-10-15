import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contextSchema, requestSchema, type RequestRecord } from '../shared/contracts';
import { canonicalJson, sha256, snapshotInput } from '../shared/domain';
import { draft, ids } from './fixtures';
import { defaultPolicy, taskSchema } from '../shared/automation';
import { ticketPreviewSchema } from '../shared/linear';

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
  // Match Supabase's inherited public-table grants rather than an empty PostgreSQL default.
  await db.exec(
    'alter default privileges in schema public grant all on tables to anon,authenticated;',
  );
  for (const name of [
    '202610130001_initial.sql',
    '202610130002_workflows.sql',
    '202610130003_google_workspace.sql',
    '20261014132532_workflow_automation.sql',
    '20261014134956_linear_handoff.sql',
    '20261014175903_automation_grants.sql',
    '20261015053325_intake_form_link.sql',
    '20261015070000_review_retry.sql',
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
  it('revokes inherited truncate and write privileges on new automation tables', async () => {
    for (const table of [
      'automation_policies',
      'automation_jobs',
      'ai_usage',
      'in_app_notifications',
      'automation_nonces',
      'linear_connections',
      'linear_handoffs',
    ]) {
      const result = (
        await db.query<{ member: boolean; anonymous: boolean }>(
          'select has_table_privilege($1,$3,$4) as member,has_table_privilege($2,$3,$4) as anonymous',
          ['authenticated', 'anon', `public.${table}`, 'TRUNCATE'],
        )
      ).rows[0];
      expect(result).toEqual({ member: false, anonymous: false });
      await expect(actor(ids.author, `truncate public.${table} cascade`)).rejects.toThrow(
        'permission denied',
      );
    }
    await expect(actor(ids.author, 'select * from public.ai_usage')).rejects.toThrow(
      'permission denied',
    );
  });
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
    const formUrl = 'https://docs.google.com/forms/d/e/published_1234567890/viewform';
    expect(await rpc(ids.admin, 'handoff_workspace_connection', [], [])).toHaveProperty(
      'formUrl',
      null,
    );
    for (const invalid of [
      'https://example.com/forms/d/e/published_1234567890/viewform',
      'https://docs.google.com/forms/d/form_1234567890/edit',
      null,
    ])
      await expect(bridge('configure', { ...assets, formUrl: invalid })).rejects.toThrow(
        'INVALID_INPUT',
      );
    await bridge('configure', { ...assets, formUrl });
    await bridge('configure', assets);
    expect(await rpc(ids.admin, 'handoff_workspace_connection', [], [])).toHaveProperty(
      'formUrl',
      formUrl,
    );
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
      )) as { record: unknown; jobId: string; claimed: boolean; queued?: boolean };
    const key = crypto.randomUUID(),
      claim = await start(key);
    expect(claim.queued).toBe(true);
    expect(claim.claimed).toBe(false);
    const leaseFor = async (jobId: string) =>
      (
        await db.query<{ runId: string; leaseToken: string }>(
          'select r.id as "runId",r.lease_token as "leaseToken" from public.review_runs r join public.automation_jobs j on j.review_id=r.id where j.id=$1',
          [jobId],
        )
      ).rows[0];
    const lease = await leaseFor(claim.jobId);
    expect((await start(key)).claimed).toBe(false);
    await expect(
      rpc(
        ids.author,
        'handoff_finish_review',
        [lease.runId, lease.leaseToken, null, null, null],
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
      lease.runId,
      lease.leaseToken,
      invalid,
      'test-model',
    ]);
    record = requestSchema.parse(await rpc(ids.author, 'handoff_get', [record.id], ['uuid']));
    expect(record.status).toBe('review_error');
    const stale = await start();
    const staleLease = await leaseFor(stale.jobId);
    record = await command(ids.author, record, { action: 'save', draft: draft() });
    await db.query('select public.handoff_finish_review($1,$2,$3,null,$4)', [
      staleLease.runId,
      staleLease.leaseToken,
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
  it('keeps automation settings admin-only, accepts edits through immutable revisions and rejects stale leases', async () => {
    await db.exec(
      "update public.review_runs set created_at=now()-interval '2 hours'; update public.automation_jobs set created_at=now()-interval '2 hours',state='cancelled' where state in ('queued','working');",
    );
    const policy = {
      ...defaultPolicy,
      aiEnabled: true,
      suggestions: true,
      summaries: true,
      qa: true,
      expectedVersion: 1,
    };
    await expect(rpc(ids.author, 'automation_set_policy', [policy], ['jsonb'])).rejects.toThrow(
      'FORBIDDEN',
    );
    await rpc(ids.admin, 'automation_set_policy', [policy], ['jsonb']);
    let record = await create();
    await expect(
      rpc(
        ids.admin,
        'automation_request',
        [record.id, 'edits', 1, null],
        ['uuid', 'text', 'integer', 'uuid'],
      ),
    ).rejects.toThrow('FORBIDDEN');
    const job = taskSchema.parse(
      await rpc(
        ids.author,
        'automation_request',
        [record.id, 'edits', 1, null],
        ['uuid', 'text', 'integer', 'uuid'],
      ),
    );
    expect(
      await rpc(
        ids.product,
        'automation_request',
        [record.id, 'edits', 1, null],
        ['uuid', 'text', 'integer', 'uuid'],
      ),
    ).toEqual(job);
    await expect(
      rpc(ids.author, 'automation_claim', [ids.workspace, job.id], ['uuid', 'uuid']),
    ).rejects.toThrow('permission denied');
    const claim = (
      await db.query<{ value: { leaseToken: string } }>(
        'select public.automation_claim($1,$2) as value',
        [ids.workspace, job.id],
      )
    ).rows[0].value;
    const output = {
      edits: [
        {
          field: 'behavior',
          evidenceField: 'behavior',
          evidenceQuote: draft().fields.behavior,
          text: 'Clarified expected behavior.',
          reason: 'Specific wording.',
        },
      ],
    };
    await expect(
      db.query('select public.automation_finish($1,$2,$3,null,$4)', [
        job.id,
        claim.leaseToken,
        { edits: [{ ...output.edits[0], evidenceQuote: 'fabricated' }] },
        'mock-model',
      ]),
    ).rejects.toThrow('INVALID_AI_OUTPUT');
    await db.query('select public.automation_finish($1,$2,$3,null,$4)', [
      job.id,
      claim.leaseToken,
      output,
      'mock-model',
    ]);
    await expect(
      rpc(ids.product, 'automation_accept_edit', [job.id, 0, 1], ['uuid', 'integer', 'integer']),
    ).rejects.toThrow('FORBIDDEN');
    record = requestSchema.parse(
      await rpc(
        ids.author,
        'automation_accept_edit',
        [job.id, 0, 1],
        ['uuid', 'integer', 'integer'],
      ),
    );
    expect(record.currentRevision).toBe(2);
    expect(record.revisions[1].fields.behavior).toBe('Clarified expected behavior.');
    expect(record.currentReviewId).toBeNull();
    const tasks = (await rpc(ids.author, 'automation_tasks', [record.id], ['uuid'])) as object[];
    expect(taskSchema.parse(tasks[0])).toMatchObject({ state: 'outdated', accepted: [0] });
    expect(tasks[0]).not.toHaveProperty('leaseToken');
    const summary = taskSchema.parse(
      await rpc(
        ids.author,
        'automation_request',
        [record.id, 'summary', 2, null],
        ['uuid', 'text', 'integer', 'uuid'],
      ),
    );
    const lease = (
      await db.query<{ value: { leaseToken: string } }>(
        'select public.automation_claim($1,$2) as value',
        [ids.workspace, summary.id],
      )
    ).rows[0].value;
    record = await command(ids.author, record, { action: 'save', draft: draft() });
    await expect(
      db.query('select public.automation_finish($1,$2,$3,null,$4)', [
        summary.id,
        lease.leaseToken,
        { items: [] },
        'mock-model',
      ]),
    ).rejects.toThrow('INVALID_LEASE');
    await rpc(
      ids.admin,
      'automation_set_policy',
      [{ ...policy, aiEnabled: false, expectedVersion: 2 }],
      ['jsonb'],
    );
  });
  it('generates one brief after the second approval, binds QA to its source and keeps reminders recipient-only', async () => {
    const policy = {
      ...defaultPolicy,
      aiEnabled: false,
      suggestions: true,
      summaries: true,
      qa: true,
      autoBrief: true,
      reminders: true,
      reminderHours: 1,
      expectedVersion: 3,
    };
    await rpc(ids.admin, 'automation_set_policy', [policy], ['jsonb']);
    let record = await review(await create());
    await db.query("update public.requests set updated_at=now()-interval '2 hours' where id=$1", [
      record.id,
    ]);
    await db.query('select public.automation_remind($1)', [ids.workspace]);
    await db.query('select public.automation_remind($1)', [ids.workspace]);
    const notifications = (await rpc(ids.product, 'automation_notifications', [], [])) as {
      id: string;
      requestId: string;
    }[];
    const n = notifications.filter((n) => n.requestId === record.id);
    expect(n).toHaveLength(1);
    await expect(
      rpc(ids.author, 'automation_read_notification', [n[0].id], ['uuid']),
    ).rejects.toThrow('NOT_FOUND');
    record = await command(ids.product, record, {
      action: 'approve',
      reviewId: record.currentReviewId,
      stage: 'product',
    });
    expect(record.briefs).toHaveLength(0);
    record = await command(ids.engineering, record, {
      action: 'approve',
      reviewId: record.currentReviewId,
      stage: 'engineering',
    });
    expect(record.briefs).toHaveLength(1);
    expect(record.status).toBe('brief_ready');
    await rpc(
      ids.admin,
      'automation_set_policy',
      [{ ...policy, aiEnabled: true, expectedVersion: 4 }],
      ['jsonb'],
    );
    const job = taskSchema.parse(
      await rpc(
        ids.author,
        'automation_request',
        [record.id, 'qa', 1, record.briefs[0].id],
        ['uuid', 'text', 'integer', 'uuid'],
      ),
    );
    const claim = (
      await db.query<{ value: { leaseToken: string } }>(
        'select public.automation_claim($1,$2) as value',
        [ids.workspace, job.id],
      )
    ).rows[0].value;
    await db.query('select public.automation_finish($1,$2,$3,null,$4)', [
      job.id,
      claim.leaseToken,
      {
        tests: [
          {
            criterionIndex: 0,
            criterionQuote: draft().fields.criteria[0],
            kind: 'positive',
            scenario: 'Check criterion',
            steps: ['Run test'],
            expected: 'Criterion satisfied',
          },
        ],
      },
      'mock-model',
    ]);
    await expect(rpc(ids.product, 'automation_review_qa', [job.id], ['uuid'])).rejects.toThrow(
      'FORBIDDEN',
    );
    await rpc(ids.engineering, 'automation_review_qa', [job.id], ['uuid']);
    record = await command(ids.author, record, { action: 'save', draft: draft() });
    const tasks = (await rpc(ids.author, 'automation_tasks', [record.id], ['uuid'])) as object[];
    expect(taskSchema.parse(tasks[0])).toMatchObject({
      state: 'ready',
      revision: 1,
      reviewedBy: ids.engineering,
    });
    await rpc(
      ids.admin,
      'automation_set_policy',
      [{ ...policy, aiEnabled: false, expectedVersion: 5 }],
      ['jsonb'],
    );
  });
  it('cancels revoked work, enforces attempt budgets and bounds transient retries', async () => {
    const policy = {
      ...defaultPolicy,
      aiEnabled: true,
      suggestions: true,
      summaries: true,
      dailyLimit: 50,
      expectedVersion: 6,
    };
    await rpc(ids.admin, 'automation_set_policy', [policy], ['jsonb']);
    const record = await create();
    const job = taskSchema.parse(
      await rpc(
        ids.author,
        'automation_request',
        [record.id, 'summary', 1, null],
        ['uuid', 'text', 'integer', 'uuid'],
      ),
    );
    const claim = async () =>
      (
        await db.query<{ value: { leaseToken: string } | null }>(
          'select public.automation_claim($1,$2) as value',
          [ids.workspace, job.id],
        )
      ).rows[0].value;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const lease = await claim();
      expect(lease).not.toBeNull();
      await db.query('select public.automation_finish($1,$2,null,$3,null,true)', [
        job.id,
        lease!.leaseToken,
        'Transient failure',
      ]);
      await db.query('update public.automation_jobs set next_attempt=now() where id=$1', [job.id]);
    }
    expect(
      (
        await db.query<{ state: string }>('select state from public.automation_jobs where id=$1', [
          job.id,
        ])
      ).rows[0].state,
    ).toBe('failed');
    const next = taskSchema.parse(
      await rpc(
        ids.author,
        'automation_request',
        [record.id, 'edits', 1, null],
        ['uuid', 'text', 'integer', 'uuid'],
      ),
    );
    await db.query("update public.memberships set status='revoked' where user_id=$1", [ids.author]);
    expect(
      (
        await db.query<{ value: unknown }>('select public.automation_claim($1,$2) as value', [
          ids.workspace,
          next.id,
        ])
      ).rows[0].value,
    ).toBeNull();
    expect(
      (
        await db.query<{ state: string }>('select state from public.automation_jobs where id=$1', [
          next.id,
        ])
      ).rows[0].state,
    ).toBe('cancelled');
    await db.query("update public.memberships set status='active' where user_id=$1", [ids.author]);
    await rpc(
      ids.admin,
      'automation_set_policy',
      [{ ...policy, dailyLimit: 1, expectedVersion: 7 }],
      ['jsonb'],
    );
    const limited = taskSchema.parse(
      await rpc(
        ids.author,
        'automation_request',
        [record.id, 'edits', 1, null],
        ['uuid', 'text', 'integer', 'uuid'],
      ),
    );
    expect(
      (
        await db.query<{ value: unknown }>('select public.automation_claim($1,$2) as value', [
          ids.workspace,
          limited.id,
        ])
      ).rows[0].value,
    ).toBeNull();
    expect(
      (
        await db.query<{ attempts: number }>(
          'select attempts from public.automation_jobs where id=$1',
          [limited.id],
        )
      ).rows[0].attempts,
    ).toBe(0);
    await rpc(
      ids.admin,
      'automation_set_policy',
      [{ ...policy, aiEnabled: false, expectedVersion: 8 }],
      ['jsonb'],
    );
  });
  it('limits concurrent AI leases and counts retries toward the actor hourly budget', async () => {
    // Advance unrelated quota fixtures out of the hourly window before this independent scenario.
    await db.exec(
      "update public.automation_jobs set created_at=now()-interval '2 hours'; update public.ai_usage set created_at=now()-interval '2 hours';",
    );
    await rpc(
      ids.admin,
      'automation_set_policy',
      [
        {
          ...defaultPolicy,
          aiEnabled: true,
          suggestions: true,
          summaries: true,
          expectedVersion: 9,
        },
      ],
      ['jsonb'],
    );
    const one = await create(),
      two = await create();
    const enqueue = async (actorId: string, record: RequestRecord, kind: string) =>
      taskSchema.parse(
        await rpc(
          actorId,
          'automation_request',
          [record.id, kind, 1, null],
          ['uuid', 'text', 'integer', 'uuid'],
        ),
      );
    const a = await enqueue(ids.author, one, 'summary'),
      b = await enqueue(ids.author, two, 'summary'),
      c = await enqueue(ids.product, one, 'edits');
    const claim = async (id: string) =>
      (
        await db.query<{ value: { leaseToken: string } | null }>(
          'select public.automation_claim($1,$2) as value',
          [ids.workspace, id],
        )
      ).rows[0].value;
    const first = await claim(a.id),
      second = await claim(b.id);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(await claim(c.id)).toBeNull();
    for (const [id, lease] of [
      [a.id, first!.leaseToken],
      [b.id, second!.leaseToken],
    ])
      await db.query('select public.automation_finish($1,$2,null,$3,null)', [
        id,
        lease,
        'Mocked failure',
      ]);
    const third = await claim(c.id);
    expect(third).not.toBeNull();
    await db.query('select public.automation_finish($1,$2,null,$3,null)', [
      c.id,
      third!.leaseToken,
      'Mocked failure',
    ]);
    const limited = await enqueue(ids.author, two, 'edits');
    await db.query(
      "insert into public.ai_usage(workspace_id,actor_id,attempt) select $1,$2,1 from generate_series(1,greatest(0,10-(select count(*)::integer from public.ai_usage where actor_id=$2 and created_at>now()-interval '1 hour')))",
      [ids.workspace, ids.author],
    );
    expect(await claim(limited.id)).toBeNull();
    expect(
      (
        await db.query<{ state: string; error: string }>(
          'select state,error from public.automation_jobs where id=$1',
          [limited.id],
        )
      ).rows[0],
    ).toMatchObject({ state: 'failed', error: expect.stringContaining('hourly') });
    await rpc(
      ids.admin,
      'automation_set_policy',
      [{ ...defaultPolicy, aiEnabled: false, autoBrief: true, expectedVersion: 10 }],
      ['jsonb'],
    );
  });
  it('confirms exact Linear payloads, fences concurrent sends and retries with one persisted issue ID', async () => {
    const team = crypto.randomUUID(),
      org = crypto.randomUUID();
    await expect(rpc(ids.author, 'linear_admin', [], [])).rejects.toThrow('FORBIDDEN');
    await expect(
      rpc(
        ids.admin,
        'linear_configure',
        [ids.admin, ids.workspace, org, 'Pilot', team, 'Engineering', 0],
        ['uuid', 'uuid', 'uuid', 'text', 'uuid', 'text', 'integer'],
      ),
    ).rejects.toThrow('permission denied');
    await db.query('select public.linear_configure($1,$2,$3,$4,$5,$6,0)', [
      ids.admin,
      ids.workspace,
      org,
      'Pilot',
      team,
      'Engineering',
    ]);
    await db.exec(
      "update public.review_runs set created_at=now()-interval '2 hours'; update public.workspaces set review_mode='checklist_only';",
    );
    let record = await review(await create());
    record = await command(ids.product, record, {
      action: 'approve',
      reviewId: record.currentReviewId,
      stage: 'product',
    });
    record = await command(ids.engineering, record, {
      action: 'approve',
      reviewId: record.currentReviewId,
      stage: 'engineering',
    });
    record = await command(ids.author, record, { action: 'generate' });
    const brief = record.briefs[0],
      preview = ticketPreviewSchema.parse(
        await rpc(ids.author, 'linear_preview', [brief.id], ['uuid']),
      );
    expect(preview.description).toContain(brief.markdown);
    expect(preview.contentHash).toBe(brief.contentHash);
    await expect(
      db.query('select public.linear_claim($1,$2,$3)', [ids.admin, brief.id, preview.payloadHash]),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      db.query('select public.linear_claim($1,$2,$3)', [ids.author, brief.id, '0'.repeat(64)]),
    ).rejects.toThrow('PAYLOAD_CHANGED');
    const claim = async () =>
      (
        await db.query<{
          value: { id: string; issueId: string; leaseToken: string; created: boolean };
        }>('select public.linear_claim($1,$2,$3) as value', [
          ids.author,
          brief.id,
          preview.payloadHash,
        ])
      ).rows[0].value;
    const first = await claim();
    await expect(claim()).rejects.toThrow('HANDOFF_RUNNING');
    await db.query('select public.linear_finish($1,$2,null,null,$3)', [
      first.id,
      first.leaseToken,
      'Provider timeout',
    ]);
    await db.query('select public.linear_configure($1,$2,$3,$4,$5,$6,1)', [
      ids.admin,
      ids.workspace,
      org,
      'Pilot',
      crypto.randomUUID(),
      'Different team',
    ]);
    await expect(claim()).rejects.toThrow('DESTINATION_CHANGED');
    await db.query('select public.linear_configure($1,$2,$3,$4,$5,$6,2)', [
      ids.admin,
      ids.workspace,
      org,
      'Pilot',
      team,
      'Engineering',
    ]);
    const second = await claim();
    expect(second.issueId).toBe(first.issueId);
    await expect(
      rpc(
        ids.author,
        'linear_check_outbound',
        [second.id, second.leaseToken, ids.author],
        ['uuid', 'uuid', 'uuid'],
      ),
    ).rejects.toThrow('permission denied');
    await db.query('select public.linear_check_outbound($1,$2,$3)', [
      second.id,
      second.leaseToken,
      ids.author,
    ]);
    await db.query("update public.memberships set status='revoked' where user_id=$1", [ids.author]);
    await expect(
      db.query('select public.linear_check_outbound($1,$2,$3)', [
        second.id,
        second.leaseToken,
        ids.author,
      ]),
    ).rejects.toThrow('FORBIDDEN');
    await db.query("update public.memberships set status='active' where user_id=$1", [ids.author]);
    await expect(
      db.query('select public.linear_finish($1,$2,$3,$4,null)', [
        first.id,
        first.leaseToken,
        'https://linear.app/pilot/issue/ENG-1',
        'ENG-1',
      ]),
    ).rejects.toThrow('INVALID_LEASE');
    await db.query('select public.linear_finish($1,$2,$3,$4,null)', [
      second.id,
      second.leaseToken,
      'https://linear.app/pilot/issue/ENG-1',
      'ENG-1',
    ]);
    expect((await claim()).created).toBe(true);
    expect(
      ticketPreviewSchema.parse(await rpc(ids.product, 'linear_preview', [brief.id], ['uuid']))
        .state,
    ).toBe('created');
    await expect(actor(ids.author, 'select * from public.linear_handoffs')).rejects.toThrow(
      'permission denied',
    );
  });
  it('retries temporary review failures with a budgeted cap, without allowing early approval', async () => {
    await db.exec(
      "update public.review_runs set created_at=now()-interval '2 hours'; update public.ai_usage set created_at=now()-interval '2 days'; update public.automation_jobs set state='cancelled' where state in ('queued','working'); update public.workspaces set review_mode='ai'; update public.automation_policies set daily_limit=50;",
    );
    const start = async () => {
      const record = await create();
      const result = (await rpc(
        ids.author,
        'handoff_start_review',
        [record.id, 1, crypto.randomUUID()],
        ['uuid', 'integer', 'text'],
      )) as { record: unknown; jobId: string };
      return { record: requestSchema.parse(result.record), id: result.jobId };
    };
    const claim = async (id: string) =>
      (
        await db.query<{ value: { leaseToken: string; attempts: number } | null }>(
          'select public.automation_claim($1,$2) as value',
          [ids.workspace, id],
        )
      ).rows[0].value;
    const finish = async (id: string, lease: string, retry: boolean, error: string | null) =>
      db.query('select public.automation_finish($1,$2,$3,$4,$5,$6)', [
        id,
        lease,
        error
          ? null
          : { schema_version: '1', findings: [], potential_misunderstandings: [], unknowns: [] },
        error,
        'mock-model',
        retry,
      ]);
    const first = await start();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const lease = (await claim(first.id))!;
      expect(lease.attempts).toBe(attempt);
      await finish(
        first.id,
        lease.leaseToken,
        attempt < 3,
        attempt < 3 ? 'Gemini unavailable (HTTP 503).' : null,
      );
      const record = requestSchema.parse(
        await rpc(ids.author, 'handoff_get', [first.record.id], ['uuid']),
      );
      if (attempt < 3) {
        expect(record.status).toBe('reviewing');
        expect(record.reviews.at(-1)?.state).toBe('running');
        await expect(
          command(ids.product, record, {
            action: 'approve',
            stage: 'product',
            reviewId: record.currentReviewId,
          }),
        ).rejects.toThrow('NOT_READY');
        const job = (
          await db.query<{ state: string; delayed: boolean }>(
            'select state,next_attempt>now() as delayed from public.automation_jobs where id=$1',
            [first.id],
          )
        ).rows[0];
        expect(job).toEqual({ state: 'queued', delayed: true });
        expect(await claim(first.id)).toBeNull();
        await db.query(
          "update public.automation_jobs set next_attempt=now()-interval '1 second' where id=$1",
          [first.id],
        );
      } else {
        expect(record.status).toBe('ready_for_approval');
        expect(record.approvals).toHaveLength(0);
      }
    }
    expect(
      (
        await db.query<{ n: number }>(
          'select count(*)::integer as n from public.ai_usage where job_id=$1',
          [first.id],
        )
      ).rows[0].n,
    ).toBe(3);
    const exhausted = await start();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const lease = (await claim(exhausted.id))!;
      await finish(exhausted.id, lease.leaseToken, true, 'Gemini unavailable (HTTP 503).');
      await db.query(
        "update public.automation_jobs set next_attempt=now()-interval '1 second' where id=$1",
        [exhausted.id],
      );
    }
    expect(await claim(exhausted.id)).toBeNull();
    expect(
      requestSchema.parse(await rpc(ids.author, 'handoff_get', [exhausted.record.id], ['uuid']))
        .status,
    ).toBe('review_error');
    const denied = await start(),
      deniedLease = (await claim(denied.id))!;
    await finish(denied.id, deniedLease.leaseToken, false, 'Gemini denied access.');
    expect(await claim(denied.id)).toBeNull();
    await db.exec(
      "update public.ai_usage set created_at=now()-interval '2 days'; update public.automation_policies set daily_limit=1;",
    );
    const limited = await start(),
      limitedLease = (await claim(limited.id))!;
    await finish(limited.id, limitedLease.leaseToken, true, 'Gemini unavailable (HTTP 503).');
    await db.query(
      "update public.automation_jobs set next_attempt=now()-interval '1 second' where id=$1",
      [limited.id],
    );
    expect(await claim(limited.id)).toBeNull();
    expect(
      requestSchema.parse(await rpc(ids.author, 'handoff_get', [limited.record.id], ['uuid']))
        .status,
    ).toBe('review_error');
    expect(
      (
        await db.query<{ n: number }>(
          'select count(*)::integer as n from public.ai_usage where job_id=$1',
          [limited.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await db.query<{ allowed: boolean }>(
          "select has_function_privilege('authenticated','public.automation_finish(uuid,uuid,jsonb,text,text,boolean,jsonb)','EXECUTE') as allowed",
        )
      ).rows[0].allowed,
    ).toBe(false);
    await db.exec(
      "update public.workspaces set review_mode='checklist_only'; update public.automation_policies set daily_limit=50;",
    );
  });
});
