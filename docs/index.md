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
| [security/threat-model.md](security/threat-model.md) | Operators, security reviewers | Assets, actors, trust boundaries, what the single-key model does and does not protect against, CORS posture, fail-closed and fail-open behaviours, and data-protection considerations. |
| [migration.md](migration.md) | Anyone with historical data or client code | Historical → current MongoDB collection names, MCP tool names and field names, plus what a one-off rename has to touch. Cerberus ships no migration tooling. |
| [compatibility.md](compatibility.md) | Contributors, operators planning an upgrade | What counts as a public contract, the breaking-change and deprecation policies, versioning, supported runtimes, and the dependency and license policy with the current audit results. |
| [development/maturity-plan.md](development/maturity-plan.md) | Contributors, maintainers | Where the project is on its way from the `v0.1.0` research prototype to a credible self-hostable platform: completed milestones, the active queue, accepted limitations and open decisions. |
| [development/session-state-model.md](development/session-state-model.md) | Contributors, operators reasoning about restarts | Every piece of session state, its class (durable authority, reconstructable cache, ephemeral, derived), where its authority actually lives, and what a restart does to it. Written from the source. |

## Release preparation (`docs/release/`)

These describe how `v0.1.0` was prepared and published. They are a historical
record of that release, not instructions for a future one.

| Document | Audience | What it covers |
| --- | --- | --- |
| [release/release-checklist.md](release/release-checklist.md) | Maintainers | The gates that were verified before `v0.1.0` was published, and the evidence recorded for each. |
| [release/v0.1.0-release-notes.md](release/v0.1.0-release-notes.md) | Everyone | The published `v0.1.0` release notes, including the limitations stated at publication. |
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
