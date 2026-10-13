import { z } from 'zod';
import { fieldsSchema } from './contracts.ts';

const assetId = z.string().regex(/^[A-Za-z0-9_-]{10,200}$/);
export const bridgeActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('configure'),
      data: z.object({ formId: assetId, sheetId: assetId, folderId: assetId }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('import'),
      data: z
        .object({
          formId: assetId,
          responseId: z.string().min(1).max(200),
          email: z.email().max(254),
          fields: fieldsSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('sync'),
      data: z
        .object({ after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('document'),
      data: z
        .object({
          briefId: z.uuid(),
          documentId: assetId,
          contentHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    })
    .strict(),
  z.object({ action: z.literal('complete'), data: z.object({}).strict() }).strict(),
]);

/** Sign the exact bytes sent by Apps Script. A database nonce fences valid replays. */
export async function verifyBridgeSignature(
  secret: string,
  body: string,
  timestamp: string,
  nonce: string,
  signature: string,
  now = Date.now(),
): Promise<boolean> {
  if (
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > 300000 ||
    !z.uuid().safeParse(nonce).success ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const bytes = Uint8Array.from(signature.match(/../g)!, (pair) => parseInt(pair, 16));
  return crypto.subtle.verify(
    'HMAC',
    key,
    bytes,
    new TextEncoder().encode(`${timestamp}\n${nonce}\n${body}`),
  );
}
export const workspaceConnectionSchema = z
  .object({
    enabled: z.boolean(),
    formId: z.string().nullable(),
    sheetId: z.string().nullable(),
    folderId: z.string().nullable(),
    lastSyncAt: z.string().nullable(),
  })
  .nullable();
export type WorkspaceConnection = z.infer<typeof workspaceConnectionSchema>;
export const googleDocumentSchema = z
  .object({ documentId: z.string(), createdAt: z.string() })
  .nullable();
export type GoogleDocument = z.infer<typeof googleDocumentSchema>;
