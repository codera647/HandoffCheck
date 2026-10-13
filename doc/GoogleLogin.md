# Google login setup

## Current project

HandoffCheck uses the separate Supabase project `dpwzjmqvsqifbgspoylc`, with public API URL `https://dpwzjmqvsqifbgspoylc.supabase.co`. The ignored `.env.local` contains this URL and its public publishable key. Private credentials belong in provider settings, never in frontend environment variables.

Google client ID: `651860876422-2u4v86ee2u430jelbahqlg30gmtirtk8.apps.googleusercontent.com`.

On 13 October 2026, Supabase showed this client ID, a masked saved client secret, and Google sign-in enabled after saving. The secret was not revealed or copied. The user reports saving the local redirect settings and reaching the app's workspace-access screen after sign-in. The returned session has not been independently inspected.

## Exact local settings

The app runs at `http://127.0.0.1:5174`. Port 5173 currently serves BugBrief; returning there would open the wrong app.

In Google Auth Platform, use a **Web application** OAuth client with these authorized JavaScript origins:

```text
http://127.0.0.1:5174
http://localhost:5174
```

Its authorized redirect URI is the Supabase endpoint:

```text
https://dpwzjmqvsqifbgspoylc.supabase.co/auth/v1/callback
```

In Supabase Authentication → URL Configuration, set **Site URL** to `http://127.0.0.1:5174`. Save both exact redirect URLs:

```text
http://127.0.0.1:5174/auth/callback
http://localhost:5174/auth/callback
```

The app uses redirect-based Google OAuth. It does not use One Tap. Keep nonce checks enabled and require an email. Login needs only the standard identity scopes; Drive, Docs and Forms access are separate integrations. If Google's audience is External and in Testing, add pilot accounts as test users. Use Internal only when the actual Google Workspace organization supports it.

## App behavior and checks

**Continue with Google** handles both first-time signup and returning users. Supabase creates the sign-in account; the API separately checks an active employee invitation or existing membership before allowing workspace access. Creating an account does not assign an application role.

The frontend uses PKCE and explicitly exchanges the one-time callback code. It clears the callback code and provider error details from browser history. React StrictMode shares the callback exchange promise. A callback takes precedence over a saved demo identity; cancelled or expired sign-ins return a useful error.

Unit tests cover saved-session restoration, successful code exchange, cancelled login, missing code, expired/verifier errors, and callback cleanup. These use a simulated Auth gateway and do not prove Google accepts the real client configuration.

Both migrations and `handoff-api` version 1 are now deployed to the separate HandoffCheck project. The private `request-files` bucket is created by the workflow migration. The user's selected, confirmed Google account has the first administrator membership in Product & Engineering. The initial checklist is Engineering handoff v1; review mode is checklist-only. The operator bootstrap checked the exact confirmed Google identity before creating membership and recorded an audit event. Personal account identifiers remain in ignored operator files rather than this document.

The earlier HTTP 404 (`Requested function was not found`) is resolved. Live checks returned HTTP 204 for the approved local preflight, HTTP 401 for an unauthenticated request, and HTTP 403 without CORS permission for an unapproved origin. The real database returned the administrator's workspace context using the authenticated database role and that user's claim; this operator check did not use a browser JWT.

After deployment, the user's existing Google browser session successfully loaded the Requests page in Product & Engineering. Profile showed Google via Supabase Auth and Administrator. Members showed the active administrator and invitation controls. The workspace-access error is resolved. Screenshots are saved in `doc/screenshots/hosted-workspace-connected.jpg` and `doc/screenshots/hosted-admin-members.jpg`.

Open the local app at `http://127.0.0.1:5174`. Record invitations for distinct product and engineering leads in Settings → Members before assigning reviewers to a feature request. Complete any future Google account selection or consent yourself. Follow [Setup.md](Setup.md) for future deployments and operations.

Provider instructions: [Supabase Google login](https://supabase.com/docs/guides/auth/social-login/auth-google) and [redirect URL configuration](https://supabase.com/docs/guides/auth/redirect-urls).
