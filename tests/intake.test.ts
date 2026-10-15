import { describe, expect, it } from 'vitest';
import { baselineFields } from '../shared/contracts';
import { generateIntake } from '../shared/ai-provider';
import {
  demoIntake,
  intakeFields,
  intakeInputSchema,
  missingIntakeFields,
  validateIntake,
  type IntakeInput,
} from '../shared/intake';

const input: IntakeInput = {
  messages: [{ role: 'user', text: 'Analysts need CSV exports of the selected dates.' }],
};
const proposal = {
  field: 'behavior',
  text: 'Export the selected dates as CSV.',
  evidence: [{ messageIndex: 0, quote: 'CSV exports of the selected dates' }],
};
const response = {
  summary: 'Check this proposed export behavior.',
  proposals: [proposal],
  question: null,
};

describe('conversational request drafting', () => {
  it('keeps missing fields empty, asks a next question and never chooses reviewers', () => {
    const result = validateIntake(response, input);
    expect(result.question?.field).toBe('title');
    const fields = intakeFields(result);
    expect(fields.behavior).toBe(proposal.text);
    expect(fields.problem).toBe('');
    expect(missingIntakeFields(fields)).toContain('dataImpact');
    expect(result).not.toHaveProperty('productReviewerId');
  });
  it('rejects invented quotations and assistant-authored evidence', () => {
    expect(() =>
      validateIntake(
        {
          ...response,
          proposals: [{ ...proposal, evidence: [{ messageIndex: 0, quote: 'invented' }] }],
        },
        input,
      ),
    ).toThrow('outside');
    const conversation: IntakeInput = {
      messages: [
        ...input.messages,
        { role: 'assistant', text: 'Exports are allowed for everyone.' },
        { role: 'user', text: 'I have not decided.' },
      ],
    };
    expect(() =>
      validateIntake(
        {
          ...response,
          proposals: [{ ...proposal, evidence: [{ messageIndex: 1, quote: 'everyone' }] }],
        },
        conversation,
      ),
    ).toThrow('outside');
  });
  it('does not add a recommendation to the form until the author answers', () => {
    const question = {
      field: 'exclusions',
      text: 'Which formats should be excluded?',
      options: [
        {
          label: 'CSV first',
          value: 'Exclude PDF exports.',
          recommended: true,
          reason: 'A smaller first release.',
        },
      ],
    };
    const result = validateIntake({ ...response, question }, input);
    expect(intakeFields(result).exclusions).toBe('');
    expect(() =>
      validateIntake(
        {
          ...response,
          question: { ...question, options: [question.options[0], question.options[0]] },
        },
        input,
      ),
    ).toThrow('conflicting');
    expect(() => validateIntake({ ...response, proposals: [proposal, proposal] }, input)).toThrow(
      'repeats',
    );
  });
  it('bounds the transcript and proposed field sizes', () => {
    expect(
      intakeInputSchema.safeParse({ messages: [{ role: 'assistant', text: 'Only a question' }] })
        .success,
    ).toBe(false);
    expect(
      intakeInputSchema.safeParse({ messages: [{ role: 'user', text: 'x'.repeat(3001) }] }).success,
    ).toBe(false);
    expect(() =>
      validateIntake(
        { ...response, proposals: [{ ...proposal, field: 'title', text: 'x'.repeat(121) }] },
        input,
      ),
    ).toThrow('limits');
  });
  it('uses the same structured provider adapter and surfaces service failures', async () => {
    const result = await generateIntake(
      input,
      { key: 'synthetic-key', model: 'mock-model' },
      async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.generationConfig.responseMimeType).toBe('application/json');
        expect(body.systemInstruction.parts[0].text).toContain('Do not assign reviewers');
        return new Response(
          JSON.stringify({
            candidates: [
              { finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(response) }] } },
            ],
          }),
        );
      },
    );
    expect(result.output.proposals[0].field).toBe('behavior');
    await expect(
      generateIntake(
        input,
        { key: 'synthetic-key', model: 'mock-model' },
        async () => new Response('', { status: 503 }),
      ),
    ).rejects.toThrow('HTTP 503');
  });
  it('lets the labelled demo collect a complete draft across turns', () => {
    const messages = [...input.messages];
    let result = demoIntake({ messages });
    for (let index = 0; index < baselineFields.length - 1; index++) {
      const question = result.question!;
      messages.push(
        { role: 'assistant', text: `${result.summary}\n\n${question.text}` },
        { role: 'user', text: `${question.field} confirmed by the author.` },
      );
      result = demoIntake({ messages });
    }
    expect(result.question).toBeNull();
    expect(missingIntakeFields(intakeFields(result))).toEqual([]);
    expect(intakeFields(result).problem).toBe(input.messages[0].text);
  });
});
