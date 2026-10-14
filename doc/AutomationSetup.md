# Automation setup

14 October 2026

The automation code adds requirement edits, source-linked reviewer summaries, QA drafts, queued execution, in-app reminders, automatic approved briefs and confirmed Linear handoffs. All workspace feature toggles start disabled. Google sign-in and Google Workspace intake use the existing configuration.

## Gemini: configure later when ready

1. Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/api-keys). Use a project you control.
2. Open [HandoffCheck Edge Function secrets](https://supabase.com/dashboard/project/dpwzjmqvsqifbgspoylc/functions/secrets). Add `GEMINI_API_KEY` privately. Do not put it in chat, Apps Script, a `VITE_` variable or GitHub source.
3. Set `GEMINI_MODEL_ID` to a currently available model supporting structured JSON output. `gemini-3.8-flash` was checked against Google's model documentation for this implementation. Availability and quotas depend on your project; verify the model in AI Studio before enabling it.
4. Sign in to HandoffCheck as an administrator. Open **Settings → Automation** and run **Test Gemini with synthetic text**. This sends a fixed synthetic example and counts toward the daily attempt budget. A configured key is not a successful provider test.
5. Enable AI review and the assistance features you want. Save settings, then try a synthetic request. Requirement text is sent to Gemini; reference URLs, uploaded files, comments, member profiles and identities are excluded. Text you type may still contain personal information. No automatic redaction is claimed.

The key is currently deferred by the owner. Live model quality, model/account access and provider quotas must still be tested. The application does not fall back to demo output when a provider fails.

Google's [structured output guide](https://ai.google.dev/gemini-api/docs/structured-output) documents schema-constrained responses. Valid structure and matching evidence do not prove that a suggestion is correct; authors and reviewers must check it.

## Linear: select the actual destination

1. In your Linear workspace, create a personal API key with permission to read teams/issues and create issues for the intended engineering team. Use the narrowest team access available. See [Linear's API guide](https://linear.app/developers/graphql).
2. Save it privately as `LINEAR_API_KEY` in the same Supabase Edge Function secrets page. The ChatGPT Linear connector does not supply credentials to the deployed HandoffCheck application.
3. In HandoffCheck, open **Settings → Linear**, choose **Load accessible teams**, select the intended team, then confirm the displayed organization and team.
4. Open a current approved brief as its author or assigned lead. Choose **Preview Linear ticket**, review the exact title, Markdown description and destination, then **Confirm and create ticket**.
5. Check the issue link and content in Linear. No live ticket has been sent as part of credential-free testing.

The ticket contains the approved Markdown brief, its HandoffCheck source link and artifact hash. It does not upload supporting screenshots/PDFs to Linear. The approved brief may contain reference links and approver names already present in its Markdown; the full description is visible before sending.

A handoff retains its original destination and a UUID v4 across retries. A retry first looks up that issue, including archived issues, before creating it. Existing Linear edits remain intact. If an administrator changes the destination during an unfinished handoff, sending stops and the original destination must be reconciled. Creating a later approved revision creates a separate handoff after a new confirmation. Historical briefs remain readable but cannot initiate a new external send.

An API request cannot grant workspace membership or bypass either approval. The administrator configures the destination; the admin role alone cannot send another author's brief.

## Private scheduler

After deploying migrations and the worker, an authenticated Supabase operator runs:

```powershell
node scripts/configure-automation.mjs
node scripts/check-automation-worker.mjs
```

The setup script is pinned to the existing HandoffCheck project and workspace. It enables `pg_cron` and `pg_net`, stores a dedicated HMAC key in Vault and Edge secrets, and installs a minute scheduler check. It writes credentials only under ignored `supabase/.temp/`; the filled SQL file is removed after setup. Do not share the remaining worker environment file. This key is separate from the Google Workspace bridge key.

The SQL dispatcher invokes the Edge worker only for due AI work, an enabled hourly reminder scan or daily retention maintenance. It signs the exact JSON bytes, timestamp and nonce. Unsigned, altered, expired and replayed calls cannot claim jobs. [Supabase Cron](https://supabase.com/docs/guides/cron), [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net) and [Vault](https://supabase.com/docs/guides/database/vault) document the platform components.

Background processing returns queued work promptly; accepted manual tasks also retain their durable queue record for recovery. The worker claims at most two tasks per invocation, with a global two-lease concurrency limit. Draft tasks retry transient network/server errors at most twice after the initial attempt. Provider rate-limit, malformed-output and configuration failures require a deliberate retry. Requirement review failures require a new explicit review so reviewers see the error.

Settings limit provider attempts to at most 50 per workspace per UTC day, including retries and synthetic checks. AI execution also stops at ten attempts per actor per hour. These are application limits, not a promised provider bill or quota. Set provider-side limits separately if needed.

Reminders are in-app records, once per assigned reviewer per waiting revision. They do not send email, Slack messages or notifications to an external service. Only the recipient can mark a notification read.

For diagnosis, inspect Cron run status and `net._http_response` as the database operator; avoid printing request headers or Vault secret values. Pause background work by disabling the Cron job, and disable new AI work in Automation settings. Policy changes, revoked access and changed revisions cancel pending results before publication.

## Human controls and retention

- An author compares a suggested field edit and explicitly accepts it. Saving uses the existing revision transaction, resets the applicable approvals and requires review again. Remaining proposals for the old revision become outdated.
- Reviewer summaries cite the input revision. They do not assert readiness or replace the full request.
- QA drafts cite criteria from a stored approved brief. Only its assigned active engineering lead can mark a draft reviewed. That state means human review of the draft; no tests have been executed.
- Automatic brief creation is optional and deterministic. It runs only after the second valid human approval and uses the existing brief-generation command. It does not call Gemini.
- Unaccepted, unreviewed terminal AI artifacts are cleaned after the workspace's existing retention period during worker maintenance. Accepted edit provenance and reviewed QA drafts are retained. This maintenance does not implement deletion of all requests, files, Google documents or audit history.

The installed Windows app loads the same hosted UI. These additions do not change its native login bridge or require a new installer.

## Acceptance still requiring your accounts

Run a real synthetic Gemini check and inspect one review, suggestion, summary and QA result after configuring the key. Configure a Linear destination and confirm one synthetic approved ticket; retry to verify that it opens the same issue. Complete the existing Form → draft → two leads → private Google Doc check and hosted upload/download check separately. Local provider mocks and demo fixtures do not substitute for these account-level checks.
