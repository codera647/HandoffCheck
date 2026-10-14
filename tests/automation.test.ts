import { describe, expect, it } from 'vitest';
import { draft } from './fixtures';
import { parseAssistance } from '../shared/automation';
import { generateAI } from '../shared/ai-provider';
import { linearQuery, publishLinearIssue, type TicketPreview } from '../shared/linear';

const envelope = (value: object, finishReason = 'STOP') =>
  new Response(
    JSON.stringify({
      candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(value) }] } }],
    }),
  );
describe('AI boundary (mocked provider responses)', () => {
  it('sends only requirement fields, excludes reference URLs, and validates evidence', async () => {
    const fields = draft().fields;
    fields.references = [{ label: 'Private', url: 'https://private.example/secret' }];
    let submitted = '';
    const transport: typeof fetch = async (_url, options) => {
      submitted = String(options?.body);
      return envelope({
        items: [
          {
            evidenceField: 'behavior',
            evidenceQuote: fields.behavior,
            text: 'A source-linked summary.',
          },
        ],
      });
    };
    const result = await generateAI(
      'summary',
      fields,
      { key: 'test-key', model: 'test-model' },
      transport,
    );
    expect(result.output).toHaveProperty('items');
    expect(submitted).not.toContain('private.example');
    expect(submitted).not.toContain('test-key');
    await expect(
      generateAI('summary', fields, { key: 'test-key', model: 'test-model' }, async () =>
        envelope({
          items: [{ evidenceField: 'behavior', evidenceQuote: 'invented', text: 'Incorrect.' }],
        }),
      ),
    ).rejects.toThrow('unsupported evidence');
  });
  it('rejects incomplete and oversized output and sanitizes errors without falling back to fixtures', async () => {
    const fields = draft().fields,
      config = { key: 'secret-key', model: 'test-model' };
    await expect(
      generateAI('summary', fields, config, async () => envelope({}, 'MAX_TOKENS')),
    ).rejects.toThrow('incomplete');
    await expect(
      generateAI('summary', fields, config, async () => new Response('x'.repeat(80001))),
    ).rejects.toThrow('too large');
    await expect(
      generateAI(
        'summary',
        fields,
        config,
        async () => new Response('secret-key raw error', { status: 429 }),
      ),
    ).rejects.toThrow('provider limit');
    await expect(
      generateAI('summary', fields, config, async () => {
        throw new Error('secret-key');
      }),
    ).rejects.toThrow('could not be reached');
  });
  it('binds QA to a specific criterion and constrains edits to actual field limits', () => {
    const fields = draft().fields;
    expect(() =>
      parseAssistance(
        'qa',
        {
          tests: [
            {
              criterionIndex: 19,
              criterionQuote: fields.criteria[0],
              kind: 'positive',
              scenario: 'Check',
              steps: ['Run'],
              expected: 'Pass',
            },
          ],
        },
        fields,
      ),
    ).toThrow('outside this brief');
    expect(() =>
      parseAssistance(
        'edits',
        {
          edits: [
            {
              field: 'title',
              text: 'x'.repeat(121),
              reason: 'Clearer',
              evidenceField: 'behavior',
              evidenceQuote: fields.behavior,
            },
          ],
        },
        fields,
      ),
    ).toThrow('limits');
  });
});
describe('Linear boundary (mocked GraphQL responses)', () => {
  const id = '10000000-0000-4000-8000-000000000001',
    teamId = '10000000-0000-4000-8000-000000000002';
  const preview: TicketPreview = {
    briefId: id,
    revision: 1,
    contentHash: 'hash',
    payloadHash: 'hash',
    organizationId: id,
    organizationName: 'Pilot',
    teamId,
    teamName: 'Engineering',
    title: 'Approved feature',
    description: 'Approved source',
    state: 'preview',
    issueUrl: null,
    issueIdentifier: null,
    error: null,
  };
  const issue = {
    id,
    team: { id: teamId },
    title: preview.title,
    description: preview.description,
    url: 'https://linear.app/pilot/issue/ENG-1',
    identifier: 'ENG-1',
  };
  it('recovers a timed-out creation by its persisted UUID without repeating the mutation', async () => {
    let lookups = 0,
      mutations = 0;
    const transport: typeof fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      if (body.query.startsWith('mutation')) {
        mutations++;
        expect(body.variables.input).toEqual({
          id,
          teamId,
          title: preview.title,
          description: preview.description,
        });
        throw new Error('Timeout after upstream write.');
      }
      lookups++;
      return new Response(
        JSON.stringify({ data: { issues: { nodes: lookups === 1 ? [] : [issue] } } }),
      );
    };
    expect((await publishLinearIssue(id, preview, 'test-key', transport)).id).toBe(id);
    expect(mutations).toBe(1);
    expect(lookups).toBe(2);
  });
  it('reuses an existing issue and rejects provider errors or unsafe issue URLs', async () => {
    let calls = 0;
    await publishLinearIssue(id, preview, 'test-key', async () => {
      calls++;
      return new Response(JSON.stringify({ data: { issues: { nodes: [issue] } } }));
    });
    expect(calls).toBe(1);
    await expect(
      linearQuery(
        'query',
        {},
        'test-key',
        async () => new Response(JSON.stringify({ errors: [{ message: 'raw private error' }] })),
      ),
    ).rejects.toThrow('could not complete');
    await expect(
      publishLinearIssue(
        id,
        preview,
        'test-key',
        async () =>
          new Response(
            JSON.stringify({
              data: { issues: { nodes: [{ ...issue, url: 'https://evil.example' }] } },
            }),
          ),
      ),
    ).rejects.toThrow();
  });
});
