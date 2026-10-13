import { describe, expect, it } from 'vitest';
import {
  activeApprovals,
  applyDemoCommand,
  createDemoRecord,
  currentReview,
  validateFile,
  validateProviderOutput,
} from '../shared/domain';
import { asActor, context, draft, ids } from './fixtures';

describe('feature handoff rules', () => {
  it('requires missing details, and never dismisses checklist findings', async () => {
    const input = draft();
    input.fields.edgeCases = '';
    let record = await createDemoRecord(input, context, 1);
    record = await applyDemoCommand(record, { action: 'review', expectedRevision: 1 }, context);
    expect(record.status).toBe('needs_clarification');
    const review = currentReview(record)!;
    await expect(
      applyDemoCommand(
        record,
        {
          action: 'dismiss',
          expectedRevision: 1,
          reviewId: review.id,
          findingId: review.findings[0].id,
          reason: 'Ignore it',
        },
        asActor(ids.product),
      ),
    ).rejects.toThrow();
    await expect(
      applyDemoCommand(
        record,
        { action: 'approve', expectedRevision: 1, reviewId: review.id, stage: 'product' },
        asActor(ids.product),
      ),
    ).rejects.toThrow();
  });
  it('enforces distinct approval stages and preserves old briefs after edits', async () => {
    let record = await createDemoRecord(draft(), context, 1);
    record = await applyDemoCommand(record, { action: 'review', expectedRevision: 1 }, context);
    const reviewId = record.currentReviewId!;
    await expect(
      applyDemoCommand(
        record,
        { action: 'approve', expectedRevision: 1, reviewId, stage: 'product' },
        context,
      ),
    ).rejects.toThrow();
    record = await applyDemoCommand(
      record,
      { action: 'approve', expectedRevision: 1, reviewId, stage: 'product' },
      asActor(ids.product),
    );
    await expect(
      applyDemoCommand(record, { action: 'generate', expectedRevision: 1 }, context),
    ).rejects.toThrow();
    await expect(
      applyDemoCommand(
        record,
        { action: 'approve', expectedRevision: 1, reviewId, stage: 'engineering' },
        asActor(ids.product),
      ),
    ).rejects.toThrow();
    record = await applyDemoCommand(
      record,
      { action: 'approve', expectedRevision: 1, reviewId, stage: 'engineering' },
      asActor(ids.engineering),
    );
    record = await applyDemoCommand(record, { action: 'generate', expectedRevision: 1 }, context);
    const hash = record.briefs[0].contentHash;
    record = await applyDemoCommand(record, { action: 'generate', expectedRevision: 1 }, context);
    expect(record.briefs).toHaveLength(1);
    const changed = draft();
    changed.fields.scope = 'Updated scope';
    record = await applyDemoCommand(
      record,
      { action: 'save', expectedRevision: 1, draft: changed },
      context,
    );
    expect(activeApprovals(record)).toHaveLength(0);
    expect(record.briefs[0].contentHash).toBe(hash);
    expect(record.status).toBe('draft');
    await expect(
      applyDemoCommand(
        record,
        { action: 'approve', expectedRevision: 1, reviewId, stage: 'product' },
        asActor(ids.product),
      ),
    ).rejects.toThrow('changed');
  });
  it('requires a new revision after a lead requests changes', async () => {
    let record = await createDemoRecord(draft(), context, 1);
    record = await applyDemoCommand(
      record,
      { action: 'changes', expectedRevision: 1, reason: 'Clarify access' },
      asActor(ids.product),
    );
    await expect(
      applyDemoCommand(record, { action: 'review', expectedRevision: 1 }, context),
    ).rejects.toThrow('new revision');
  });
  it('rejects invented evidence and mismatched file signatures', () => {
    const finding = {
      kind: 'ambiguity',
      field: 'scope',
      severity: 'blocking',
      evidence_quote: 'Invented quotation',
      question: 'Which behavior?',
      explanation: 'Unclear',
    };
    expect(() =>
      validateProviderOutput(
        { schema_version: '1', findings: [finding], potential_misunderstandings: [], unknowns: [] },
        draft().fields,
      ),
    ).toThrow('outside');
    expect(() => validateFile(new TextEncoder().encode('%PDF-1.7'), 'image/png', 8)).toThrow(
      'contents',
    );
    expect(() =>
      validateFile(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png', 5000001),
    ).toThrow('5 MB');
  });
});
