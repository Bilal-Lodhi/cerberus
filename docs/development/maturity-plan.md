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
| G | Local performance baseline exists | Not started |
| H | Health and readiness semantics are coherent | Not started |
| I | Backup, restore and upgrade documentation exists | In progress — [operations/upgrade.md](../operations/upgrade.md) covers backup-verify, apply, confirm and rollback. A dedicated backup/restore document remains |
| J | Corpus-management workflow usable without hand-writing raw HTTP | Not started |
| K | No new P0/P1 correctness or security defects remain | Not started |
| L | CI stays green | Not started |
| M | Threat model and documentation match reality | Not started |
| N | A coherent `v0.2.0` release candidate can be described without hand-waving | Not started |

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

## Next queue

Ordered by the value of the outcome, not by effort.

1. **Durable session truth and restart consistency.** The largest remaining
   engineering limitation. Inventory every in-memory session field, classify it,
   and move lifecycle-affecting state to MongoDB as the durable authority through
   one central transition path. **In progress.**
2. **Replay and idempotency.** Deduplication currently lives in a per-process
   fingerprint ring, so a replay after a restart is re-ingested. Define the dedup
   window, make it survive restart where feasible, and make retry after a network
   ambiguity safe. **Planned.**
3. **API-key rotation.** A `CERBERUS_API_KEY_PREVIOUS` overlap so a key can be
   changed without a hard cutover, compared timing-safely, with no key identity
   logged. **Planned.**
4. **Rate limiting.** A dependency-light in-process limiter on the expensive and
   high-risk paths, documented as a backstop rather than DDoS defence.
   **Planned.**
5. **Migration tooling.** An explicit schema version, ordered and idempotent
   migrations, and tests against a disposable MongoDB. **Planned.**
6. **Health and readiness.** Split liveness from readiness, with optional
   dependencies never blocking readiness. **Planned.**
7. **Backup, restore and upgrade documentation.** With at least one local
   roundtrip verified. **Planned.**
8. **Performance baseline.** A bounded local harness and one recorded summary. No
   universal performance claims. **Planned.**
9. **Corpus-management usability.** A small console surface if it materially
   improves the workflow; otherwise an improved documented API path.
   **Planned.**

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
a pre-release, and its annotated tag is immutable.

`main` accumulates changes under `[Unreleased]` in `CHANGELOG.md`. A release
candidate report is prepared when a coherent milestone has accumulated — not
because a number of commits have passed. Publishing a release, moving a tag or
declaring production readiness requires explicit maintainer authorisation.

The current milestone under construction is the operational-durability phase
described in owner decision 4. Its exit condition is recorded at the top of this
document.
