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

Last updated at the maturity checkpoint (see `CHANGELOG.md` `[Unreleased]`).

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
| N | A coherent `v0.2.0` release candidate can be described without hand-waving | Done — [release/v0.2.0-release-notes.md](../release/v0.2.0-release-notes.md) and [release/v0.2.0-checklist.md](../release/v0.2.0-checklist.md), both marked draft, plus [migration-v0.1-to-v0.2.md](../migration-v0.1-to-v0.2.md). **Nothing is published** |

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
| Ingest carries up to 500 events from the review fetch on every request | A bounded optimisation opportunity, measured and recorded |

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
| Session state is in memory and lost on restart | Accepted limitation | MongoDB is the durable fallback; the review router merges both and takes the larger count per counter. Durable session truth is a larger change and is deferred. |
| No endpoint agent | Accepted limitation | All telemetry originates from the browser console. Building one is a scope decision, not an engineering task. |
| Single shared API key, no per-user attribution | Accepted limitation | Accounts, roles, OAuth/SSO and multi-tenancy are explicitly out of scope for the OSS baseline. |
| No rate limiting, no replay protection beyond TLS, no automated key rotation | Accepted limitation | Documented in the threat model. The ingestion fingerprint ring is a data-quality mechanism, not a security control. |
| Console API key is embedded in the built web bundle | Accepted limitation | A consequence of `--dart-define` at build time. Mitigation is to serve the console only to trusted operators or front it with a credential-injecting proxy. |
| No migration tooling for the historical schema | Accepted limitation | The mapping is documented in [migration.md](../migration.md); no script ships. |
| Session status vocabulary is narrower in the durable store than in the review contract | Accepted limitation | Only `active`, `locked` and `terminated` are persisted; `flagged` and `investigating` are derived at read time. |
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

3. **`v0.2.0` — prepared, not published.** Release notes, migration notes, a
   checklist and a candidate branch may be prepared. Pushing a `v0.2.0` tag,
   creating a GitHub Release, marking anything stable or latest, and publishing
   npm or registry artifacts all remain separate human authorisations.

4. **Next maturity focus — operational durability and self-hosting
   correctness.** Durable session truth, restart and recovery correctness,
   bounded rate limiting, replay resistance appropriate to the stated threat
   model, a safer key-rotation path without an identity redesign, migration
   tooling, a local performance baseline, corpus-management usability,
   health and readiness semantics, and backup, restore and upgrade
   documentation. Explicitly *not* new surveillance scope, and not a redesign
   around accounts.

## Release readiness

**No release is published.** `v0.1.0` remains the only published baseline, still
a pre-release, and its annotated tag is immutable — verified after every merge:
tag object `55329b5e378cb890c9b9775647396ea57fd7bdc7`, commit
`ef98f962530fb62340cf213b408f1cd715755c01`.

`main` accumulates changes under `[Unreleased]` in `CHANGELOG.md`. Publishing a
release, moving a tag or declaring production readiness requires explicit
maintainer authorisation; none has been given.

The operational-durability phase is complete: every exit condition at the top of
this document is met. Release-candidate material is prepared under
`docs/release/` and is **not** published.
