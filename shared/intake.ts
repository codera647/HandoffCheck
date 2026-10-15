import { z } from 'zod';
import {
  baselineFields,
  emptyFields,
  fieldLabels,
  fieldNameSchema,
  type FeatureFields,
} from './contracts.ts';
import { DomainError } from './domain.ts';

export const intakeInputSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            text: z.string().trim().min(1).max(3000),
          })
          .strict(),
      )
      .min(1)
      .max(40),
  })
  .strict()
  .refine((input) => input.messages.at(-1)?.role === 'user', 'Send an author message.')
  .refine(
    (input) => new TextEncoder().encode(JSON.stringify(input)).length <= 46000,
    'Keep the conversation below 46 KB.',
  );
export type IntakeInput = z.infer<typeof intakeInputSchema>;
export const intakeResponseSchema = z
  .object({
    summary: z.string().min(1).max(1000),
    proposals: z
      .array(
        z
          .object({
            field: fieldNameSchema,
            text: z.string().min(1).max(3000),
            evidence: z
              .array(
                z
                  .object({
                    messageIndex: z.number().int().min(0).max(39),
                    quote: z.string().min(1).max(1000),
                  })
                  .strict(),
              )
              .min(1)
              .max(3),
          })
          .strict(),
      )
      .max(12),
    question: z
      .object({
        field: fieldNameSchema,
        text: z.string().min(1).max(600),
        options: z
          .array(
            z
              .object({
                label: z.string().min(1).max(120),
                value: z.string().min(1).max(1000),
                recommended: z.boolean(),
                reason: z.string().max(400),
              })
              .strict(),
          )
          .max(4),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type IntakeResponse = z.infer<typeof intakeResponseSchema>;
export const intakeResultSchema = z.object({
  response: intakeResponseSchema,
  model: z.string().nullable(),
  demo: z.boolean(),
});
export type IntakeResult = z.infer<typeof intakeResultSchema>;

export function validateIntake(value: unknown, input: IntakeInput): IntakeResponse {
  const result = intakeResponseSchema.parse(value);
  if (new Set(result.proposals.map((p) => p.field)).size !== result.proposals.length)
    throw new DomainError('INVALID_AI_OUTPUT', 'The draft repeats a field. Try again.');
  if ((result.question?.options.filter((o) => o.recommended).length ?? 0) > 1)
    throw new DomainError(
      'INVALID_AI_OUTPUT',
      'The draft contains conflicting recommendations. Try again.',
    );
  for (const proposal of result.proposals) {
    if (
      (proposal.field === 'title' && proposal.text.length > 120) ||
      (proposal.field === 'criteria' &&
        (proposal.text.split('\n').length > 20 ||
          proposal.text.split('\n').some((line) => line.length > 1000)))
    )
      throw new DomainError('INVALID_AI_OUTPUT', 'A proposed field exceeds the form limits.');
    for (const evidence of proposal.evidence) {
      const message = input.messages[evidence.messageIndex];
      if (message?.role !== 'user' || !message.text.includes(evidence.quote))
        throw new DomainError(
          'INVALID_AI_OUTPUT',
          'The draft cites information outside the author’s messages. Try again.',
        );
    }
  }
  if (new TextEncoder().encode(JSON.stringify(intakeFields(result))).length > 24000)
    throw new DomainError('INVALID_AI_OUTPUT', 'The proposed draft exceeds the form’s text limit.');
  const next = missingIntakeFields(intakeFields(result))[0];
  if (!result.question && next)
    result.question = {
      field: next,
      text: `Describe ${fieldLabels[next].toLowerCase()}.`,
      options: [],
    };
  return result;
}
export function intakeFields(response: IntakeResponse, timezone = 'Asia/Karachi'): FeatureFields {
  const fields = { ...emptyFields(), timezone };
  for (const proposal of response.proposals) {
    if (proposal.field === 'criteria')
      fields.criteria = proposal.text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    else fields[proposal.field] = proposal.text;
  }
  return fields;
}
export function missingIntakeFields(fields: FeatureFields) {
  return baselineFields.filter((field) => {
    const value = fields[field];
    return Array.isArray(value) ? !value.length || value.some((v) => !v.trim()) : !value.trim();
  });
}

// Explicitly simulated extraction: the demo only copies the author's own answers.
export function demoIntake(input: IntakeInput): IntakeResponse {
  const values = new Map<string, IntakeResponse['proposals'][number]>();
  input.messages.forEach((message, messageIndex) => {
    if (message.role !== 'user') return;
    const preceding = input.messages[messageIndex - 1];
    const field =
      baselineFields.find((field) =>
        preceding?.text.endsWith(`Describe ${fieldLabels[field].toLowerCase()}.`),
      ) ?? (messageIndex === 0 ? 'problem' : undefined);
    if (field)
      values.set(field, {
        field,
        text: field === 'title' ? message.text.slice(0, 120) : message.text,
        evidence: [{ messageIndex, quote: message.text.slice(0, 1000) }],
      });
  });
  const next = baselineFields.find((field) => !values.has(field));
  return validateIntake(
    {
      summary: 'Simulated draft updated from your answers. Check the preview before using it.',
      proposals: [...values.values()],
      question: next
        ? {
            field: next,
            text: `Describe ${fieldLabels[next].toLowerCase()}.`,
            options:
              next === 'exclusions'
                ? [
                    {
                      label: 'No exclusions yet',
                      value: 'No exclusions have been agreed yet.',
                      recommended: false,
                      reason: 'Use this only if scope still needs discussion.',
                    },
                    {
                      label: 'Keep the first release focused',
                      value:
                        'Exclude scheduled automation and additional export formats from the first release.',
                      recommended: true,
                      reason:
                        'A smaller first release can be easier to review. Confirm that these exclusions fit your feature.',
                    },
                  ]
                : [],
          }
        : null,
    },
    input,
  );
}
