import { z } from 'zod';

export const linearTeamSchema = z.object({ id: z.uuid(), name: z.string(), key: z.string() });
export const linearConnectionSchema = z.object({
  configured: z.boolean(),
  organizationId: z.string().nullable(),
  organizationName: z.string().nullable(),
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  version: z.number().int(),
  demo: z.boolean(),
});
export type LinearConnection = z.infer<typeof linearConnectionSchema>;
export const linearTeamsSchema = z.object({
  organization: z.object({ id: z.uuid(), name: z.string() }),
  teams: z.array(linearTeamSchema),
});
export type LinearTeams = z.infer<typeof linearTeamsSchema>;
export const ticketPreviewSchema = z.object({
  briefId: z.uuid(),
  revision: z.number().int(),
  contentHash: z.string(),
  payloadHash: z.string(),
  organizationId: z.string(),
  organizationName: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  title: z.string(),
  description: z.string(),
  state: z.enum(['preview', 'creating', 'created', 'failed']),
  issueUrl: z.string().nullable(),
  issueIdentifier: z.string().nullable(),
  error: z.string().nullable(),
});
export type TicketPreview = z.infer<typeof ticketPreviewSchema>;
export const linearIssueSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  identifier: z.string(),
  url: z
    .string()
    .url()
    .refine((value) => new URL(value).origin === 'https://linear.app'),
  team: z.object({ id: z.uuid() }),
});

export class LinearFailure extends Error {}
/** Fixed provider endpoint; errors never include API keys or raw provider responses. */
export async function linearQuery(
  query: string,
  variables: object,
  key: string,
  transport: typeof fetch = fetch,
): Promise<unknown> {
  if (!key)
    throw new LinearFailure(
      'Linear is not configured. Ask the administrator to add its backend key.',
    );
  try {
    const response = await transport('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: key },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok)
      throw new LinearFailure(
        response.status === 429
          ? 'Linear rate limit reached. Try later.'
          : 'Linear rejected the request. Check the backend key and team access.',
      );
    const reader = response.body?.getReader();
    let size = 0,
      text = '';
    const decoder = new TextDecoder();
    if (reader)
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 150000) {
          await reader.cancel();
          throw new LinearFailure('Linear returned too much data.');
        }
        text += decoder.decode(part.value, { stream: true });
      }
    text += decoder.decode();
    const envelope = z
      .object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() })
      .parse(JSON.parse(text));
    if (envelope.errors?.length)
      throw new LinearFailure(
        'Linear could not complete the request. Check team access or retry to reconcile the saved issue.',
      );
    return envelope.data;
  } catch (error) {
    if (error instanceof LinearFailure) throw error;
    throw new LinearFailure(
      'Linear could not be reached or returned an invalid response. Retry to check the saved issue before creating it.',
    );
  }
}
export async function fetchLinearTeams(
  key: string,
  transport: typeof fetch = fetch,
): Promise<LinearTeams> {
  const result = z
    .object({
      organization: linearTeamsSchema.shape.organization,
      teams: z.object({
        nodes: z.array(linearTeamSchema),
        pageInfo: z.object({ hasNextPage: z.boolean() }),
      }),
    })
    .parse(
      await linearQuery(
        'query { organization { id name } teams(first:100) { nodes { id name key } pageInfo { hasNextPage } } }',
        {},
        key,
        transport,
      ),
    );
  if (result.teams.pageInfo.hasNextPage)
    throw new LinearFailure(
      'This pilot supports selecting from at most 100 accessible teams. Use a team-scoped key.',
    );
  return { organization: result.organization, teams: result.teams.nodes };
}
const issueFields = 'id title description identifier url team { id }';
/** Caller supplies a persisted UUID v4. A retry looks up that UUID before any mutation. */
export async function publishLinearIssue(
  id: string,
  preview: TicketPreview,
  key: string,
  transport: typeof fetch = fetch,
  beforeCreate: () => Promise<void> = async () => {},
) {
  const lookup = async () => {
    const value = z
      .object({ issues: z.object({ nodes: z.array(linearIssueSchema) }) })
      .parse(
        await linearQuery(
          `query($filter:IssueFilter!) { issues(filter:$filter,first:1,includeArchived:true) { nodes { ${issueFields} } } }`,
          { filter: { id: { eq: id } } },
          key,
          transport,
        ),
      );
    return value.issues.nodes[0];
  };
  const existing = await lookup();
  if (existing) {
    // Human edits in Linear remain intact. The persisted ID binds recovery to this handoff.
    if (existing.id !== id || existing.team.id !== preview.teamId)
      throw new LinearFailure(
        'The saved issue has moved to a different team. Ask an administrator to reconcile it.',
      );
    return existing;
  }
  await beforeCreate();
  try {
    const value = z
      .object({
        issueCreate: z.object({ success: z.boolean(), issue: linearIssueSchema.nullable() }),
      })
      .parse(
        await linearQuery(
          `mutation($input:IssueCreateInput!) { issueCreate(input:$input) { success issue { ${issueFields} } } }`,
          {
            input: {
              id,
              teamId: preview.teamId,
              title: preview.title,
              description: preview.description,
            },
          },
          key,
          transport,
        ),
      );
    if (!value.issueCreate.success || !value.issueCreate.issue)
      throw new LinearFailure(
        'Linear did not confirm issue creation. Retry to reconcile the saved issue.',
      );
    const issue = value.issueCreate.issue;
    if (issue.id !== id || issue.team.id !== preview.teamId)
      throw new LinearFailure(
        'Linear returned a different issue or team. Ask an administrator to reconcile it.',
      );
    return issue;
  } catch (error) {
    // Do not retry a mutation blindly after an uncertain network result.
    const recovered = await lookup();
    if (recovered && recovered.id === id && recovered.team.id === preview.teamId) return recovered;
    if (error instanceof LinearFailure) throw error;
    throw new LinearFailure(
      'Linear did not confirm issue creation. Retry to check the saved issue.',
    );
  }
}
