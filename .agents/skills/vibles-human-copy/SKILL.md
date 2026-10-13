---
name: vibles-human-copy
description: Write or edit Vibles product copy, UI messages, landing pages, documentation, release notes, and PR descriptions in natural, specific language. Use for writing-quality reviews and requests to remove AI-sounding copy; preserve the author's voice and factual meaning.
---

# Write human product copy

## Establish the job

Read the complete relevant draft or interface before editing. Identify the audience, the action the reader needs to take, the facts available, and the voice to preserve. Read the project's actual brand-voice.md when present.

For new copy, derive claims from implemented behavior or approved requirements. Ask for a missing fact when it changes the claim or user action. Use a neutral, factual default for reversible wording choices.

## Preserve meaning and voice

- Make the minimum effective edit. Leave clear, distinctive sentences alone.
- Preserve useful vocabulary, cadence, humor, bluntness, and honest uncertainty.
- Use concrete verbs and details. Keep technical precision and necessary domain terms.
- Keep useful longer sentences and fragments when they belong to the voice.
- Apply the portability test: replace a generic sentence that could describe any product with a supported mechanism, consequence, or action.
- Do not invent numbers, customer logos, testimonials, certifications, comparative superiority, or security guarantees.
- Do not change code identifiers, quoted material, API names, filenames, or legal wording merely to satisfy a style preference.

## Remove empty patterns

| Pattern | Action |
| --- | --- |
| Binary contrast: "This isn't X. It's Y." | State the actual claim directly. Keep a comparison when it explains a real choice. |
| Throat-clearing: "Here's the thing" | Start with the point. |
| Faux insight: "What nobody tells you" | Give the fact or reasoning without the setup. |
| Dramatic colon reveals | Use a plain sentence; keep colons for useful labels and lists. |
| Puffery: "a pivotal moment" | Describe the concrete change. |
| Empty analysis: "highlighting our commitment" | Explain the actual user consequence. |
| Weasel sourcing: "studies show" | Name an available source or remove the unsupported claim. |
| Synonym cycling | Use a consistent name for the same actor or feature. |
| Stacked fragments and repeated paragraph shapes | Restore natural progression without imposing uniform rhythm. |
| Fake-profound endings and repeated summaries | End on the final useful fact or action. |

Replace empty uses of "delve", "leverage", "empower", "streamline", "cutting-edge", "game-changing", "seamless", "robust", and "transformative" with precise wording. Do not run a blind word ban over technical source or distinctive human writing.

Use headings and lists for real structure. Avoid emoji headings, decorative emphasis, and excessive em dashes unless an approved voice calls for them.

## Write accurate interface states

- Name what the user can do: "Review changes", "Connect GitHub", "Deploy preview".
- Distinguish queued, working, blocked, verified, accepted, and deployed.
- Explain an error and a useful next action without claiming recovery succeeded.
- Ask one decision at a time in small permission or design windows.
- Avoid exposing internal model, graph, or orchestration details unless they help the user decide.
- Describe demo actions as simulated when they are simulated.

## Audit and return

Read [eval.md](references/eval.md), fix failures, and repeat the relevant checks.

For a detect-only request, quote the concrete pattern and suggest a brief fix. Do not rewrite the draft or infer whether AI authored it.

For a standalone edit, return the complete edited text and a short change note when useful. For a repository task, edit the actual file and summarize the change in the response; do not insert an editing report into the product UI.

## Attribution

Adapted from Peter Yang's no-ai-slop writing skill. Read [upstream.md](references/upstream.md) for the pinned source and distinction between upstream writing guidance and Vibles additions. Retain [LICENSE.md](references/LICENSE.md) when copying this adaptation.
