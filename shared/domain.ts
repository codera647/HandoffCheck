import {
  type AppContext,
  type Approval,
  type Command,
  type DraftInput,
  type FeatureFields,
  type FileMeta,
  type Finding,
  type Member,
  type ProviderResponse,
  type RequestRecord,
  type Revision,
  type Review,
  type Status,
  fieldLabels,
  fieldsSchema,
  providerResponseSchema,
} from './contracts.ts';

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
export const statusLabels: Record<Status, string> = {
  draft: 'Draft',
  reviewing: 'Reviewing',
  needs_clarification: 'Needs clarification',
  review_error: 'Review error',
  ready_for_approval: 'Ready for approval',
  partially_approved: 'One approval pending',
  approved: 'Approved',
  brief_ready: 'Brief ready',
};
export const roleLabels = {
  member: 'Member',
  product_lead: 'Product lead',
  engineering_lead: 'Engineering lead',
  admin: 'Administrator',
};
export function currentRevision(record: RequestRecord): Revision {
  const result = record.revisions.find((r) => r.number === record.currentRevision);
  if (!result)
    throw new DomainError('INVALID_REVISION', 'The current revision could not be loaded.', 500);
  return result;
}
export function currentReview(record: RequestRecord): Review | undefined {
  return record.reviews.find((r) => r.id === record.currentReviewId);
}
export function activeApprovals(record: RequestRecord): Approval[] {
  const rev = currentRevision(record);
  return record.approvals.filter(
    (a) =>
      a.reviewId === record.currentReviewId &&
      a.revision === rev.number &&
      a.inputHash === rev.inputHash,
  );
}
export function blockingFindings(review: Review | undefined): Finding[] {
  return review?.findings.filter((f) => f.severity === 'blocking' && !f.resolution) ?? [];
}
export function assignedLead(record: RequestRecord, member: Member): boolean {
  const rev = currentRevision(record);
  return (
    member.status === 'active' &&
    ((member.role === 'product_lead' && rev.productReviewerId === member.id) ||
      (member.role === 'engineering_lead' && rev.engineeringReviewerId === member.id))
  );
}
export function canReview(record: RequestRecord, actor: Member): boolean {
  return actor.id === record.authorId || assignedLead(record, actor);
}
export function approvalStage(
  record: RequestRecord,
  actor: Member,
): 'product' | 'engineering' | undefined {
  if (actor.id === record.authorId || actor.status !== 'active') return;
  const rev = currentRevision(record);
  if (actor.role === 'product_lead' && actor.id === rev.productReviewerId) return 'product';
  if (actor.role === 'engineering_lead' && actor.id === rev.engineeringReviewerId)
    return 'engineering';
}
export function validateDraft(draft: DraftInput): void {
  fieldsSchema.parse(draft.fields);
  if (new TextEncoder().encode(JSON.stringify(draft.fields)).length > 24000)
    throw new DomainError('INPUT_TOO_LARGE', 'Keep the request text below 24 KB.');
  if (new Set(draft.fileIds).size !== draft.fileIds.length)
    throw new DomainError('DUPLICATE_FILE', 'Attach each file once.');
  if (
    !draft.fields.unscheduled &&
    (!draft.fields.targetDate || !Number.isFinite(Date.parse(draft.fields.targetDate)))
  )
    throw new DomainError('DELIVERY_DATE', 'Add a target date or choose not scheduled.');
}
export function validateReviewers(rev: Revision, actorId: string, members: Member[]): void {
  const product = members.find(
    (m) => m.id === rev.productReviewerId && m.status === 'active' && m.role === 'product_lead',
  );
  const engineering = members.find(
    (m) =>
      m.id === rev.engineeringReviewerId && m.status === 'active' && m.role === 'engineering_lead',
  );
  if (
    !product ||
    !engineering ||
    product.id === engineering.id ||
    product.id === actorId ||
    engineering.id === actorId
  )
    throw new DomainError(
      'REVIEWER_ASSIGNMENT',
      'Assign two active leads, each different from the author.',
    );
}
export function checklistFindings(rev: Revision): Finding[] {
  return rev.requiredFields.flatMap((field) => {
    const value = rev.fields[field];
    const missing = Array.isArray(value)
      ? !value.some((v) => v.trim()) || value.some((v) => !v.trim())
      : !value.trim();
    return missing
      ? [
          {
            id: crypto.randomUUID(),
            kind: 'missing_detail' as const,
            field,
            severity: 'blocking' as const,
            origin: 'deterministic' as const,
            evidence: '',
            question: `Add ${fieldLabels[field].toLowerCase()}.`,
            explanation: 'Required by this request’s checklist.',
          },
        ]
      : [];
  });
}
export function validateProviderOutput(value: unknown, fields: FeatureFields): ProviderResponse {
  const result = providerResponseSchema.parse(value);
  if (new TextEncoder().encode(JSON.stringify(result)).length > 16384)
    throw new DomainError('INVALID_REVIEW', 'The review response is too large.', 502);
  for (const finding of [...result.findings, ...result.potential_misunderstandings]) {
    const source = fields[finding.field];
    const content = Array.isArray(source) ? source.join('\n') : source;
    if (!finding.evidence_quote && finding.kind !== 'missing_detail')
      throw new DomainError('INVALID_REVIEW', 'A finding did not include supporting text.', 502);
    if (finding.evidence_quote && !content.includes(finding.evidence_quote))
      throw new DomainError('INVALID_REVIEW', 'A finding quoted text outside the request.', 502);
  }
  return result;
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
export function snapshotInput(rev: Revision) {
  return {
    fields: rev.fields,
    productReviewerId: rev.productReviewerId,
    engineeringReviewerId: rev.engineeringReviewerId,
    checklistVersion: rev.checklistVersion,
    files: rev.files,
  };
}

export async function applyDemoCommand(
  input: RequestRecord,
  command: Command,
  context: AppContext,
  now = new Date().toISOString(),
  files: FileMeta[] = input.revisions.flatMap((r) => r.files),
): Promise<RequestRecord> {
  const record = structuredClone(input);
  const actor = context.currentUser;
  if (actor.status !== 'active')
    throw new DomainError('ACCESS_REVOKED', 'Your workspace access has been removed.', 403);
  if (record.archived && command.action !== 'archive')
    throw new DomainError('ARCHIVED', 'Restore this request before making changes.');
  if (command.expectedRevision !== record.currentRevision)
    throw new DomainError(
      'REVISION_CHANGED',
      'This request changed. Reload it before continuing.',
      409,
    );
  const rev = currentRevision(record);
  switch (command.action) {
    case 'save': {
      if (actor.id !== record.authorId)
        throw new DomainError('FORBIDDEN', 'Only the author can edit requirements.', 403);
      validateDraft(command.draft);
      if (
        command.draft.checklistVersion !== context.checklist.id &&
        command.draft.checklistVersion !== rev.checklistVersion
      )
        throw new DomainError('CHECKLIST_VERSION', 'Choose a published checklist.');
      const attached = command.draft.fileIds.map((id) => {
        const file = files.find((f) => f.id === id);
        if (!file) throw new DomainError('FILE_NOT_READY', 'Finish uploading files before saving.');
        return file;
      });
      const next: Revision = {
        ...rev,
        id: crypto.randomUUID(),
        number: rev.number + 1,
        fields: command.draft.fields,
        files: attached,
        productReviewerId: command.draft.productReviewerId,
        engineeringReviewerId: command.draft.engineeringReviewerId,
        checklistVersion: command.draft.checklistVersion,
        requiredFields:
          command.draft.checklistVersion === context.checklist.id
            ? context.checklist.requiredFields
            : rev.requiredFields,
        createdAt: now,
        editorId: actor.id,
      };
      next.inputHash = await sha256(canonicalJson(snapshotInput(next)));
      record.revisions.push(next);
      record.currentRevision = next.number;
      record.currentReviewId = null;
      record.status = 'draft';
      break;
    }
    case 'review': {
      if (!canReview(record, actor))
        throw new DomainError('FORBIDDEN', 'Only the author or assigned leads can review.', 403);
      if (record.briefs.some((b) => b.revision === rev.number))
        throw new DomainError(
          'BRIEF_EXISTS',
          'Save a new revision before reviewing this feature again.',
        );
      if (rev.number < record.minimumApprovalRevision)
        throw new DomainError(
          'CHANGES_REQUIRED',
          'Save a new revision to address the requested changes.',
        );
      validateReviewers(rev, record.authorId, context.members);
      const findings = checklistFindings(rev);
      const review: Review = {
        id: crypto.randomUUID(),
        revision: rev.number,
        inputHash: rev.inputHash,
        state: 'succeeded',
        mode: 'checklist_only',
        findings,
        unknowns: [],
        createdAt: now,
        expiresAt: now,
        promptVersion: 'checklist-v1',
      };
      record.reviews.push(review);
      record.currentReviewId = review.id;
      record.status = findings.length ? 'needs_clarification' : 'ready_for_approval';
      break;
    }
    case 'approve': {
      const stage = approvalStage(record, actor);
      const review = currentReview(record);
      validateReviewers(rev, record.authorId, context.members);
      if (stage !== command.stage)
        throw new DomainError('FORBIDDEN', 'Only the assigned lead can approve this stage.', 403);
      if (
        !review ||
        review.id !== command.reviewId ||
        review.state !== 'succeeded' ||
        review.inputHash !== rev.inputHash ||
        blockingFindings(review).length ||
        rev.number < record.minimumApprovalRevision
      )
        throw new DomainError(
          'NOT_READY',
          'Resolve the current revision’s blocking questions before approval.',
        );
      if (
        !['ready_for_approval', 'partially_approved', 'approved', 'brief_ready'].includes(
          record.status,
        )
      )
        throw new DomainError('NOT_READY', 'Review this revision before approval.');
      if (!activeApprovals(record).some((a) => a.stage === stage))
        record.approvals.push({
          id: crypto.randomUUID(),
          reviewId: review.id,
          revision: rev.number,
          inputHash: rev.inputHash,
          stage,
          memberId: actor.id,
          createdAt: now,
        });
      record.status =
        activeApprovals(record).length === 2
          ? record.briefs.some((b) => b.revision === rev.number)
            ? 'brief_ready'
            : 'approved'
          : 'partially_approved';
      break;
    }
    case 'changes': {
      if (!assignedLead(record, actor))
        throw new DomainError('FORBIDDEN', 'Only an assigned lead can request changes.', 403);
      if (record.briefs.some((b) => b.revision === rev.number))
        throw new DomainError(
          'BRIEF_EXISTS',
          'The author must create a new revision after an approved brief.',
        );
      record.comments.push({
        id: crypto.randomUUID(),
        authorId: actor.id,
        revision: rev.number,
        body: `Changes requested: ${command.reason}`,
        createdAt: now,
      });
      record.minimumApprovalRevision = rev.number + 1;
      record.status = 'needs_clarification';
      record.currentReviewId = null;
      break;
    }
    case 'comment':
      record.comments.push({
        id: crypto.randomUUID(),
        authorId: actor.id,
        revision: rev.number,
        body: command.body,
        createdAt: now,
      });
      break;
    case 'dismiss': {
      if (!assignedLead(record, actor))
        throw new DomainError('FORBIDDEN', 'Only assigned leads can dismiss an AI finding.', 403);
      const review = currentReview(record);
      const finding = review?.findings.find((f) => f.id === command.findingId);
      if (
        !review ||
        review.id !== command.reviewId ||
        !finding ||
        finding.origin !== 'ai' ||
        review.state !== 'succeeded'
      )
        throw new DomainError('INVALID_FINDING', 'This finding cannot be dismissed.');
      finding.resolution = { actorId: actor.id, reason: command.reason, createdAt: now };
      if (!blockingFindings(review).length)
        record.status =
          activeApprovals(record).length === 2
            ? 'approved'
            : activeApprovals(record).length
              ? 'partially_approved'
              : 'ready_for_approval';
      break;
    }
    case 'generate': {
      if (!canReview(record, actor))
        throw new DomainError(
          'FORBIDDEN',
          'Only the author or assigned leads can generate a brief.',
          403,
        );
      const existing = record.briefs.find((b) => b.revision === rev.number);
      if (existing) break;
      validateReviewers(rev, record.authorId, context.members);
      if (record.status !== 'approved' || activeApprovals(record).length !== 2)
        throw new DomainError(
          'NOT_APPROVED',
          'Both leads must approve this revision before generating a brief.',
        );
      const markdown = makeBrief(record, context.members);
      record.briefs.push({
        id: crypto.randomUUID(),
        revision: rev.number,
        reviewId: record.currentReviewId!,
        markdown,
        contentHash: await sha256(markdown),
        createdAt: now,
      });
      record.status = 'brief_ready';
      break;
    }
    case 'archive': {
      if (actor.id !== record.authorId && actor.role !== 'admin')
        throw new DomainError(
          'FORBIDDEN',
          'Only the author or administrator can archive requests.',
          403,
        );
      record.archived = command.archived;
      break;
    }
  }
  const current = currentRevision(record);
  record.title = current.fields.title || 'Untitled feature';
  record.productReviewerId = current.productReviewerId;
  record.engineeringReviewerId = current.engineeringReviewerId;
  record.blockingCount = blockingFindings(currentReview(record)).length;
  record.updatedAt = now;
  record.events.push({
    id: crypto.randomUUID(),
    actorId: actor.id,
    action: command.action,
    revision: record.currentRevision,
    createdAt: now,
  });
  return record;
}

export async function createDemoRecord(
  draft: DraftInput,
  context: AppContext,
  number: number,
  now = new Date().toISOString(),
): Promise<RequestRecord> {
  validateDraft(draft);
  if (context.currentUser.status !== 'active')
    throw new DomainError('FORBIDDEN', 'Active membership is required.', 403);
  if (draft.fileIds.length)
    throw new DomainError('FILE_NOT_READY', 'Save the draft before attaching files.');
  if (draft.checklistVersion !== context.checklist.id)
    throw new DomainError('CHECKLIST_VERSION', 'Choose the current published checklist.');
  const revision: Revision = {
    id: crypto.randomUUID(),
    number: 1,
    fields: draft.fields,
    productReviewerId: draft.productReviewerId,
    engineeringReviewerId: draft.engineeringReviewerId,
    checklistVersion: draft.checklistVersion,
    requiredFields: context.checklist.requiredFields,
    files: [],
    inputHash: '',
    createdAt: now,
    editorId: context.currentUser.id,
  };
  revision.inputHash = await sha256(canonicalJson(snapshotInput(revision)));
  return {
    id: crypto.randomUUID(),
    number,
    title: draft.fields.title || 'Untitled feature',
    authorId: context.currentUser.id,
    productReviewerId: draft.productReviewerId,
    engineeringReviewerId: draft.engineeringReviewerId,
    workspaceId: context.workspace.id,
    status: 'draft',
    currentRevision: 1,
    currentReviewId: null,
    minimumApprovalRevision: 1,
    archived: false,
    blockingCount: 0,
    updatedAt: now,
    revisions: [revision],
    reviews: [],
    approvals: [],
    briefs: [],
    comments: [],
    events: [
      {
        id: crypto.randomUUID(),
        actorId: context.currentUser.id,
        action: 'create',
        revision: 1,
        createdAt: now,
      },
    ],
  };
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}\[\]<>#!|])/g, '\\$1');
}
export function makeBrief(record: RequestRecord, members: Member[]): string {
  const rev = currentRevision(record),
    f = rev.fields;
  const sections: [string, string][] = [
    ['Problem and evidence', f.problem],
    ['Target users', f.audience],
    ['Success measure', f.successMeasure],
    ['In scope', f.scope],
    ['Out of scope', f.exclusions],
    ['Expected behavior', f.behavior],
    ['Edge cases', f.edgeCases],
    ['Data and permissions', f.dataImpact],
    ['Dependencies and constraints', f.dependencies],
    ['Priority', `${f.priority}: ${f.rationale}`],
    ['Target delivery', f.unscheduled ? 'Not scheduled' : `${f.targetDate} (${f.timezone})`],
  ];
  const decisions = activeApprovals(record)
    .map(
      (a) =>
        `- ${a.stage === 'product' ? 'Product' : 'Engineering'}: ${escapeMarkdown(members.find((m) => m.id === a.memberId)?.name ?? a.memberId)} · ${a.createdAt}`,
    )
    .join('\n');
  const references =
    [
      ...f.references.map(
        (r) =>
          `- [${escapeMarkdown(r.label || r.url)}](<${r.url.replace(/[<>\\\s]/g, (character) => encodeURIComponent(character))}>)`,
      ),
      ...rev.files.map(
        (file) =>
          `- ${escapeMarkdown(file.name)} — attachment ID ${file.id} (open the source request to download)`,
      ),
    ].join('\n') || 'No supporting references.';
  return (
    `# ${escapeMarkdown(f.title)}\n\nHC-${String(record.number).padStart(4, '0')} · Revision ${rev.number}\n\n` +
    sections.map(([title, body]) => `## ${title}\n\n${escapeMarkdown(body)}\n`).join('\n') +
    `\n## Acceptance criteria\n\n${f.criteria.map((c, i) => `${i + 1}. ${escapeMarkdown(c)}`).join('\n')}\n\n## References\n\n${references}\n\n## Review decisions\n\n${decisions}\n\nReview mode: ${currentReview(record)?.mode === 'ai' ? 'AI language review and checklist' : 'Checklist only; language ambiguity was not reviewed by AI'}.\n\n## Implementation checklist\n\n${f.criteria.map((c) => `- [ ] ${escapeMarkdown(c)}`).join('\n')}\n\nInput SHA-256: \`${rev.inputHash}\`\nChecklist: ${escapeMarkdown(rev.checklistVersion)}\n`
  );
}

export function detectFileType(
  bytes: Uint8Array,
): 'image/png' | 'image/jpeg' | 'application/pdf' | undefined {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-') return 'application/pdf';
}
export function validateFile(
  bytes: Uint8Array,
  declaredType: string,
  size: number,
): 'image/png' | 'image/jpeg' | 'application/pdf' {
  if (size <= 0 || size > 5_000_000)
    throw new DomainError('FILE_SIZE', 'Choose a file between 1 byte and 5 MB.');
  const actual = detectFileType(bytes);
  if (!actual || actual !== declaredType)
    throw new DomainError('FILE_TYPE', 'The file contents do not match PNG, JPEG, or PDF.');
  return actual;
}
