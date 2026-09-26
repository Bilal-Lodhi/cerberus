# Maturity plan

Where Cerberus is on the path from the `v0.1.0` research prototype to a
credible, self-hostable platform that a third party can clone, understand, run
and evaluate without the original author present.

This is a living document. It records what is done, what is being worked on
next, what is accepted as a limitation, and what needs a maintainer decision.
It is deliberately not a roadmap of features.

Status labels used below:

- **Implemented** — in `main`, tested, and documented as current behaviour.
- **Experimental** — in `main`, works, but the semantics may still change.
- **Planned** — not in `main`. Do not document it as if it were.
- **Accepted limitation** — will not be fixed for now, with a reason.
- **Needs decision** — cannot proceed safely without a maintainer choice.

Last updated at the **architecture-integrity checkpoint**. The full record is in
[architecture-integrity-checkpoint.md](architecture-integrity-checkpoint.md).

## Current state

`v0.1.0` is published as a pre-release and its tag is immutable. `main` is
post-release work. The repository is a public, Apache-2.0, single-tenant,
self-hosted system.

Verified at the start of this work cycle, from a clean checkout on
`628f0933777d7aa38c5b6e7f9d4c59e57756037d`:

| Gate | Result |
| --- | --- |
| `npm ci` | clean, 0 vulnerabilities |
| `npm run build` | clean |
| `npm run typecheck` | clean |
| `npm test` | 161 tests, 0 failures |
| `flutter pub get` / `flutter analyze` | clean |
| `flutter test` | 2 tests, 0 failures |
| `dart format --output=none --set-exit-if-changed .` | clean, 24 files unchanged |
| `flutter build web --release` | succeeds, writes `apps/console/build/web` |
| `docker build` + Compose startup + fail-closed startup | covered by CI |

And at the maturity checkpoint, on `6d0e0a7`:

| Gate | Result |
| --- | --- |
| `npm ci` | clean, 0 vulnerabilities |
| `npm run build` / `npm run typecheck` | clean |
| `npm test` | API 319 tests, MCP 10 tests, 0 failures, 0 cancelled |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `flutter analyze` / `flutter test` / `dart format` | clean; 22 tests pass |
| Documentation links and heading anchors | 66 file links, 15 anchors, 0 broken |
| `docs/` index coverage | 12 files, 0 unlinked |
| Configuration census | every variable in `.env.example` is read by code |
| `v0.1.0` tag | still an annotated tag on `ef98f962…`, unmodified |

## Maturity checkpoint

Every item in the target set below is either implemented or recorded as an
accepted limitation with a reason. The four original issues are closed, no known
P0 security or correctness defect remains, and the audit findings raised during
this cycle are all remediated.

| Target | State |
| --- | --- |
| Repository layout, docs entry point, architecture/config docs match code | Done |
| Build, typecheck, tests, format, Docker, Compose, fail-closed startup | Done, gated in CI |
| Configuration honesty — every documented variable is implemented, deprecated or removed | Done; census verified |
| Session TTL resolved | Done — computed liveness, evidence preserved |
| Restart and recovery invariants tested | Done |
| Similarity threshold real | Done — local deterministic matcher over an operator-managed corpus |
| `severityMix` is real structured data | Done |
| CI robust across event modes; cannot pass security scans vacuously | Done |
| Threat model reflects current code | Done |
| Dependency and license audit current | Done; recorded in [compatibility.md](../compatibility.md) |
| Public API breakage policy documented | Done; [compatibility.md](../compatibility.md) |
| Backlog is bounded future work, not correctness debt | Done — one open decision, below |

**That checkpoint is complete.** The one item it left open — `CODEOWNERS` — was
decided by the maintainer; see [Owner decisions](#owner-decisions). Nothing on
the checkpoint list is unresolved.

## Current phase: operational durability

The checkpoint produced software with strong correctness and security boundaries.
What it did not produce is software that survives a restart predictably, bounds
abuse of its expensive paths, or can be upgraded by someone who did not write it.
This phase closes that gap.

**Goal.** Advance Cerberus to operationally credible self-hosted research
software: core state survives restart predictably, the request surface has
bounded abuse controls, the upgrade path is understandable, and behaviour under
degraded dependencies is explicitly tested.

**Explicitly out of scope.** New surveillance scope, an endpoint agent, accounts
or RBAC, tenancy, a second AI provider, public deployment, and publishing a
release.

**Exit condition.** All of the following true, or explicitly rejected with a
strong engineering rationale recorded here:

| # | Criterion | State |
| --- | --- | --- |
| A | Durable session truth materially improved | Done — counters hydrate across a restart and are monotonic at the storage layer; review ordering and evidence recovery fixed. The central transition path and partial-failure semantics remain, tracked in the session-state model |
| B | Restart recovery deterministic and documented | Done — [session-state-model.md](session-state-model.md) documents every field; restart behaviour is covered by tests and verified against a real process restart |
| C | Rate limiting exists for expensive and high-risk paths | Done — in-process token buckets per route category, applied after auth; the AI ceiling is configurable; per-caller limiting documented as a proxy concern in [operations/reverse-proxy.md](../operations/reverse-proxy.md) |
| D | Replay handling explicit and tested | Done — durable `(sessionId, eventId)` identity; the store reports what was new and only that is applied. Content dedup scoped to content-bearing events. What this is *not* is stated in the threat model |
| E | API-key rotation has a safe documented path | Done — `CERBERUS_API_KEY_PREVIOUS` and `CERBERUS_MCP_TOKEN_PREVIOUS` overlap, both compared without short-circuiting, with the procedure in [operations/key-rotation.md](../operations/key-rotation.md) |
| F | Schema and data migration strategy exists and is testable | Done — an ordered, idempotent, fail-before-mutating runner with a ledger, a dry-run CLI, and one real migration that repairs the duplicate identities the pre-fix ingestion path created. [operations/upgrade.md](../operations/upgrade.md) documents the procedure |
| G | Local performance baseline exists | Done — [performance-baseline.md](performance-baseline.md) with `npm run bench`, measured p50/p95/p99 per case. Its first finding (a quadratic ingest cost) was a benchmark artifact and is corrected in the document; its real finding — unbounded in-memory session state — is fixed and proved by a length assertion |
| H | Health and readiness semantics are coherent | Done — `/health` is liveness and checks nothing; `/ready` checks persistence and answers 503. The MCP adapter exposes the same pair, and the Dockerfile and compose probe `/ready`. [operations/health-probes.md](../operations/health-probes.md) records which belongs in each slot |
| I | Backup, restore and upgrade documentation exists | Done — [operations/backup-restore.md](../operations/backup-restore.md) with two verified scripts (the restore compares counts against a manifest), and [operations/upgrade.md](../operations/upgrade.md) for the migration procedure. The drill was run end to end against real MongoDB |
| J | Corpus-management workflow usable without hand-writing raw HTTP | Done — a dashboard panel lists, adds and removes corpus documents and validates against the API's limits before sending. The assessment, and what the corpus is *not*, are in [operations/corpus-management.md](../operations/corpus-management.md) |
| K | No new P0/P1 correctness or security defects remain | Done — six real defects were found and fixed during the phase (see below). The known remaining items are all P2 or lower, and each is named rather than omitted |
| L | CI stays green | Done — every required check passed on every pull request in this phase: TypeScript (build, typecheck, test), Flutter console (analyze, test), Docker build, Secret scan, and the advisory dependency audit |
| M | Threat model and documentation match reality | Done — the threat model was rewritten where reality changed (retry idempotency is not replay protection; rate limiting is a per-process backstop; rotation has an overlap but still no key identity), and every relative link and anchor in every tracked `*.md` resolves |
| N | A coherent `v0.2.0` release candidate can be described without hand-waving | Done — [release/v0.2.0-release-notes.md](../release/v0.2.0-release-notes.md) and [release/v0.2.0-checklist.md](../release/v0.2.0-checklist.md), both since published, plus [migration-v0.1-to-v0.2.md](../migration-v0.1-to-v0.2.md) |

### Defects found and fixed during this phase

Recorded here because criterion K is a claim about defects, and a claim without the
list is not checkable. Four of these were invisible to the 319-test suite that existed
at the start, for the same reason each time: **a test double that did not match the
real store.**

| Defect | Severity | How it was found |
| --- | --- | --- |
| A restart reset a session's durable counters — 40 events and 20 pastes came back as 1 and 1 | P0 | The session-state inventory |
| A batch retried after a restart was stored and counted twice | P0 | The session-state inventory |
| The session review reported the **oldest** risk assessment as `finalRiskScore`, and derived `flagged` from it | P0 | The inventory; a stub that returned assessments in insertion order while MongoDB sorts newest-first |
| Content dedup applied to signal events, silently dropping legitimate telemetry | P1 | A test asserting two distinct `eventId`s with identical payloads are both accepted |
| `fullscreenExitCount` was never persisted, so a restart reset it and disabled both its analysis trigger and its score penalty | P1 | The inventory |
| `session.events` and `session.keystrokeDeltas` were unbounded, and `Math.max(...deltas)` threw `RangeError` past ~100 000 entries | P1 | The performance baseline |

Two further defects were found in tooling rather than product code: `verify-all.ps1`
could not run in its documented dev-mode form, and the backup script's `docker cp`
nested the dump one level too deep.

**One reported defect was withdrawn.** The performance baseline's headline finding — a
quadratic ingest cost — was an artifact of the benchmark's own stub, and is corrected
in the document rather than deleted. See
[performance-baseline.md](performance-baseline.md#the-stubs-must-match-the-real-stores-bounds).

### Known remaining items, all P2 or lower

| Item | Why it is not P1 |
| --- | --- |
| No central session transition path; status can still diverge between the two in-memory maps and MongoDB | A design gap, not a defect that manifests in the tested paths. Recorded in the session-state model |
| No partial-failure semantics for a persistence-succeeds-cache-fails operation | Same |
| The 200-document corpus ceiling is a read ceiling, not a store rejection — a 201st document is stored and then invisible | A rough edge, documented; the console prevents reaching it |
| `update_session_terminal_content` is a published MCP capability the API never calls | Not dead code — the MCP server is a public interface — but the API does not use it, and the review path recovers the workspace from the newest assessment's `codeSnapshot` |
| `WINDOW_BLUR` increments the fullscreen-exit counter, so the counter means "focus was lost" | Renaming it changes scoring and console wording; a contract change, not a defect |
| Ingest carries up to 500 events from the review fetch on every request | **Fixed** — `get_session_review` gained optional `eventsLimit` / `includeAssessments` arguments, and ingest passes `0` / `false` because it consults only the session document. The list path's per-session fetch is measured and reduced under exit criterion G |

Work is ordered P0 first: durable session truth and restart consistency, replay
and idempotency, key rotation, rate limiting, migration safety. Then P1:
health and readiness, degraded-mode behaviour, backup/restore/upgrade docs,
performance baseline, corpus-management usability. P2 — observability,
contributor tooling, console consistency, documentation cleanup — is last.

## Completed milestones

### v0.1.0 — independent extraction

Implemented and published:

- Extraction from the historical `Google-Cloud-Hackathon` repository into an
  npm-workspaces monorepo (`apps/api`, `apps/console`, `packages/mcp-mongodb`).
- Cerberus-native MongoDB collection names, MCP tool names and domain types.
- A single AI boundary (`OpenAIProvider`), replacing the historical Gemini
  client.
- Constant-time API-key authentication, an explicit CORS allow-list, and
  fail-closed configuration validation.
- Defensive structured-output parsers with fixture-based tests, so no CI job
  needs a paid AI call or a live database.
- GitHub Actions CI covering TypeScript build/typecheck/test, Flutter
  analyze/test, Docker build with a positive health probe and a negative
  fail-closed probe, and a secret scan that cannot pass vacuously.

### Post-release documentation debt

- **Issue #1** — a `docs/` index now exists (`docs/index.md`) and `README.md`
  links it. **Implemented.**
- **Issue #2** — the console web build output directory is documented in
  `README.md` and `CONTRIBUTING.md`, and the documented command was verified to
  write `apps/console/build/web`. **Implemented.**

### Configuration honesty and session lifetime

- **Issue #3** — `SESSION_TTL_SECONDS` is enforced. **Implemented.**
  The setting was parsed into `SecurityConfig.sessionTTLSeconds` and read by
  nothing, so a session lived until it was terminated or deleted regardless of
  the documented value.
  - Expiry is interpreted in exactly one place,
    `apps/api/src/services/session-liveness.ts`, and consulted by both the
    guardian and the review routers. It is **computed on every read, not
    persisted**: no `expired` status, no TTL index and no background sweep.
  - The TTL bounds **active-liveness, not evidence retention**. An expired
    session leaves the live list, is not restored as live by a restart, and
    refuses new telemetry with `409 SESSION_EXPIRED` — but every document is
    retained and the review endpoints still serve it, each entry carrying a
    derived `liveness` field.
  - A monitoring window cannot be extended as a side effect of emitting events.
    Reopening one is explicit:
    `POST /api/v1/guardian/sessions/:sessionId/reactivate`. A `terminated`
    session cannot be reactivated.
  - Activity is measured only from server-generated timestamps. The
    client-supplied `MicroEvent.timestamp` is not an expiry input, and a
    deduplicated replay does not refresh the activity stamp, so neither a forged
    future timestamp nor a replayed batch can hold a session open.
  - A misconfigured value fails closed: `SESSION_TTL_SECONDS` must be a positive
    whole number of seconds or the process exits with a `ConfigError`.
  - Tests use an injected manual clock, so the boundary is asserted exactly and
    nothing sleeps.

### Console / API contract coherence

- **Issue #4** — the console now sends a structured `severityMix`. **Implemented.**
  The scenario panel exposed three risk-distribution sliders whose values were
  interpolated into the prompt text, while the request body carried only
  `prompt`, `roleContext` and `vectorCount`. The API already accepted and
  normalised a `severityMix` object, so the sliders were a UI control whose value
  never reached the contract that was supposed to consume it.
  - The slider → severity mapping lives in exactly one place,
    `apps/console/lib/models/severity_mix.dart`: `routine → low`,
    `elevated → medium`, and the third slider is a budget split
    `60% high / 40% critical` by named constants.
  - The third slider is labelled **"Severe"**, not "Critical", and the panel
    prints the resulting four percentages beneath the sliders. Only 40% of that
    budget becomes `critical`, so calling the whole slider "Critical" would have
    misdescribed what the operator was choosing.
  - The distribution is no longer folded into the prompt as prose. The server
    states it to the model from the structured numbers, so there is one source of
    truth rather than two that could disagree.
  - The client normalises to sum 1.0 using the same rules as the server, so the
    server never silently reinterprets what was sent. Non-finite and negative
    slider values cannot put `NaN` into the request body.
  - `ApiService` now accepts an injectable `http.Client`, so the generated request
    body is asserted directly rather than inferred.

## Active work

The operational-durability phase. Work is selected from the phase exit condition
above, P0 before P1 before P2, one coherent change per pull request.

The queue is not a checklist to be cleared for its own sake: each item is either
delivered, or rejected here with the engineering rationale for rejecting it.

## Phase queue — every item complete

Ordered by the value of the outcome, not by effort. All nine are done; each entry
records what actually landed rather than what was intended.

1. **Durable session truth and restart consistency.** Done. Every in-memory session
   field is inventoried and classified in
   [session-state-model.md](session-state-model.md); counters hydrate from the durable
   document and are monotonic at the storage layer; a restart no longer resets them,
   verified across a real process restart. The central transition path and
   partial-failure semantics remain open and are recorded there.
2. **Replay and idempotency.** Done. A unique `(sessionId, eventId)` identity in
   `micro_events`; the store reports what was newly inserted and only that is applied,
   so a retry after a restart is stored and counted once. Content dedup is scoped to
   content-bearing events. What this is *not* — replay protection against a hostile
   client — is stated in the threat model.
3. **API-key rotation.** Done. `CERBERUS_API_KEY_PREVIOUS` and
   `CERBERUS_MCP_TOKEN_PREVIOUS`, both compared without short-circuiting, with the
   procedure in [operations/key-rotation.md](../operations/key-rotation.md).
4. **Rate limiting.** Done. In-process token buckets per route category, applied
   after authentication; the AI ceiling is configurable; per-caller limiting is
   documented as a proxy concern in
   [operations/reverse-proxy.md](../operations/reverse-proxy.md).
5. **Migration tooling.** Done. An ordered, append-only, idempotent runner that fails
   before mutating, with a ledger and a dry-run CLI. The first migration repairs the
   duplicate event identities the pre-fix ingestion path created — without it, such a
   database cannot start.
6. **Health and readiness.** Done. `/health` is liveness and checks nothing; `/ready`
   checks persistence and answers 503. The MCP adapter exposes the same pair.
7. **Backup, restore and upgrade documentation.** Done, with the drill run end to end
   against real MongoDB. The restore compares counts against a manifest, because
   `mongorestore` exits 0 when it restores nothing.
8. **Performance baseline.** Done. `npm run bench` with measured p50/p95/p99 per
   case. Its first finding was a benchmark artifact and is corrected in the document;
   its real finding — unbounded in-memory session state — is fixed.
9. **Corpus-management usability.** Done. The console gained a reference-corpus
   panel; the assessment and the reasoning are in
   [operations/corpus-management.md](../operations/corpus-management.md).

## Completed: the P0 audit pass

A route-by-route pass over auth, CORS, body limits, the provider boundary,
MongoDB query construction, session lifecycle, telemetry validation, the auditor
whitelist, notifications and the console. Every finding is remediated; none is
open.

- The API had **no request body size limit at all** — `@hono/node-server` exposes
  no `bodyLimit` option and none was configured, so every route read whatever the
  caller sent. Hono's built-in `body-limit` middleware now refuses anything above
  `CERBERUS_MAX_BODY_BYTES` (default 8 MiB) with `413 PAYLOAD_TOO_LARGE`, before
  the auth middleware, so it applies to authenticated and unauthenticated callers
  alike. No new dependency.
- Fields that reach a paid provider were unbounded. `prompt` (8 000 chars),
  `roleContext` (200), `question` (2 000) and telemetry batches (1 000 events) are
  now capped before any inference or persistence happens.
- The auditor passed whatever the model's pipeline produced to the summariser,
  with no ceiling. It is now truncated to 200 records regardless of `$limit`.
- `POST /api/v1/identity/set` cast a field to a string and called `.trim()` on it,
  so a numeric `displayName` threw inside the handler and surfaced as an unhandled
  500. It now returns `400 INVALID_IDENTITY_FIELD`, and identity fields are
  length-capped.
- Model-supplied numerics were **not clamped**. `parseRiskAssessment` accepted any
  finite number for `overallRiskScore`, `dimensionScores.*` and
  `flags[].confidence`, and `guardian.ts` only capped the blended score at the
  top, so a well-formed `-1e9` or `1e9` flowed through and would have corrupted
  threshold comparisons, sorting and the auto-lock. Every documented range is now
  clamped at the parser boundary, arrays and strings are bounded, and
  `exfiltrationReport` / `behavioralAnomalies` are parsed field by field instead of
  cast. Non-object array entries are dropped rather than becoming fieldless
  records. See
  [architecture.md](../architecture.md#6-score-composition-and-model-output-bounds).
- Outbound notifications had **no timeout**. `notifySlack` and `sendEmail` called
  `fetch` with no deadline, and ingestion awaits both before returning, so a hung
  webhook stalled the ingest request for as long as the socket stayed open — the
  notification path could block telemetry collection. Both now carry a 5 000 ms
  deadline, verified against a real server that accepts and never answers. The
  first implementation used `AbortSignal.timeout()`, whose timer is **unref'd**:
  CI caught that a deadline which is the only pending work never fires. It is now
  an explicit `AbortController` driven by a ref'd `setTimeout`.
- The identity registry was an unbounded in-memory `Map`. Every
  `POST /api/v1/identity/set` added an entry that was never evicted, while the
  `GET /me` handler already described an unknown handle as "unknown or expired"
  although nothing expired it. Handles now expire after 12 hours and the registry
  evicts expired entries, then the oldest, at a ceiling of 100.
- `OpenAIProvider.isFatal()` decided fatality by substring-matching the error
  message for `"401"` / `"403"`. Any error whose text happened to contain those
  digits — a token count, a request id, a URL — was treated as an authentication
  failure and skipped the retry budget. It is now classified from the SDK error's
  HTTP status and machine-readable `code`.
- `toMongoPipeline` used a raw `JSON.parse`, so a pipeline the model wrapped in a
  markdown fence or a sentence was discarded even though the rest of the boundary
  exists to tolerate exactly that. It now uses the same recovery ladder as every
  other model-reading path.
- The MCP adapter's `parseBody` destroyed an oversized request without resolving
  its promise, so the handler hung and the client saw a connection reset instead
  of a status; and a malformed body was indistinguishable from a missing one,
  surfacing as a misleading "Missing required parameter". The parser is extracted
  into `packages/mcp-mongodb/src/body.ts`, always settles, and returns
  `413 PAYLOAD_TOO_LARGE`, `400 INVALID_JSON` or `400 INVALID_BODY` explicitly.
  The adapter reads the same `CERBERUS_MAX_BODY_BYTES` variable as the API so the
  two ceilings cannot drift. Verified against a real MongoDB and a real socket.
- The MCP package had **no tests at all**. It now has a suite, and the root
  `npm test` runs it alongside the API's.

## Completed: the exfiltration similarity threshold

`DATA_LEAKAGE_SIMILARITY_THRESHOLD` was documented as a similarity threshold and
gated nothing: the reference source was a stub returning `[]`, so
`ExfiltrationReport` matches were always empty. The similarity numbers that did
appear came from the model, which never sees the threshold.

- The corpus is a local, operator-managed MongoDB collection
  (`reference_documents`) managed through `POST`/`GET`/`DELETE
  /api/v1/reference-documents`. **Cerberus never writes to it itself** — there is
  no crawler, no bundled corpus and no third-party content.
- Similarity is computed **locally and deterministically**
  (`apps/api/src/services/text-similarity.ts`: normalise → 3-token shingles →
  Jaccard). The model's `exfiltrationReport` is replaced rather than merged,
  because only the local comparison is reproducible from inputs an operator can
  inspect — and because the model never sees the threshold.
- The threshold is the gate: pairs at or above it become `ExfiltrationMatch`
  entries; pairs below it do not, though the best score is still reported so an
  operator can see how close a paste came.
- `aiCompletionLikelihood` is always `0`: Cerberus does not attempt to determine
  whether content was machine-generated, and a guess there would present an
  unfounded number as a measurement.
- Texts under 10 tokens are not compared at all, so two short strings cannot match
  by accident. The threshold itself is validated fail-closed to 0-1: a value above
  1 could never be reached and would silently disable the matcher.
- Verified through the full stack against real MongoDB and a stubbed provider: a
  near-copy paste produced a match at 0.854 with the corpus label, a half-overlap
  paste produced none at 0.474, and the provider's deliberately fabricated match
  was discarded.

## Known gaps in this release

These are already documented as limitations in
[architecture.md](../architecture.md#9-known-gaps-in-this-release) and
[security/threat-model.md](../security/threat-model.md). They are repeated here
so the maturity picture is in one place.

| Gap | Status | Note |
| --- | --- | --- |
| `SESSION_TTL_SECONDS` enforcement | Implemented | Issue #3. Expiry bounds liveness only; historical documents are retained. |
| Request body size limit | Implemented | `CERBERUS_MAX_BODY_BYTES`, default 8 MiB, enforced before buffering on both the API and the MCP adapter. |
| Model-output numeric bounds | Implemented | Every documented range is clamped at the parser boundary; arrays, strings and recursion depth are bounded. |
| Exfiltration similarity matching | Implemented | Local deterministic comparison against an operator-managed corpus, gated by `DATA_LEAKAGE_SIMILARITY_THRESHOLD`. |
| Session state is not fully durable | Accepted limitation | MongoDB is the durable authority for counters, lifecycle and identity, and those survive a restart. The in-memory event window, the reconstructed workspace, `lastAnalyzedCodeHash` and the dedup fingerprint ring are not persisted and are rebuilt on read. See [session-state-model.md](session-state-model.md). |
| No endpoint agent | Accepted limitation | All telemetry originates from the browser console. Building one is a scope decision, not an engineering task. |
| Single shared API key, no per-user attribution | Accepted limitation | Accounts, roles, OAuth/SSO and multi-tenancy are explicitly out of scope for the OSS baseline. |
| Rate limiting is a per-process backstop; no replay protection beyond TLS; no automated key rotation | Accepted limitation | Rate limiting deliberately does not limit unauthenticated requests, and N replicas enforce up to N times the limit. Telemetry has retry idempotency, not replay protection — the client supplies the key. Rotation has an overlap but no identity or revocation list. Documented in the threat model. |
| Console API key is embedded in the built web bundle | Accepted limitation | A consequence of `--dart-define` at build time. Mitigation is to serve the console only to trusted operators or front it with a credential-injecting proxy. |
| No script for the historical schema rename | Accepted limitation | The mapping is documented in [migration.md](../migration.md). Cerberus does ship a schema and data migration framework, but it does not rewrite historical names. |
| No backup automation | Accepted limitation | Backup and restore scripts exist and are verified, but nothing schedules them, stores them off-host, or provides point-in-time recovery. See [operations/backup-restore.md](../operations/backup-restore.md). |
| Session status vocabulary is narrower in the durable store than in the review contract | Accepted limitation | Only `active`, `locked` and `terminated` are persisted; `flagged` and `investigating` are derived at read time. |
| No central session transition path; no partial-failure semantics | **Active work** | Status is still written by five paths that order their cache and durable writes three different ways, and one of them can move a terminated session to `locked`. No longer an accepted limitation: this is the current phase's first objective. Modelled in [state-transition-model.md](state-transition-model.md) and [failure-semantics.md](failure-semantics.md). |
| No `CODEOWNERS` file | Decided | Recorded: not used while Cerberus is single-maintainer. See [CONTRIBUTING.md](../../CONTRIBUTING.md#maintainership-and-review). |

## Owner decisions

These were decided by the maintainer and are **not open questions**. Do not
re-raise them.

1. **`CODEOWNERS` — not used while Cerberus is single-maintainer.** Adding one
   now would route no review to anyone who is not already the author of every
   change, and every handle in it would have to be a real owner. Recorded in
   [CONTRIBUTING.md](../../CONTRIBUTING.md#maintainership-and-review), with the
   condition for revisiting it: a second real owner relationship.

2. **Endpoint agent — deferred.** No OS-wide keystroke capture, clipboard
   monitoring beyond the existing explicit browser-console semantics,
   screenshots, webcam or microphone, browser history, filesystem scanning,
   packet or network interception, global process monitoring, stealth collection
   or background workstation surveillance. It remains a future product and
   privacy decision, not an engineering backlog item.

3. **`v0.2.0` — published as a pre-release, with explicit authorisation.** The
   maintainer authorised the final verification, an annotated `v0.2.0` tag, and a
   GitHub **pre-release**, and explicitly withheld: marking it stable or latest,
   publishing npm or registry artifacts, deploying a hosted instance, and moving the
   tag after publication. `v0.1.0` was not to be moved or rewritten. The release
   remains experimental and not production ready. Details of what was published, and
   the evidence behind it, are in
   [release/v0.2.0-release-notes.md](../release/v0.2.0-release-notes.md) and
   [release/v0.2.0-checklist.md](../release/v0.2.0-checklist.md).

4. **Next maturity focus — operational durability and self-hosting
   correctness.** Durable session truth, restart and recovery correctness,
   bounded rate limiting, replay resistance appropriate to the stated threat
   model, a safer key-rotation path without an identity redesign, migration
   tooling, a local performance baseline, corpus-management usability,
   health and readiness semantics, and backup, restore and upgrade
   documentation. Explicitly *not* new surveillance scope, and not a redesign
   around accounts.

## Release readiness

**`v0.2.0` is published as a GitHub pre-release**, on 2026-09-25. Annotated tag object
`c987767494f4d1c624005f6f498334e658d2c1bc`, peeling to release target
`a355f310eefb5345ddafe8af53cfec805eb21c64`. It is an operational-durability release
and remains experimental: not production ready, no compliance claim, no endpoint
agent, no accounts or tenancy.

`v0.1.0` remains published and is still a pre-release, and its annotated tag is
immutable — re-verified after publication: tag object
`55329b5e378cb890c9b9775647396ea57fd7bdc7`, commit
`ef98f962530fb62340cf213b408f1cd715755c01`.

`main` accumulates further changes under `[Unreleased]` in `CHANGELOG.md`. Publishing
anything beyond `v0.2.0` — another tag, a stable/latest marker, an npm package or a
registry image — remains a separate human authorisation, and none has been given.

The operational-durability phase is complete: every exit condition at the top of this
document is met.

## Current phase: architecture integrity

The operational-durability phase made Cerberus survive a restart predictably. What
it did not do is make its **session lifecycle coherent**: status is written by five
different code paths that order their cache and durable writes three different ways,
one of them can move a terminated session back to `locked`, and the transitions the
system documents as irreversible are not enforced at the only boundary that matters.

**Goal.** Advance Cerberus from *operationally durable experimental system* to
*architecturally coherent experimental system*: centralized session transitions,
explicit partial-failure semantics, truthful domain vocabulary, concurrency-safe
state mutation, bounded read/write paths, and deterministic behaviour under retry,
restart and dependency failure.

This cycle is about architecture integrity, not feature count.

**Explicitly out of scope.** New surveillance scope, an endpoint agent, accounts or
RBAC, tenancy, a second AI provider, public deployment, a new paid service, and
publishing a release. An auth redesign is **not** the answer to the console's
embedded key in this phase.

**Exit condition.** All of the following true, or explicitly rejected with a strong
engineering rationale recorded here:

| # | Criterion | State |
| --- | --- | --- |
| A | Session transitions centralized or proven unnecessary | **Done** — [session-transition.ts](../../apps/api/src/services/session-transition.ts), with the vocabulary in [session-status.ts](../../apps/api/src/services/session-status.ts). One order for every action: read durable → validate → write durably with a predicate → repair caches |
| B | Partial-failure semantics documented and tested | **Done** — [failure-semantics.md](failure-semantics.md) documents every window, and each one this cycle set out to close now has regression tests: the status-change guarantee, the assessment-before-side-effects order, the reported events-write outcome, and the reported delete outcome |
| C | Status cannot silently diverge on supported paths | **Done** — the durable document is the authority, the write is predicate-checked, the result is inspected, the caches are repaired from the durable outcome, and a refusal reconciles a stale cache |
| D | Terminal-content ownership coherent | **Done** — `monitored_sessions.terminalContent` owns "the workspace as monitoring ended" and the API writes it on terminate. The other two sources are documented fallbacks for different facts, not competing owners, and the capability stays published for MCP clients |
| E | Focus-loss/fullscreen semantics truthful | **Done** — the counter is `focusLossCount`, migration `0003` renames the durable field, the summary says "focus lost", and the console panel says **Focus Loss**. No score moves, and a test asserts a blur and a fullscreen exit score identically. The deprecated names are kept as aliases where a caller may depend on them |
| F | Corpus hard ceiling consistent between store, read and console | **Done** — a store-side rejection with `REFERENCE_CORPUS_LIMIT_REACHED`, enforced with an atomic conditional `$inc`, verified at 199/200/201 and under concurrency against a real MongoDB. The API and adapter constants are asserted equal, and the console's copy is asserted to be 200 |
| G | Review-fetch amplification reduced or justified with measurement | **Done** — ingest and reactivate pass `eventsLimit: 0, includeAssessments: false`, and the list path now passes `eventsLimit: 0, assessmentsLimit: 1`. Measured: 10 000 event documents → 0 and 60 assessments → 20 for 20 sessions of 500 events, asserted deterministically and recorded in [performance-baseline.md](performance-baseline.md#the-review-list-read-before-and-after) |
| H | State mutations concurrency-tested | **Done** — four deterministic concurrency cases: terminate racing auto-lock, two terminates racing, two ingests racing, and a duplicate event across two concurrent batches |
| I | Route-level retry/idempotency contracts documented | Open |
| J | Stale-cache/newer-DB behaviour deterministic | **Done** — three tests: the durable status decides over the cache, a refusal reconciles the cache, and a durable lock the cache does not know about is applied rather than ignored |
| K | Migrations cover any schema/status changes | **Done so far** — migration `0002` covers the durable risk-assessment identity, and `classifyDuplicateGroups` is now parameterised on the volatile field so a future collection can reuse it. The `focusLossCount` rename, if taken, still needs one |
| L | API/MCP compatibility preserved where reasonably possible | **Done so far** — every MCP change this cycle is an added optional argument, and the new error codes are additive. `terminate`'s `503` replaces a misleading `404` |
| M | No P0/P1 correctness/security issue remains | **Done** — the confirmed P1 (a terminated session was not terminal) is fixed, with regression tests. Remaining known items are P2 |
| N | Test doubles audited against real-store behavior | **Done** — [test-double-contract.md](test-double-contract.md) audits them, and one shared faithful double replaces four divergent ones, verified against a real MongoDB 7 |
| O | One real-Mongo integration suite protects the highest-risk state flows | **Done** — `apps/api/test/integration/state-flows.test.ts` runs eleven flows through the real routes, the real tool registry and a real MongoDB driver. A bounded CI job provides `mongo:7` and asserts that nothing was skipped |
| P | Docs, threat model and compatibility docs match implementation | Partly — [api-errors.md](../api-errors.md) is new, and the transition model is updated; the threat model and compatibility docs need a pass |
| Q | CI green | Green on every pull request so far |
| R | `v0.1.0` and `v0.2.0` tags unchanged | Verified at the start of the phase; re-verified before the checkpoint |
| S | A coherent next release candidate can be described | Open |

### Phase queue

Ordered by the value of the outcome. The queue is not a checklist to be cleared for
its own sake: each item is either delivered, or rejected here with the engineering
rationale for rejecting it.

1. **The state-transition model, the failure-semantics map, and the test-double
   audit.** Done — [state-transition-model.md](state-transition-model.md),
   [failure-semantics.md](failure-semantics.md),
   [test-double-contract.md](test-double-contract.md). Tracing the source produced
   one confirmed P1 and five P2 findings, all recorded in `CHANGELOG.md`.
2. **A shared faithful store double and a contract suite.** Done. Four independent
   store doubles — three of which returned success from `set_session_status` without
   persisting anything, which is why the P1 above survived a 481-test suite — are
   replaced by one that implements the `MongoStore` method surface under the real
   `createToolRegistry()`, so only storage is simulated. 37 contract cases run
   against it and against a real `MongoStore` when `CERBERUS_TEST_MONGODB_URI` is
   set. Verified on a real MongoDB 7: 546 tests, 0 skipped, 0 failed. Recorded in
   [test-double-contract.md](test-double-contract.md) §6.
3. **The central session transition boundary.** Done. One place a lifecycle status
   changes, with domain actions rather than a generic setter, an explicit transition
   table, a durable-first order, a compare-and-set write, a canonical result that
   distinguishes applied / no-op / refused / conflict, and caches repaired from the
   durable outcome. Ingest also refuses a terminated session, which fixes the
   confirmed P1. The enforced table, the history it replaced and the four remaining
   P2 items are in [state-transition-model.md](state-transition-model.md).
4. **Route adoption and concurrency tests.** Done — terminate, reactivate, auto-lock
   and auto-clear all delegate to the boundary, and four concurrency cases interleave
   deterministically rather than by sleeping.
5. **Partial-failure semantics for the cache/durable split, and the ingest ordering
   inversion.** Done. The cache/durable split is closed by the boundary, and the
   ordering inversion is closed by writing the assessment before the status change and
   the notification — a failed assessment write now skips both, so a lock always has
   recorded evidence. The ingest response also reports `telemetryPersisted` and
   `assessmentPersisted`, so a failed step is no longer disguised as a successful one.
6. **Terminal-content ownership.** Planned — one coherent direction, chosen and
   documented rather than left implicit.
7. **`WINDOW_BLUR` / fullscreen semantic correction.** Planned. This is the one item
   that may need a migration, so it is decided on its own evidence.
8. **The reference-corpus hard ceiling.** Planned — reject at the store, one stable
   error code, tests at 199 / 200 / 201 and at the boundary under concurrency.
9. **Review-fetch amplification.** Planned — measure first, then reduce, with
   before/after evidence.
10. **The real-Mongo integration suite and a bounded CI job.** Planned.
11. **Migration race and failure hardening.** Planned.
12. **The error model and console handling.** Planned — `docs/api-errors.md` does
    not exist yet.
13. **Checkpoint and release-candidate documentation.** Planned. **Nothing is
    published.**

### New findings from the state-transition trace

Recorded here as well as in `CHANGELOG.md`, because criterion M is a claim about
defects and a claim without the list is not checkable.

| Finding | Severity | How it was found |
| --- | --- | --- |
| A terminated session accepts telemetry and can be moved to `locked` by a high-risk batch | P1 | Tracing the ingest preconditions; reproduced against a store double |
| Status writes are last-writer-wins; terminate racing auto-lock is decided by arrival order | P2 | The transition table |
| The durable status write's result is not inspected on auto-lock, auto-clear or terminate | P2 | Write-ordering trace |
| Auto-clear's precondition reads the cache, so a durably `locked` session can never be auto-cleared after a restart | P2 | Write-ordering trace |
| A failed `ingest_micro_events` is indistinguishable from a fully successful one in the response | P2 | Failure-window trace |
| The risk assessment is persisted **after** the notification and the status write | P2 | Failure-window trace |
| The module header claims four dedup layers; layer 1 is not implemented and `risk_assessments` has no unique index on `riskAssessmentId` | P2 | Header-versus-code comparison |

## Architecture-integrity phase: complete

**The checkpoint is reached, and the release is published.** Every exit criterion in the
table above is met or explicitly rejected with a reason. **`v0.3.0` was published on
2026-09-26** as a GitHub pre-release — annotated tag `v0.3.0`, tag object
`af22236626019352bddebe8798a659151af7ec4f`, target
`95b57836b4d879766ad94953323ce5811f50041a`. No npm package, no container image and no
hosted deployment were published, and nothing is marked stable or latest.

The record of the cycle is
[architecture-integrity-checkpoint.md](architecture-integrity-checkpoint.md): the eleven
merged pull requests, the twelve defects it found and how, the exit criteria with their
state, the verification at the checkpoint, and what remains accepted.

The three documents that carried the design work:

- [state-transition-model.md](state-transition-model.md) — the enforced transition table,
  the five mutation paths it replaced, and the P1 that tracing them found.
- [failure-semantics.md](failure-semantics.md) — what each multi-step operation guarantees
  when a step fails, and what it does not.
- [test-double-contract.md](test-double-contract.md) — the doubles, the contract matrix, and
  why a passing suite was not evidence of correctness.

The release is published. The notes are
[release/v0.3.0-release-notes.md](../release/v0.3.0-release-notes.md), and the gates that
were run for it — including the ones that must be re-run rather than assumed — are recorded
with their results in
[release/v0.3.0-checklist.md](../release/v0.3.0-checklist.md).

## Operability phase: checkpoint reached

**The checkpoint is reached. Nothing is published.** Ten pull requests, fourteen defects,
and one question answered.

The `v0.3.0` cycle left an *architecturally coherent* system that could not be **inspected**:
a request could not be traced, a session detail answered `404` for a session that existed, a
partial deletion was reported as complete, and the release gates lived in a session — with
one of them verified against a stale container image.

This cycle was about seeing and re-running what the system already does. Its record is
[operability-checkpoint.md](operability-checkpoint.md): the ten merged pull requests, the
fourteen defects and how each was found, the exit criteria with their state, the
verification, the immutability proof for the three published tags, and the eight limitations
accepted rather than fixed.

The four documents that carry the work:

- [operability-model.md](operability-model.md) — every request path against nine operability
  columns, the logging design, and the two-layer redaction guarantee.
- [read-model.md](read-model.md) — the four surfaces that answer for one session, the three
  vocabularies that must not be conflated, and the six read-integrity defects comparing them
  found.
- [console-smoke.md](console-smoke.md) — the browser pass, what it automates and what only a
  human can judge.
- [../release/verification-harness.md](../release/verification-harness.md) — the
  seventeen-step non-publishing harness, and the four gates that are specific to a release.

The release is published. The notes are
[release/v0.4.0-release-notes.md](../release/v0.4.0-release-notes.md), and the gates that
were run for it — including the ones that must be re-run rather than assumed — are recorded
with their results in
[release/v0.4.0-checklist.md](../release/v0.4.0-checklist.md).

### What the next cycle inherits

Accepted rather than fixed, and each with its reason in the checkpoint's §8: rate limiting
is per-process; the two paid routes remain non-idempotent; the console embeds the operator
key in its bundle; backups have no scheduling, off-host storage, encryption or
point-in-time recovery; the live surfaces report the status this process holds in memory;
and the browser smoke's terminology pass is a human reading screenshots.

## Multi-writer trust-boundary phase: in progress

**No release is published in this phase.** The theme is the one the previous checkpoint
handed over: *Cerberus v0.5.0 — Multi-Writer Consistency & Trust Boundaries*.

The `v0.4.0` cycle made the system **inspectable**. It did not ask what happens when two API
processes serve the same session at once, because the system had only ever run as one. Every
state path in the repository was written by someone who was the only writer:

> If process A and process B handle requests for the same session at the same time, does
> Cerberus still tell the truth?

For the transition boundary, the answer was already yes — it reads MongoDB, validates
against a table, writes with a predicate, and repairs its caches from the outcome. For the
**read** paths it was no, and that is the gap this phase exists to close.

The phase is deliberately Mongo-backed. The answer to a multi-writer problem is a durable
predicate, not a distributed lock: a compare-and-set on one document is atomic in MongoDB
without a transaction, so it works on the documented single-node deployment. Nothing here
adds Redis, Kafka, a lock service, or a replica set.

### The documents this phase produces

- [multi-writer-model.md](multi-writer-model.md) — every session concept classified, the six
  multi-writer questions answered per field, the invariant the read paths owe, and the four
  places the current implementation breaks it. Its §6 is the honest enforcement table.
- [live-read-consistency.md](live-read-consistency.md) — the freshness contract per surface,
  why there is deliberately no bounded-stale surface, and how the live list and detail
  reconcile against durable truth.
- [operability-checkpoint.md](operability-checkpoint.md) — the previous cycle's record, whose
  §8 is the list of limitations this phase starts from.

### What this phase inherits, and how each item is being answered

| Inherited limitation | This phase |
| --- | --- |
| The live surfaces report the status this process holds in memory | **The main gap.** Durable reconciliation on the live list and live detail — see the model's §5.1 |
| `peakRiskScore` is not read on the memory paths | Same reconciliation; the durable value is `$max`-maintained and is the answer |
| `terminalContent` has no ownership rule | First successful terminal transition owns it, enforced with a compare-and-set |
| The two paid routes remain non-idempotent | Re-evaluated, with the decision and its evidence recorded rather than assumed |
| Rate limiting is per-process | Quantified for N replicas, and the honest scope documented rather than papered over with a shared store |
| The console embeds the operator key in its bundle | Unchanged. Still a documented consequence of the single-key model |
| Backups have no scheduling, off-host storage or encryption | Unchanged. Out of scope for a trust-boundary cycle |

### Phase exit criteria

The charter's eighteen conditions, tracked as the phase proceeds. A condition is **met** only
when something in this repository proves it — a test, a workflow run, or a measured number —
and is otherwise stated as not met.

| # | Condition | State |
| --- | --- | --- |
| A | Live session reads reconcile against durable lifecycle state | **Met for the live list** — one batched durable query per request, durable wins, and a durably-terminated session is dropped in the same request that would have reported it. **Not met for the live detail** |
| B | Stale in-memory status cannot override newer durable status on read | **Met for the live list**, including once the store stops answering, because the previous read repaired the cache toward the document. **Not met for the live detail** |
| C | Two processes can safely observe/transition the same session under supported flows | Partially met — transitions are safe, and the live list is now safe to observe; the live detail is not |
| D | Stale process caches are detected and reconciled deterministically | **Met for the live list** — the merge returns a repair, applied through `reconcileStatus`, which is one-directional and does not move the cached activity instant. **Not met for the live detail** |
| E | Live-list semantics stay bounded and performant after durable reconciliation | **Met** — one durable query per list request regardless of how many sessions are in memory, so there is no N+1. The measured cost is still outstanding (N) |
| F | Route-level multi-writer behaviour is documented | **Met** — [multi-writer-model.md](multi-writer-model.md) §4 |
| G | Paid-route duplicate-spend risk reduced or explicitly re-accepted with stronger evidence | Not met — no decision recorded yet |
| H | Any idempotency mechanism is durable, race-safe and bounded | Not applicable yet — none introduced |
| I | Per-process rate limiting honestly scoped, or a safe next-step boundary documented | Partially met — the limiter documents its own N-replica behaviour |
| J | Shared-key lifecycle risks bounded without inventing accounts | Partially met — [../operations/key-rotation.md](../operations/key-rotation.md) covers the overlap procedure |
| K | `@cerberus/mcp-mongodb` hardened against accidental publication | **Met** — `private: true`, plus `npm run verify:packages` |
| L | Full release verification runnable through CI, not only a developer machine | **Met** — `.github/workflows/release-verification.yml` on `workflow_dispatch` |
| M | Docker-dependent release evidence reproducible in CI/manual workflow | **Met** — same workflow, with a real `mongo:7` and a Docker build |
| N | Live-state reconciliation has measured cost, no pathological query amplification | Not met — nothing added yet to measure |
| O | No known P0/P1 correctness or security defect remains | Not met — §5.1 and §5.3 of the model are open |
| P | Docs, threat model and compatibility docs match implementation | In progress — the new docs state the gaps rather than describing the target as done |
| Q | Published tags remain immutable | **Met** — verified at the checkpoint, and nothing in this phase rewrites history |
| R | A coherent next release candidate can be described | Not met — deferred to the checkpoint |

