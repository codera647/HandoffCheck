# Local and hosted setup

## 1. Local demo

Run `npm ci` and `npm run dev`. No environment file is needed for the demo. Public settings are listed in `.env.example`; copy it to `.env.local` when connecting Supabase. Keep all private keys in provider secret settings or ignored local files.

The demo runs in one browser. IndexedDB stores requests and file blobs, and the Web Locks API serializes writes between tabs. Clearing site data removes the workspace. Identity switching simulates roles and is not authentication.

## 2. Supabase database and function

Create a Supabase project or install the Supabase CLI and start the local Docker stack. Docker must be running for `supabase start`. This workspace's database tests can run without Docker, but Google login and Storage require real services.

For a linked hosted project:

```powershell
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
supabase secrets set --env-file supabase/functions/.env.local
supabase functions deploy handoff-api
```

Copy `supabase/functions/.env.example` to `.env.local` in that directory and set `ALLOWED_APP_ORIGINS` to the exact frontend origins. Never use `*`. The function uses Supabase's managed URL, anon key and service-role key variables. It verifies the incoming bearer token through Auth on every request. `verify_jwt=false` in `config.toml` delegates verification to this code; removing the Auth check would open the API.

The browser uses its own user JWT for SQL calls and direct uploads. Domain tables permit author/current-reviewer reads and deny direct writes. Drafts remain author-only until submission; admin status alone grants no request content access. Mutations go through transaction functions that enforce authorship, assigned roles, revision checks, and approval state. The service client is used only for token verification, provider completion, and file verification or signed downloads.

For local services, use `supabase start`, `supabase db reset`, and `supabase functions serve handoff-api --env-file supabase/functions/.env.local`. Use the local public URL and anon key in `.env.local`. Do not commit values produced by `supabase status`.

## 3. Google login and first administrator

Configure Google's OAuth client and Supabase's Google provider following the [Supabase Google login documentation](https://supabase.com/docs/guides/auth/social-login/auth-google). Set the Google authorized redirect URI to the Supabase Auth callback, not the frontend callback. Add the frontend origin and `/auth/callback` to Supabase's allowed redirect URLs.

The current HandoffCheck project and local callback settings are recorded in [GoogleLogin.md](GoogleLogin.md). The local frontend uses port 5174 because BugBrief is running on 5173.

Set these public frontend values:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_KEY
VITE_ENABLE_DEMO=false
```

Sign in once with the intended administrator's Google account. Workspace access will be denied until the operator creates its membership. Read that user's UUID in Supabase Authentication → Users. Run the following in the operator SQL editor, replacing the UUID and name. Do not expose the SQL editor or service key to app users.

```sql
begin;
with workspace as (
  insert into public.workspaces(name, timezone, review_mode)
  values ('Product & Engineering', 'Asia/Karachi', 'checklist_only')
  returning id
), membership as (
  insert into public.memberships(workspace_id,user_id,name,role)
  select id, 'REPLACE_WITH_AUTH_USER_UUID'::uuid, 'Administrator name', 'admin'
  from workspace
  returning workspace_id
)
insert into public.checklist_versions(workspace_id,name)
select workspace_id,'Engineering handoff v1' from membership;
commit;
```

Run this once. The MVP uses one active workspace per employee. Refresh the application and record employee invitations in Settings → Members. Invitations authorize an exact confirmed email for seven days; the app does not send email. Give employees the app URL separately. A revoked employee needs a fresh invitation before returning. The last active administrator cannot be removed through the app.

## 4. Private files

The migration creates the private `request-files` bucket. Authors reserve an upload path, upload once using their JWT, and ask the API to verify its size and file signature. Verified files can be added to a saved revision. Downloads require current request participation and produce a URL valid for five minutes. Revocation or reassignment prevents new links; already issued links work until expiry.

Limits are 5 MB per file, five retained files per request, and a 700 MB application budget. Pending and rejected reservations count toward that budget. Removing a file from the editor detaches it from the next revision; historical files are preserved. Failed reservations require operator cleanup. File-signature checking is not malware scanning, and supporting files are not sent to AI.

## 5. Optional AI review

Keep `review_mode='checklist_only'` for the initial pilot. To enable AI, set `GEMINI_API_KEY` and a currently supported `GEMINI_MODEL_ID` in Edge Function secrets, then change the workspace mode through the operator SQL editor. Use a model supporting [JSON structured output](https://ai.google.dev/gemini-api/docs/structured-output). This adapter calls `generateContent` with `responseMimeType` and `responseJsonSchema`; verify the configured model in the real project before rollout.

Only authored text fields are sent; reference URLs, screenshots, PDFs, names, comments and approvals are excluded. The provider cannot change requirements or approve requests. Invalid evidence, malformed responses, provider errors and timeouts leave an error state. Checklist findings remain authoritative. Assigned leads may dismiss an AI finding with a recorded reason. Quotas are 10 reviews per employee per hour, 50 per workspace per UTC day, and two concurrent reviews. Provider free tiers and availability can change; do not assume a paid model is free.

## 6. Frontend hosting

Vercel hosts the compiled SPA. `vercel.json` defines route fallback and security headers. Public frontend settings are stored in Vercel's production environment; Vite embeds them in the browser bundle. Put no private key in a `VITE_` variable.

```powershell
.\.tools\gh\bin\gh.exe workflow run deploy.yml --ref main
```

The manual Actions workflow runs the checks, builds production output, stages it without assigning the domain, checks application routes, and promotes that build. See [Deployment.md](Deployment.md) for project IDs, return URLs, installer releases and rollback. The retained `wrangler.jsonc` is an alternative deployment configuration.

## 7. Operations before employee data

Assign an operator for backups, restore checks and cleanup. Export the database with the Supabase CLI and separately back up bucket contents; a database export does not include file bytes. Store backups privately. Verify a restore in a separate project before using real company material.

Retention is an operator setting, displayed in the app; no scheduled deletion job is installed. Periodically list expired pending/rejected files, confirm they are not referenced by a revision, remove objects through the Storage API, then remove their metadata. To delete archived requests after the agreed retention period, export required records first and delete related rows and objects in foreign-key order. Do not delete Storage metadata directly while leaving object bytes behind. A scheduled cleanup job and automated backup/restore runbook remain deployment work.
