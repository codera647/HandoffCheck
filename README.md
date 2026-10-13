# HandoffCheck

An internal feature-request workflow for product and engineering. Authors record requirements, answer clarification questions, and ask two assigned leads to approve the same revision. Approved briefs can be read in the app or downloaded as Markdown.

## Run locally

Requires Node 24 or later and npm.

```powershell
npm ci
npm run dev
```

Open <http://127.0.0.1:5174> and choose **Open demo workspace**. The demo includes an author, product lead, engineering lead, and administrator. Switch identities in the sidebar to try both approval stages. Requests and uploaded files persist in this browser's IndexedDB. Reset them in Settings → Data.

The demo uses synthetic requests and deterministic checklist review. It does not authenticate employees, contact an AI provider, send invitations, or share data between computers. Google login reports that configuration is missing until Supabase is connected.

## Checks

```powershell
npm run typecheck
npm test
npm run test:desktop
npm run test:e2e
npm run build
```

Browser tests use installed Google Chrome locally and Playwright Chromium in CI. Database tests apply SQL migrations to PGlite PostgreSQL, with small substitutes for Supabase Auth and Storage tables. They exercise real SQL functions and row policies; they do not replace testing a running Supabase installation.

## Web and Windows delivery

Live application: <https://handoffcheck.vercel.app>. [Deployment.md](doc/Deployment.md) records the hosting settings, manual GitHub Actions workflows, native authentication and release process. The production build disables the demo workspace.

Run `npm run desktop:dev` to open the native app or `npm run desktop:package` to build the Windows x64 installer. The app connects to the live workspace and opens Google sign-in in the system browser. It requires internet access. Installers are unsigned until a signing certificate is configured.

## Project files

| Path | Purpose |
| --- | --- |
| `src/` | React screens, session handling, demo and hosted repositories |
| `shared/` | Validated contracts, demo workflow, evidence and file checks |
| `supabase/migrations/` | Database, access policies, workflow transactions and private storage |
| `supabase/functions/handoff-api/` | Verified user API and optional server-side language review |
| `tests/`, `e2e/` | Domain, PostgreSQL and browser checks |
| `doc/Architecture.md` | System design and technical diagrams |
| `doc/Design.md` | Screens, typography, tokens and interaction design |
| `doc/Setup.md` | Supabase, Google OAuth and deployment setup |
| `doc/GoogleWorkspace.md` | Forms → Sheets → app → approved Docs connection, setup and checks |
| `google-workspace/` | Owner-operated Apps Script source and permission manifest |
| `doc/Implementation.md` | Implemented scope and remaining integration checks |
| `doc/Deployment.md` | Vercel deployment, GitHub Actions and Windows releases |
| `desktop/` | Native shell, isolated sign-in bridge and callback tests |

The interface uses a light neutral palette, charcoal actions, and semantic green, ochre and red status indicators. It has no blue or purple accents or gradients.
