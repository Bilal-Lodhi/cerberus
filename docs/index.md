# Documentation index

Entry point for everything under `docs/`. Every document in this directory is
listed here with the audience it is written for. If you add a document, add it
to this index in the same pull request.

New to the repository? Read `README.md` at the repository root first for what
Cerberus is and how to run it, then come back here for depth.

## Start here

| Document | Audience | What it covers |
| --- | --- | --- |
| [index.md](index.md) | Everyone | This file — the map of the documentation set. |
| [architecture.md](architecture.md) | Contributors, operators evaluating the design | Component map, telemetry and scenario data flows, the session state model, deduplication layers, the persistence model, trust boundaries, and the known gaps in this release. Written from the source, not from intent. |
| [configuration.md](configuration.md) | Operators, contributors | Every environment variable: type, default, whether it is required, and the security implications of changing it. Includes worked local-development and production examples. |
| [security/threat-model.md](security/threat-model.md) | Operators, security reviewers | Assets, actors, trust boundaries, what the single-key model does and does not protect against, CORS posture, fail-closed and fail-open behaviours, data-protection considerations, and §9 — the logging threat model: what request metadata is recorded, what is never recorded, and why structured logs are not a compliance claim. |
| [development/operability-model.md](development/operability-model.md) | Operators, contributors, anyone debugging a request | Every request path mapped against nine operability columns — auth, request id, logs, dependencies, durable writes, response status, stable error code, degraded behaviour, and the fields that must never be logged — plus the design for structured logging, request correlation, secret redaction and operational diagnostics. §10 records which parts are implemented. |
| [migration.md](migration.md) | Anyone with historical data or client code | The schema and data migration framework, and separately the historical → current MongoDB collection names, MCP tool names and field names. |
| [migration-v0.1-to-v0.2.md](migration-v0.1-to-v0.2.md) | Operators upgrading from `v0.1.0` | What changed between `v0.1.0` and `v0.2.0`, which two changes require action, and how to verify the upgrade. |
| [compatibility.md](compatibility.md) | Contributors, operators planning an upgrade | What counts as a public contract, the breaking-change and deprecation policies, versioning, supported runtimes, and the dependency and license policy with the current audit results. |
| [api-errors.md](api-errors.md) | Console and client authors, operators reading a log | Every stable client-facing error `code`, its HTTP status and the action a client can take; what is a contract and what is not; and what is deliberately not exposed. |
| [development/maturity-plan.md](development/maturity-plan.md) | Contributors, maintainers | Where the project is on its way from the `v0.1.0` research prototype to a credible self-hostable platform: completed milestones, the phase queue, accepted limitations and open decisions. |
| [development/session-state-model.md](development/session-state-model.md) | Contributors, operators reasoning about restarts | Every piece of session state, its class (durable authority, reconstructable cache, ephemeral, derived), where its authority actually lives, and what a restart does to it. Written from the source. |
| [development/state-transition-model.md](development/state-transition-model.md) | Contributors changing anything that touches a session's lifecycle | The enforced transition table, the five mutation paths it replaced and how they disagreed, the confirmed P1 that tracing them found, and what the central boundary owns. The historical record is kept because it is the specification the boundary was built to satisfy. |
| [development/read-model.md](development/read-model.md) | Contributors changing anything a session is read from | The four surfaces that answer for one session, the three vocabularies (lifecycle status, review disposition, liveness) that must not be conflated, the shared durable reader, what must agree and what deliberately differs, and the six read-integrity defects that tracing them found. |
| [development/multi-writer-model.md](development/multi-writer-model.md) | Contributors changing anything a session's state touches, operators running more than one replica | Every session concept classified as durable-authoritative, reconstructed, derived, ephemeral or process-local-authority, with the six multi-writer questions answered per field, the invariant the read paths owe, the four places the current implementation breaks it, and the enforcement status of each rule. |
| [development/live-read-consistency.md](development/live-read-consistency.md) | Contributors changing a read surface, operators reasoning about staleness | What **current** means on each surface, the freshness contract (durable current / bounded-stale / local best effort / absent), why there is deliberately no bounded-stale surface, how the live list and detail reconcile against durable truth, the one-directional cache repair, and the failure-injection matrix. |
| [development/console-smoke.md](development/console-smoke.md) | Contributors changing the console, maintainers running a browser pass | `npm run verify:console-smoke`: what the browser pass automates, what only a human can judge, which items are covered by machine-verifiable widget tests instead, and the two couplings the smoke found by failing. |
| [development/failure-semantics.md](development/failure-semantics.md) | Contributors changing a multi-step operation | What each multi-step operation guarantees when a step fails: DB-succeeds-cache-fails, cache-changes-DB-fails, provider-succeeds-persistence-fails, death between writes, lost response, failed notification, ambiguous retry. States the guarantees the system can honestly make, and the ones it cannot. |
| [development/test-double-contract.md](development/test-double-contract.md) | Contributors writing or trusting a test double | Every in-process stand-in for a real dependency, a contract matrix against `MongoStore`, the three divergences that let real defects through, and the plan for one shared faithful double plus a contract suite run against both it and a real MongoDB. |
| [development/architecture-integrity-checkpoint.md](development/architecture-integrity-checkpoint.md) | Contributors, maintainers, anyone assessing the project | The record of the architecture-integrity cycle: the merged changes, the twelve defects it found, the exit criteria with their state, the verification at the checkpoint, and what remains accepted. |
| [development/operability-checkpoint.md](development/operability-checkpoint.md) | Contributors, maintainers, anyone assessing the project | The record of the **operability, read-integrity and release-automation** cycle: the ten merged pull requests, the fourteen defects and how each was found, the exit criteria with their state, the verification at the checkpoint, the immutability proof for the published tags, and what remains accepted. |
| [development/performance-baseline.md](development/performance-baseline.md) | Contributors changing a hot path | How to reproduce the benchmark, the measured request-handling figures, and what it found — including one finding that was a benchmark artifact and is corrected in the document rather than deleted. |

## Operations (`docs/operations/`)

Running a self-hosted deployment: rotating credentials, probing health, backing up,
upgrading, and managing the reference corpus.

| Document | Audience | What it covers |
| --- | --- | --- |
| [operations/key-rotation.md](operations/key-rotation.md) | Operators | The four-step overlap procedure for `CERBERUS_API_KEY` and `CERBERUS_MCP_TOKEN`, why an overlap is used instead of a hard cutover, what Cerberus refuses to do, and what an overlap does not do. |
| [operations/reverse-proxy.md](operations/reverse-proxy.md) | Operators exposing Cerberus | What the proxy must own (TLS, per-caller limiting, unauthenticated throttling), why `X-Forwarded-For` is deliberately not trusted, a minimal nginx configuration, and what happens when you run more than one replica. |
| [operations/upgrade.md](operations/upgrade.md) | Operators upgrading a deployment | Back up, read the migration plan, apply, restart, confirm — plus what to do when a migration refuses to run, why there are no down-migrations, and why the MCP adapter starts before the API. |
| [operations/health-probes.md](operations/health-probes.md) | Operators, orchestrator config | Which of `/health` (liveness) and `/ready` (readiness) belongs in each probe slot and what goes wrong if they are swapped, what readiness reports, and why the probe is cached. |
| [operations/backup-restore.md](operations/backup-restore.md) | Operators responsible for data | The backup and restore scripts, what a manifest makes verifiable, why `mongorestore` exits 0 when it restores nothing, what is deliberately not backed up, and the gaps this does not close (no scheduling, no point-in-time recovery, no off-host storage, no encryption). |
| [operations/corpus-management.md](operations/corpus-management.md) | Operators, and anyone reading a similarity match | Why the reference corpus needed a console surface, what the panel does, what the corpus is **not** (not plagiarism detection, not complete coverage), and why the whole corpus is loaded per analysis. |

## Release preparation (`docs/release/`)

The `v0.1.0` documents are a historical record of that release. The `v0.2.0` and
`v0.3.0` notes are the notes published with each release, and the `v0.3.0`
checklist records the gates that were actually run for it — including the ones
that must be re-run rather than assumed.

| Document | Audience | What it covers |
| --- | --- | --- |
| [release/release-checklist.md](release/release-checklist.md) | Maintainers | The gates that were verified before `v0.1.0` was published, and the evidence recorded for each. |
| [release/verification-harness.md](release/verification-harness.md) | Maintainers | `npm run verify:release`: the seventeen steps it runs, how to run one on its own, why a skip is not a pass, why it can never publish, the attribution guard, the upgrade gate, the backup/restore drill, the stale-image defence, and what the version and config censuses found the first time they ran. |
| [release/v0.1.0-release-notes.md](release/v0.1.0-release-notes.md) | Everyone | The published `v0.1.0` release notes, including the limitations stated at publication. |
| [release/v0.2.0-release-notes.md](release/v0.2.0-release-notes.md) | Everyone | The published `v0.2.0` release notes: what it contained, its breaking changes, the upgrade path, and — stated plainly — what it does not claim. |
| [release/v0.2.0-checklist.md](release/v0.2.0-checklist.md) | Maintainers | **Executed.** The gates run for `v0.2.0`, with the result of each recorded. |
| [release/v0.3.0-release-notes.md](release/v0.3.0-release-notes.md) | Everyone | **Published 2026-09-26 as a GitHub pre-release.** The theme, the observable changes, the upgrade path and — stated plainly — what the release does not claim. |
| [release/v0.3.0-checklist.md](release/v0.3.0-checklist.md) | Maintainers | **Executed.** The gates worked through for `v0.3.0`, with the result of each recorded. |
| [release/v0.4.0-release-notes.md](release/v0.4.0-release-notes.md) | Everyone | **Published 2026-09-26 as a GitHub pre-release.** The theme (operability and read integrity), the observable changes, the upgrade path, and ten things the release does not claim. |
| [release/v0.4.0-checklist.md](release/v0.4.0-checklist.md) | Maintainers | **Executed.** The gates with the result of each, the attribution finding and its guard, and the publication steps. |
| [release/community-health-checklist.md](release/community-health-checklist.md) | Maintainers | The community-health files and repository settings applied for the public launch. |
| [release/repository-metadata.md](release/repository-metadata.md) | Maintainers | Repository description, topics and metadata drafts. |
| [release/good-first-issues.md](release/good-first-issues.md) | Maintainers, new contributors | The issue candidates collected during the extraction, with the triage outcome for each. Filed candidates link to their GitHub issues. |

## Related documents outside `docs/`

- [`README.md`](../README.md) — what Cerberus is, quick start, configuration table, security and privacy warning, roadmap.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — development environment, repository layout, coding conventions, pull-request expectations.
- [`SECURITY.md`](../SECURITY.md) — how to report a vulnerability privately.
- [`CHANGELOG.md`](../CHANGELOG.md) — release history, including the `[Unreleased]` section.
- [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) and [`SUPPORT.md`](../SUPPORT.md) — community expectations and where to ask for help.
- [`.env.example`](../.env.example) — the annotated canonical starting point for a local stack.
