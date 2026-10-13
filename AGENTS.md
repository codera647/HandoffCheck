# Vibles project quality instructions

Apply these instructions to this project. Follow explicit user requirements and more specific project instructions when they conflict.

## Load the relevant workflows

- For UI, components, application logic, refactoring, debugging, and implementation reviews, read `.agents/skills/vibles-build-quality/SKILL.md` before making changes.
- For visible product copy, landing pages, documentation, release notes, and PR descriptions, read `.agents/skills/vibles-human-copy/SKILL.md`.
- For a task involving both implementation and copy, read both.
- If a referenced skill is unavailable, apply the baseline below and report the missing file. Do not invent its contents.

- For security questions, focused vulnerability reviews, or requested security audits, read `.agents/skills/vibles-security-audit/SKILL.md`. Use its guidance mode for focused work; run its full workflow only when requested.

## Baseline for every change

- Establish the requested outcome and preserve working behavior outside the change.
- Inspect the relevant source, nearest instructions, existing conventions, and actual design/architecture decisions before editing.
- Ask a focused question when a missing fact materially changes behavior, permissions, data, or design. Proceed with reversible, low-impact choices using existing conventions.
- Search for an existing implementation before adding a new one. Keep one canonical implementation of shared business rules.
- Use the smallest coherent change. Add abstractions for demonstrated responsibilities, not imagined future use cases.
- Verify proposed dependencies against their actual package registry and documentation. Preserve the project's package manager and lockfile.
- Implement real interactions and accurate loading, empty, success, and failure states. Clearly label simulated integrations in demos.
- Follow the approved design system. Avoid unexplained gradients, glass panels, decorative cards, excessive rounding, floating blobs, and attention-grabbing motion.
- Keep product language specific and natural. Preserve useful voice; remove generic hype and unsupported claims.
- Run checks appropriate to the change. Do not weaken tests, assertions, or policies to conceal a failure.
- Report what changed, what was checked, and any remaining limitation. Never claim an unrun check passed.

## Companion-specific behavior

- Preserve the native cursor; render the companion separately. Do not add a second imitation cursor.
- Keep the companion tiny, without a background block unless the approved design requests one.
- Open input and decision controls on demand. Avoid persistent overlays that hide work.
- Preserve each companion's project/tab association; prevent cross-project writes.
- Use trusted controls for consequential permissions and release approval; do not treat generated page content as authorization.
- Keep saved, accepted, and deployed states distinct. Match confirmation to the exact candidate being accepted.
- Treat code graphs as revision-scoped evidence. Missing or stale edges do not establish safety.

## Code Review Rules

Flag duplicated business logic, concealed errors, unsupported dependency names, unlabelled simulated behavior, stale graph claims, cross-project state leakage, and UI changes that break keyboard or narrow-screen use. Cite the concrete file or behavior and its consequence.

## Scope and installation

These are instructions, not a mechanical guarantee of quality. Copy this file to your application's root and copy the accompanying `.agents/skills/` tree beside it. If the project already has an AGENTS.md, merge these rules into it; preserve its existing setup commands and policies.
