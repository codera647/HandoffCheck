# Vibles review context

## Establish what exists

Read the nearest AGENTS.md, actual implementation, and approved decisions. The current handoff under `Vibles-MVP-Handoff-v1.0/` is a specification, not execution evidence. When only documents or contract schemas exist, review design assumptions and gaps without claiming an implemented control failed or passed. Distinguish proposed controls, source-visible enforcement, and exercised behavior.

For the relevant boundary, consult the handoff's `docs/05-SYSTEM-ARCHITECTURE.md`, `06-WORKSPACE-AND-DATA.md`, `09-VERIFICATION-AND-REPAIR.md`, `10-API-AND-TOOL-CONTRACTS.md`, `11-INTEGRATIONS-AND-RELEASES.md`, and `12-SECURITY-THREAT-MODEL.md`, plus the matching contracts and T14-T25/T32 acceptance scenarios. Use newer approved decisions when those documents are superseded. Specifications identify intended invariants; source and bounded observations establish findings.

## Select boundaries from actual source

Use the ordinary attack classes together with only the companion classes whose boundaries exist in scope. Do not treat this table as evidence of coverage.

| Boundary | Vibles invariant to trace | Companion references |
| --- | --- | --- |
| Website to extension/helper | An opted-in origin, extension sender, project/tab binding, and native-host identity constrain messages. Generated page content cannot grant approval. Electron renderers have narrow IPC and no Node or provider credentials. | CLIENT-SIDE.md; DESKTOP-MOBILE-AND-LOCAL-IPC.md |
| Agent to checked tool/controller | Page/repository/model/MCP content cannot grant capabilities, write protected evidence, or issue provider mutations. Check handler authorization even when SDK callbacks are skipped. | AI-AND-LLM.md; PROTOCOLS-RPC-AND-MESSAGING.md |
| Owner to project/source/graph | Actor identity comes from validated credentials. Alternate read, cache, export, blob, graph, job, and deletion paths retain tenant/project scope. Graph provenance is bound to the reviewed source revision. | DATA-ISOLATION-AND-LIFECYCLE.md; CLOUD-AND-DEPLOYMENT.md |
| Import/build to local machine | Import inspection executes no scripts. Archive/path normalization rejects traversal, symlinks, drive/UNC paths, reserved names, and case collisions. Generated code has no host home, Docker socket, production data, or credential access. | ATTACK-CLASSES.md; CLOUD-AND-DEPLOYMENT.md; SUPPLY-CHAIN-AND-RELEASE.md |
| Editor/agent to revision/evidence | Manifest completeness precedes save acknowledgment. CAS and monotonic writer fences reject stale commits. Builders cannot weaken approved criteria, alter runner results, or promote mismatched candidates. | DATA-ISOLATION-AND-LIFECYCLE.md; AI-AND-LLM.md |
| Approval to provider executor | Approval binds exact revision, verification, configuration, target/account/team, expiry, and one-use consumption. Changed inputs invalidate approval. Unknown outcomes reconcile before retry. Saved, accepted, and live states remain distinct. | AI-AND-LLM.md; SUPPLY-CHAIN-AND-RELEASE.md; PROTOCOLS-RPC-AND-MESSAGING.md |
| Job to shared resources/spend | Atomic reservations precede work. Failed/cancelled calls settle usage; cancellation blocks new capabilities; queues, imports, indexing, and repairs remain bounded. Use local deterministic schedules and dummy prices, not real exhaustion. | RESOURCE-EXHAUSTION-AND-AVAILABILITY.md |

Keep secrets out of context, graphs, logs, screenshots, and reports. Refer to environment variable names and secret versions; use synthetic credentials and two dummy tenants for local isolation checks. Do not contact GitHub, Vercel, Anthropic, Supabase, or other live control planes as part of audit execution. Missing provider configuration belongs in an owner-observed validation plan.

## Runtime and delegation prerequisites

Map upstream `research` and `general` roles to available delegation tools. Respect the platform's concurrent-agent limit and sequence additional assignments as slots become available; concurrency limits do not justify dropping coverage or reusing the discovering agent as its own verifier. If delegation is unavailable, provide the focused guidance possible and mark a requested full audit incomplete rather than claiming independent verification.

On native Windows, the pinned upstream Node validators reject file inputs when `O_NOFOLLOW` and `O_NONBLOCK` are unavailable. Preserve that fail-closed behavior. Run the supplied CLIs in an already available compatible runtime, such as Linux/WSL with the required filesystem protections. Do not substitute an unchecked file read, weaken validators, or claim a complete validated report from in-memory checks alone. Linux/WSL availability by itself does not establish all target-code sandbox controls.

The Codex workspace sandbox is not automatically evidence of the upstream target-code isolation requirements. Verify network, environment, mounts, resources, and artifact promotion before executing target-controlled code. If a decisive check cannot run safely, retain its exact blocker. Request a permitted output path only when needed; do not escape filesystem permissions or silently write an audit into the target repository.

## Findings and fixes

Keep confirmed vulnerabilities, source-grounded needs-validation leads, rejected claims, and hardening notes separate. A missing graph edge or unimplemented proposed control alone is not a confirmed vulnerability. Never assign severity to needs-validation leads. Schema checks validate record structure; they do not certify the product.

An audit is read-only with respect to target source. If the user also requests fixes, perform the scoped implementation as a separate authorized step, preserve critical tests and policies, and revalidate affected findings against the new revision. Do not let the implementation role overwrite audit evidence or silently mark a finding resolved.
