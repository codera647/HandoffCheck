import { z } from 'zod';
import { fieldNameSchema, type FeatureFields, type FieldName } from './contracts.ts';
import { DomainError } from './domain.ts';

export const policyInputSchema = z
  .object({
    aiEnabled: z.boolean(),
    suggestions: z.boolean(),
    summaries: z.boolean(),
    qa: z.boolean(),
    background: z.boolean(),
    autoBrief: z.boolean(),
    reminders: z.boolean(),
    reminderHours: z.number().int().min(1).max(168),
    dailyLimit: z.number().int().min(1).max(50),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export type PolicyInput = z.infer<typeof policyInputSchema>;
export const policySchema = policyInputSchema.omit({ expectedVersion: true }).extend({
  version: z.number().int(),
  providerConfigured: z.boolean(),
  schedulerConfigured: z.boolean(),
  demo: z.boolean(),
});
export type AutomationPolicy = z.infer<typeof policySchema>;
export const defaultPolicy: AutomationPolicy = {
  version: 1,
  aiEnabled: false,
  suggestions: false,
  summaries: false,
  qa: false,
  background: false,
  autoBrief: false,
  reminders: false,
  reminderHours: 24,
  dailyLimit: 50,
  providerConfigured: false,
  schedulerConfigured: false,
  demo: false,
};
export const taskKindSchema = z.enum(['edits', 'summary', 'qa']);
export type TaskKind = z.infer<typeof taskKindSchema>;
const evidence = { evidenceField: fieldNameSchema, evidenceQuote: z.string().min(1).max(1500) };
export const editsOutputSchema = z
  .object({
    edits: z
      .array(
        z
          .object({
            field: fieldNameSchema,
            ...evidence,
            text: z.string().min(1).max(3000),
            reason: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .max(6),
  })
  .strict();
export const summaryOutputSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            ...evidence,
            text: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict();
export const qaOutputSchema = z
  .object({
    tests: z
      .array(
        z
          .object({
            criterionIndex: z.number().int().min(0).max(19),
            criterionQuote: z.string().min(1).max(1000),
            kind: z.enum(['positive', 'negative', 'boundary', 'permission']),
            scenario: z.string().min(1).max(500),
            steps: z.array(z.string().min(1).max(500)).min(1).max(6),
            expected: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export const assistanceOutputSchema = z.union([
  editsOutputSchema,
  summaryOutputSchema,
  qaOutputSchema,
]);
export type AssistanceOutput = z.infer<typeof assistanceOutputSchema>;
export const taskSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  actorId: z.string(),
  kind: z.enum(['review', 'edits', 'summary', 'qa']),
  revision: z.number().int(),
  inputHash: z.string(),
  briefId: z.string().nullable(),
  state: z.enum(['queued', 'working', 'ready', 'failed', 'outdated', 'cancelled']),
  output: assistanceOutputSchema.nullable(),
  error: z.string().nullable(),
  attempts: z.number().int(),
  createdAt: z.string(),
  accepted: z.array(z.number().int()),
  reviewedBy: z.string().nullable(),
  demo: z.boolean(),
  model: z.string().nullable(),
});
export type AutomationTask = z.infer<typeof taskSchema>;
export const notificationSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  read: z.boolean(),
});
export type InAppNotification = z.infer<typeof notificationSchema>;
export const fieldText = (fields: FeatureFields, field: FieldName): string =>
  field === 'criteria' ? fields.criteria.join('\n') : fields[field];
export function parseAssistance(
  kind: TaskKind,
  value: unknown,
  fields: FeatureFields,
): AssistanceOutput {
  const result =
    kind === 'edits'
      ? editsOutputSchema.parse(value)
      : kind === 'summary'
        ? summaryOutputSchema.parse(value)
        : qaOutputSchema.parse(value);
  if (JSON.stringify(result).length > 20000)
    throw new DomainError('INVALID_AI_OUTPUT', 'The assistance response is too large.');
  if ('tests' in result) {
    for (const test of result.tests)
      if (!fields.criteria[test.criterionIndex]?.includes(test.criterionQuote))
        throw new DomainError(
          'INVALID_AI_OUTPUT',
          'A QA draft cites an acceptance criterion outside this brief.',
        );
  } else {
    for (const item of 'edits' in result ? result.edits : result.items) {
      if (!fieldText(fields, item.evidenceField).includes(item.evidenceQuote))
        throw new DomainError(
          'INVALID_AI_OUTPUT',
          'An AI suggestion cites text outside this revision.',
        );
      if (
        'field' in item &&
        ((item.field === 'title' && item.text.length > 120) ||
          (item.field === 'criteria' &&
            (item.text.split('\n').length > 20 ||
              item.text.split('\n').some((t) => t.length > 1000))))
      )
        throw new DomainError('INVALID_AI_OUTPUT', 'A suggested edit exceeds this field’s limits.');
    }
  }
  return result;
}

/** Deterministic fixtures for the labelled local demo; never a provider fallback. */
export function demoAssistance(kind: TaskKind, fields: FeatureFields): AssistanceOutput {
  const quote = fields.behavior.trim().slice(0, 1000) || fields.problem.trim().slice(0, 1000);
  const evidenceField = fields.behavior.trim() ? 'behavior' : 'problem';
  if (!quote) throw new DomainError('DEMO_INPUT', 'Record expected behavior or the problem first.');
  if (kind === 'edits')
    return parseAssistance(
      kind,
      {
        edits: [
          {
            field: 'behavior',
            evidenceField,
            evidenceQuote: quote,
            text: fields.behavior.trim() || fields.problem.trim(),
            reason: 'Demo fixture: records the supplied behavior without adding requirements.',
          },
        ],
      },
      fields,
    );
  if (kind === 'summary')
    return parseAssistance(
      kind,
      {
        items: [
          {
            evidenceField,
            evidenceQuote: quote,
            text: quote,
          },
        ],
      },
      fields,
    );
  if (!fields.criteria.length)
    throw new DomainError('DEMO_INPUT', 'This brief needs an acceptance criterion.');
  return parseAssistance(
    kind,
    {
      tests: fields.criteria.map((criterion, criterionIndex) => ({
        criterionIndex,
        criterionQuote: criterion,
        kind: 'positive',
        scenario: 'Verify acceptance criterion ' + (criterionIndex + 1),
        steps: ['Prepare the conditions in the criterion.', 'Perform its stated action.'],
        expected: criterion,
      })),
    },
    fields,
  );
}
