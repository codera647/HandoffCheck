---
name: vibles-build-quality
description: Implement or review Vibles UI and application code without generic visual patterns, duplicated logic, architectural drift, or fabricated completion. Use for components, features, fixes, refactors, code reviews, and website-building tasks; ground changes in existing code, approved design, and verified behavior.
---

# Build intentional UI and maintainable code

## Ground the change

1. Read the nearest AGENTS.md and relevant source. Inspect the existing package manager, scripts, components, tests, design.md, brand-voice.md, and architecture decisions when present.
2. Identify the user outcome, acceptance behavior, constraints, and behavior to preserve. Keep this brief; do not produce a long plan for a tiny edit.
3. Search for the canonical implementation and related callers before creating new logic.
4. Ask for missing information that materially changes permissions, data, behavior, brand, or architecture. Use established conventions for reversible details.
5. Distinguish approved decisions from proposals. Do not silently turn this skill's preferences into product requirements.

## Design from the goal

- Choose hierarchy, layout, density, typography, color, and motion to support the actual user task.
- Preserve an established visual system. For a new surface, record a concise design rationale before implementation and choose tokens that can be reused.
- Do not default to purple gradients, glassmorphism, oversized rounded cards, floating blobs, endless card grids, or excessive hover animation. Use a treatment only when it serves the approved design.
- Use familiar patterns when they help usability. Do not force novelty or ban ordinary components.
- Give each surface a clear primary action. Remove decoration that competes with it.
- Keep meaningful contrast, visible focus, keyboard operation, semantic controls, accessible labels, responsive layouts, and reduced-motion support.
- Show accurate empty, loading, success, and error states. Avoid inert buttons presented as functional.
- Implement smooth focus/zoom transitions when requested; preserve legibility and pointer targeting. Honor reduced motion.

For Vibles companions, preserve the native cursor, keep the character small, open controls on demand, and avoid obstructing the user's work. Follow approved references rather than inventing a mascot or palette.

## Preserve code structure

- Reuse existing components, utilities, services, and schema types where their responsibilities match.
- Keep shared business rules canonical. Search beyond filename similarity before duplicating logic.
- Keep domain logic separate from rendering and provider adapters. Follow the project's existing boundaries.
- Choose an abstraction for a demonstrated responsibility; do not create generic factories or managers for speculative future features.
- Keep functions and components cohesive. Do not split them solely to meet an arbitrary line limit.
- Use meaningful names, explicit types at boundaries, deliberate error handling, and comments that explain constraints or decisions.
- Avoid broad casts, suppression directives, silent catch blocks, retry loops without limits, and wrappers added only to conceal a broken contract.
- Preserve public contracts unless the task changes them; update affected callers and checks together.
- Remove temporary scaffolding introduced by the task. Do not sweep unrelated code into a cleanup.
- Verify package existence and suitability against its actual registry/documentation before adding it. Keep the lockfile synchronized; avoid new dependencies when existing tools suffice.

## Respect architectural evidence

Use the project graph, when available, to identify implementations, dependencies, and likely impact. Check its source revision and coverage. Treat extracted, observed, inferred, and approved relationships differently.

Fall back to source inspection when the graph is stale, partial, or unresolved. Never treat the absence of an edge as proof of independence. Keep approved architecture rules separate from the graph of current code.

For concurrent companions, keep project and revision identities explicit. Use the approved writer/acceptance protocol; do not let one task silently overwrite another's work.

## Verify actual behavior

- Discover the real checks from project scripts or instructions; do not invent a command or silently create a replacement test framework.
- Run the checks relevant to changed behavior. For UI, inspect the actual result when a suitable browser is available, including narrow-screen and keyboard behavior.
- Verify integration boundaries with representative success and failure cases. Label stubs and demo fixtures.
- Add a regression check when a meaningful bug or risky behavior change warrants it. Avoid implementation-mirroring tests for trivial edits.
- Keep established critical tests intact. Do not remove assertions, weaken expected results, skip failing tests, or edit policy merely to get a green result.
- Change a test expectation only when behavior legitimately changes; explain why and verify the new requirement.
- Inspect the final diff for accidental files, leaked secrets, duplicate logic, unrelated changes, and unfinished TODOs.
- Distinguish passed, failed, and not-run checks. Do not report a backend action, deployment, security review, or test as successful without corresponding evidence.

Read [review.md](references/review.md) before delivery. Fix concrete failures within scope and report remaining limitations plainly.

## Deliver

Summarize the resulting behavior, important design/architecture decisions, validation, and remaining limits. Do not promise "zero slop", complete security, or exhaustive graph coverage.

This engineering workflow is an original Vibles extension. The upstream no-ai-slop repository supplies writing guidance, not code-quality or UI-validation guarantees.
