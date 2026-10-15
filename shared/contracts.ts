import { z } from 'zod';

export const roleSchema = z.enum(['member', 'product_lead', 'engineering_lead', 'admin']);
export const statusSchema = z.enum([
  'draft',
  'reviewing',
  'needs_clarification',
  'review_error',
  'ready_for_approval',
  'partially_approved',
  'approved',
  'brief_ready',
]);
export const memberSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: roleSchema,
  status: z.enum(['active', 'revoked']),
});
export type Member = z.infer<typeof memberSchema>;
export type Role = Member['role'];
export type Status = z.infer<typeof statusSchema>;

export const fieldNames = [
  'title',
  'problem',
  'audience',
  'behavior',
  'scope',
  'exclusions',
  'criteria',
  'edgeCases',
  'dependencies',
  'dataImpact',
  'successMeasure',
  'rationale',
] as const;
export const fieldNameSchema = z.enum(fieldNames);
export type FieldName = z.infer<typeof fieldNameSchema>;
export const fieldLabels: Record<FieldName, string> = {
  title: 'Feature title',
  problem: 'Problem and evidence',
  audience: 'Target users',
  behavior: 'Expected behavior',
  scope: 'In scope',
  exclusions: 'Out of scope',
  criteria: 'Acceptance criteria',
  edgeCases: 'Edge cases',
  dependencies: 'Dependencies and constraints',
  dataImpact: 'Data and permissions',
  successMeasure: 'Success measure',
  rationale: 'Priority rationale',
};
export const baselineFields: FieldName[] = [...fieldNames];
const text = z.string().max(3000);
export const fieldsSchema = z
  .object({
    title: z.string().max(120),
    problem: text,
    audience: text,
    behavior: text,
    scope: text,
    exclusions: text,
    criteria: z.array(z.string().max(1000)).max(20),
    edgeCases: text,
    dependencies: text,
    dataImpact: text,
    successMeasure: text,
    priority: z.enum(['low', 'normal', 'high']),
    rationale: text,
    targetDate: z.string().refine((v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Use a valid date.'),
    timezone: z
      .string()
      .max(80)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, 'Choose a valid timezone.'),
    unscheduled: z.boolean(),
    references: z
      .array(
        z.object({
          label: z.string().max(120),
          url: z.url().refine((v) => v.startsWith('https://'), 'Use an HTTPS link.'),
        }),
      )
      .max(10),
  })
  .strict();
export type FeatureFields = z.infer<typeof fieldsSchema>;
export function emptyFields(): FeatureFields {
  return {
    title: '',
    problem: '',
    audience: '',
    behavior: '',
    scope: '',
    exclusions: '',
    criteria: [''],
    edgeCases: '',
    dependencies: '',
    dataImpact: '',
    successMeasure: '',
    priority: 'normal',
    rationale: '',
    targetDate: '',
    timezone: 'Asia/Karachi',
    unscheduled: true,
    references: [],
  };
}

export const fileMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['image/png', 'image/jpeg', 'application/pdf']),
  size: z.number().int().nonnegative(),
});
export type FileMeta = z.infer<typeof fileMetaSchema>;
export const revisionSchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  fields: fieldsSchema,
  productReviewerId: z.string(),
  engineeringReviewerId: z.string(),
  checklistVersion: z.string(),
  requiredFields: z.array(fieldNameSchema),
  inputHash: z.string(),
  files: z.array(fileMetaSchema).max(5),
  createdAt: z.string(),
  editorId: z.string(),
});
export type Revision = z.infer<typeof revisionSchema>;
export const findingSchema = z.object({
  id: z.string(),
  kind: z.enum(['missing_detail', 'ambiguity', 'conflict', 'risk']),
  field: fieldNameSchema,
  severity: z.enum(['blocking', 'advisory']),
  origin: z.enum(['deterministic', 'ai']),
  evidence: z.string(),
  question: z.string(),
  explanation: z.string(),
  resolution: z
    .object({ actorId: z.string(), reason: z.string(), createdAt: z.string() })
    .optional(),
});
export type Finding = z.infer<typeof findingSchema>;
export const reviewSchema = z.object({
  id: z.string(),
  revision: z.number(),
  inputHash: z.string(),
  state: z.enum(['running', 'succeeded', 'error', 'superseded']),
  mode: z.enum(['checklist_only', 'ai']),
  findings: z.array(findingSchema),
  unknowns: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string(),
  error: z.string().optional(),
  modelId: z.string().optional(),
  promptVersion: z.string(),
});
export type Review = z.infer<typeof reviewSchema>;
export const approvalSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  revision: z.number(),
  inputHash: z.string(),
  stage: z.enum(['product', 'engineering']),
  memberId: z.string(),
  createdAt: z.string(),
});
export type Approval = z.infer<typeof approvalSchema>;
export const briefSchema = z.object({
  id: z.string(),
  revision: z.number(),
  reviewId: z.string(),
  markdown: z.string(),
  contentHash: z.string(),
  createdAt: z.string(),
});
export type Brief = z.infer<typeof briefSchema>;
export const requestSummarySchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  authorId: z.string(),
  productReviewerId: z.string(),
  engineeringReviewerId: z.string(),
  status: statusSchema,
  currentRevision: z.number(),
  updatedAt: z.string(),
  archived: z.boolean(),
  blockingCount: z.number(),
});
export type RequestSummary = z.infer<typeof requestSummarySchema>;
export const requestSchema = requestSummarySchema.extend({
  workspaceId: z.string(),
  currentReviewId: z.string().nullable(),
  minimumApprovalRevision: z.number(),
  revisions: z.array(revisionSchema),
  reviews: z.array(reviewSchema),
  approvals: z.array(approvalSchema),
  briefs: z.array(briefSchema),
  comments: z.array(
    z.object({
      id: z.string(),
      authorId: z.string(),
      body: z.string(),
      revision: z.number(),
      createdAt: z.string(),
    }),
  ),
  events: z.array(
    z.object({
      id: z.string(),
      actorId: z.string(),
      action: z.string(),
      revision: z.number(),
      createdAt: z.string(),
    }),
  ),
});
export type RequestRecord = z.infer<typeof requestSchema>;
export const checklistSchema = z.object({
  id: z.string(),
  name: z.string(),
  requiredFields: z.array(fieldNameSchema),
  createdAt: z.string(),
});
export type Checklist = z.infer<typeof checklistSchema>;
export const invitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: roleSchema,
  expiresAt: z.string(),
  consumed: z.boolean(),
});
export const contextSchema = z.object({
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    timezone: z.string(),
    reviewMode: z.enum(['checklist_only', 'ai']),
    storageBytes: z.number(),
    retentionDays: z.number(),
  }),
  currentUser: memberSchema,
  members: z.array(memberSchema),
  checklist: checklistSchema,
  invitations: z.array(invitationSchema).optional(),
});
export type AppContext = z.infer<typeof contextSchema>;
export const listSchema = z.object({
  items: z.array(requestSummarySchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type RequestPage = z.infer<typeof listSchema>;
export interface ListFilters {
  search?: string;
  status?: string;
  author?: string;
  assigned?: string;
  archived?: boolean;
  page?: number;
}

export const draftSchema = z
  .object({
    fields: fieldsSchema,
    productReviewerId: z.string(),
    engineeringReviewerId: z.string(),
    checklistVersion: z.string(),
    fileIds: z.array(z.string()).max(5),
  })
  .strict();
export type DraftInput = z.infer<typeof draftSchema>;
export const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), expectedRevision: z.number().int(), draft: draftSchema }),
  z.object({ action: z.literal('review'), expectedRevision: z.number().int() }),
  z.object({
    action: z.literal('approve'),
    expectedRevision: z.number().int(),
    reviewId: z.string(),
    stage: z.enum(['product', 'engineering']),
  }),
  z.object({
    action: z.literal('changes'),
    expectedRevision: z.number().int(),
    reason: z.string().trim().min(1).max(3000),
  }),
  z.object({
    action: z.literal('comment'),
    expectedRevision: z.number().int(),
    body: z.string().trim().min(1).max(3000),
  }),
  z.object({
    action: z.literal('dismiss'),
    expectedRevision: z.number().int(),
    reviewId: z.string(),
    findingId: z.string(),
    reason: z.string().trim().min(1).max(1000),
  }),
  z.object({ action: z.literal('generate'), expectedRevision: z.number().int() }),
  z.object({
    action: z.literal('archive'),
    expectedRevision: z.number().int(),
    archived: z.boolean(),
  }),
]);
export type Command = z.infer<typeof commandSchema>;
export const providerFindingSchema = z
  .object({
    kind: z.enum(['missing_detail', 'ambiguity', 'conflict', 'risk']),
    field: fieldNameSchema,
    severity: z.enum(['blocking', 'advisory']),
    evidence_quote: z.string().max(1500),
    question: z.string().min(1).max(1000),
    explanation: z.string().max(1500),
  })
  .strict();
export const providerResponseSchema = z
  .object({
    // A single-value enum preserves validation and uses Gemini's supported schema keywords.
    schema_version: z.enum(['1']),
    findings: z.array(providerFindingSchema).max(10),
    potential_misunderstandings: z.array(providerFindingSchema).max(3),
    unknowns: z.array(z.string().max(250)).max(10),
  })
  .strict();
export type ProviderResponse = z.infer<typeof providerResponseSchema>;
