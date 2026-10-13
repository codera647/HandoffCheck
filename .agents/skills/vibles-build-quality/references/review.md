# Implementation review

Evaluate the actual diff and available execution evidence.

| Area | Question |
| --- | --- |
| Outcome | Does the change implement the requested behavior rather than a nearby generic feature? |
| Preservation | Do important existing workflows still work? |
| Reuse | Does existing logic already cover a newly introduced responsibility? |
| Boundaries | Are rendering, domain logic, data, and provider access kept in their established layers? |
| Dependencies | Are newly added packages real, necessary, and locked consistently? |
| UI | Do layout, tokens, density, and motion follow the approved design and user task? |
| Interaction | Do controls work, or are demo limitations clearly labelled? |
| Accessibility | Are focus, keyboard use, labels, contrast, reduced motion, and narrow layouts handled? |
| Evidence | Are graph conclusions revision-scoped, uncertain relationships explicit, and tests preserved? |
| Completion | Are claims supported, failed checks visible, and temporary scaffolding removed? |

Treat complexity, duplication, and aesthetic findings as concrete review observations. Cite the relevant file or behavior. Do not use an arbitrary score or "looks AI-generated" as a substitute for evidence.
