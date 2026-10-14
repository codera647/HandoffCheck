# Implementation status

## Automation implementation · 14 October 2026

Requirement edit proposals, reviewer summaries, approved-brief QA drafts, durable task states, bounded retries and usage budgets are implemented. Author acceptance uses the existing save transaction and creates a new immutable revision. QA review is restricted to the assigned engineering lead. Automatic brief creation remains optional and uses the canonical deterministic command after both human approvals.

The automation/Linear migrations, a follow-up grant-tightening migration and the updated `handoff-api` / new `automation-worker` are deployed on the existing Supabase pilot. The private Cron dispatcher is installed with a separate Vault/Edge signing key. Live verification returned 200 for a signed worker call, 409 for its replay and 401 for an unsigned request. A real `pg_net` request with Vault-backed signing returned 200; Cron runs succeeded. Ordinary authenticated clients cannot read Vault secrets. The API requires sign-in (401), accepts the production preflight (204) and rejects an unapproved origin (403).

The workspace remains in `checklist_only`, with all new feature switches disabled and no automation jobs or external handoffs created. Gemini credentials are deferred by the owner. Linear is selected, but its backend key and destination team are pending. Configuration instructions and account-level acceptance are in [AutomationSetup.md](AutomationSetup.md). The ChatGPT Linear connection does not configure the deployed application's credentials.

Local verification passed 34 application/provider/database checks, seven native authentication checks, the production build and both Edge type checks with frozen dependency locks. Six browser workflows passed; the two automation workflows also passed after checking that print output excludes assistance/reminders. Provider responses are mocked in boundary tests, and the local demo uses explicitly labelled fixtures. UI screenshots were inspected at desktop and 320-pixel widths. The build retains the existing large initial-chunk warning (about 703 KB before gzip).

[Manual deployment run 38610979671](https://github.com/codera647/HandoffCheck/actions/runs/38610979671) passed CI and promoted the automation frontend from commit `4d98cbf` to [handoffcheck.vercel.app](https://handoffcheck.vercel.app). That run passed the 33 checks present in its commit, all six browser workflows, both Edge checks, native authentication checks and the build. The later grant fix changes backend permissions and regression coverage; it does not change frontend code.

Hosted inspection identified Supabase's inherited `TRUNCATE` grants on the new automation tables. Row-level policies do not govern that operation. The follow-up migration explicitly revoked all client privileges, then restored only intended member reads for policy and recipient-scoped notifications. Hosted anonymous/member `TRUNCATE` checks are now false. The local PostgreSQL fixture now reproduces Supabase's default grants, and the additional regression check verifies denial on every new table.

Supabase's security advisor completed without error-level findings. It warns about authenticated `SECURITY DEFINER` entry points, which intentionally enforce membership, role, revision and recipient checks; private worker and Linear mutation functions are not executable by clients. It also retains the existing disabled leaked-password-protection warning. See [RPC advisory guidance](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable) and [password guidance](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). This result is not a full security audit. Real Gemini output quality, Linear issue delivery, hosted file transport and the complete Form-to-Doc acceptance are still pending.

The neutral design extends existing request, brief and Settings screens. The installed Windows app loads the hosted UI; no native installer or authentication changes are required.

## Production web and Windows delivery

On 13 October 2026, [Deploy production run 38439240349](https://github.com/codera647/HandoffCheck/actions/runs/38439240349) passed and promoted commit `f852379` to [handoffcheck.vercel.app](https://handoffcheck.vercel.app). GitHub Actions passed TypeScript, 23 application/database checks, seven desktop authentication checks, four browser workflows and the production build. Deployment runs only by manual dispatch on main.

Public checks returned the built app on `/`, `/login`, `/auth/callback` and a direct request path, with CSP, frame restrictions and MIME-sniffing protection. The real Edge API returned the expected production-origin preflight. A packaged Windows app loaded the production Google login screen; its isolated preload bridge was available, Node access was unavailable, and sandbox/context-isolation/web-security settings were verified. This check used a fresh temporary profile and did not sign into Google.

The [Windows release run 38440190552](https://github.com/codera647/HandoffCheck/actions/runs/38440190552) passed for tag `v0.1.0`, commit `a8aa752`. It built the unsigned NSIS x64 installer, launched the packaged app against production, verified its isolated renderer, calculated SHA-256 and published the [pilot release](https://github.com/codera647/HandoffCheck/releases/tag/v0.1.0). The release includes the installer and `SHA256SUMS.txt`. See [Deployment.md](Deployment.md). No native auto-updater or offline workspace is implemented.

The owner reported saving the production Supabase return URLs and updating Apps Script `APP_URL`, then confirmed that Google sign-in opened the Requests page in both the live web app and the installed Windows app on 13 October 2026. These account sign-in checks were performed by the owner. Hosted file transport and completed Form-to-Doc acceptance remain pending. The production demo is disabled. The installed production dependency audit reported no known vulnerabilities; build-tool advisories are recorded separately in Deployment.md.

This file records the implementation and deployed backend. Architecture.md and Design.md describe the pilot; this file distinguishes verified behavior from remaining integration work.

## Available locally

The React app includes a requests table with search, filters and pagination, an assigned-review queue, a structured feature editor, clarification discussion, two-stage approval, revision comparison, saved briefs with Markdown download/copy/print, membership settings and checklist version publishing. The demo persists data and files in IndexedDB and labels simulated identities and checklist-only review.

Saving creates a new immutable revision. Approval requires an active assigned lead different from the author and applies to one reviewed revision and input hash. An approval confirmation captures that revision when opened. Requested changes require a new revision. Old approved briefs remain readable after edits. Brief generation is deterministic and one artifact is retained per revision.

The Supabase migrations implement the hosted transactions, read policies, invite acceptance, administrator controls, quota limits and private upload reservations. The Edge Function implements verified bearer authentication, the API routes used by the frontend, signature verification, signed downloads and optional Gemini structured review.

## Implementation choices

- Request pagination uses a stable sort by updated timestamp and number, with page offsets of 25. It does not use the proposed cursor API. At 10–20 pilot users this keeps the table simple; concurrent changes can move rows between pages.
- The initial checklist contains the approved mandatory baseline. Administrators can publish named versions; arbitrary checklist-field configuration is not included.
- File limits apply to retained uploads, including historical and failed reservations. Five active attachments alone would permit unbounded historical storage. Operator cleanup releases capacity.
- Demo and SQL workflows implement the same permission and state rules in their respective runtimes. Shared Zod contracts validate the API boundary; PostgreSQL independently enforces write rules. Tests cover revision hashing and representative workflows in both.
- The export templates have the same substantive sections. PostgreSQL uses plain reference text and bullet criteria; the browser demo uses Markdown links and numbered criteria. Each stored export has its own content hash.
- AI is optional. Checklist-only review reports field presence and does not claim to judge language ambiguity or implementation feasibility.
- Idempotent retries apply to request creation and workflow commands. Admin actions and upload reservations do not use command receipts; duplicate pending invitations are rejected, and unsuccessful upload reservations remain counted until cleanup.

## Remaining integration checks

The separate HandoffCheck Supabase project is configured locally and its Google provider is enabled. The initial migrations and API are deployed, the private file bucket exists, and the selected confirmed Google account has the first administrator membership. The user's existing Google session successfully loads Requests, Profile and Members through the real API. The missing-function error is resolved. Hosted upload/download transport and provider calls still need checks. Vercel is the selected frontend host; see Deployment.md for manual deployment and Windows releases. Local PostgreSQL tests use substituted Auth and Storage schemas, so they cannot prove upload transport, signed URL behavior, JWT expiration or provider availability.

The Google Workspace migration, updated `handoff-api`, and `workspace-bridge` are deployed. The bridge secret and administrator owner are configured. The app includes connection status, pause/resume, and approved Doc links. Owner-operated Apps Script source and a permission manifest implement Forms intake, Sheet tracking, missed-response recovery, and private approved Doc exports. The owner reported successful setup execution, and a live Supabase query confirmed an enabled connection with Form, Sheet, and folder IDs. At that check, no completed sync, imported submission, or exported Doc was recorded. Live Form-to-draft and approved Doc acceptance remain pending. The user performs browser steps manually. See [GoogleWorkspace.md](GoogleWorkspace.md).

The pilot still needs operator backup/restore verification and a retention cleanup process. No email delivery, ticket-system integration, attachment content extraction, antivirus service, background queue, or multi-workspace chooser is included.

## Verification on 13 October 2026

- `npm run build`: passed TypeScript and production compilation after the explicit Google callback changes. Screen modules load separately; the largest initial JavaScript chunk is 689 KB before gzip, producing Vite's size warning.
- `npm test`: 21 checks passed after the Google Workspace implementation. These cover existing callback/domain/workflow rules plus HMAC tampering/expiry, Form mapping, spreadsheet formula prevention, active verified Google membership, duplicate/changed responses, service-only bridge calls, replay protection, pause/owner role, and approved Doc artifact/hash checks.
- `npm run test:e2e`: four Chrome workflows passed: cancelled Google callback/demo recovery; dual approval/export/edit history; incomplete draft/file upload/download/checklist questions; 320-pixel layout and keyboard tabs/navigation. The new callback test uses a simulated cancellation; it does not sign into Google.
- Edge Function: `deno check` passed with the function's import map. A language-provider call was not tested.
- Hosted deployment: the CLI applied both SQL migrations and deployed `handoff-api` with its shared source files and import map. Live requests verified allowed-origin preflight (204), required sign-in (401), and unapproved-origin rejection (403). A real database operator check under the authenticated role returned the selected administrator's workspace context. The signed-in Chrome session then loaded Requests, Profile and Members successfully, confirming real API access. A language-provider call remains unverified.

Tests run against synthetic data. They provide regression coverage for these behaviors and do not constitute a full security audit.

Workspace deployment checks: `deno check` passed for both functions using the existing pinned dependency lockfile; no dependency-age policy was disabled. Live bridge requests returned 401 for unsigned/tampered requests, 409 for a reused nonce, and 422 `NOT_CONFIGURED` for a valid signed sync before Google asset binding. These prove endpoint verification, not Google consent, Form submission, or Doc creation. Production build and all four existing browser workflows passed after integration; Vite retains the existing large initial-chunk warning (about 691 KB before gzip).

Before the Form item fix, the full local run passed 21 tests, including denied direct connector updates and table truncation, plus TypeScript and the production build. After the fix, all four focused Workspace tests and TypeScript passed; two new regression cases cover typed item creation and partial-setup retries. Supabase's security advisor completed with no error-level findings. It reports warnings for authenticated `SECURITY DEFINER` RPCs and disabled leaked-password protection. These RPC entry points are intentional and enforce current membership/role checks; their grants were retained. The pilot provides Google sign-in, and password-provider configuration was not changed or audited in this task. This advisor result is not a full security audit.
