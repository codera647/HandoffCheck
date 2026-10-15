export const gmailConfig = () => ({
  clientId: Deno.env.get('GOOGLE_GMAIL_CLIENT_ID'),
  clientSecret: Deno.env.get('GOOGLE_GMAIL_CLIENT_SECRET'),
  encryptionKey: Deno.env.get('GMAIL_TOKEN_ENCRYPTION_KEY'),
  callbackUrl: `${Deno.env.get('SUPABASE_URL')}/functions/v1/handoff-api/gmail/callback`,
});
