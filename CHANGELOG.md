# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The theme is **durable idempotency and side-effect safety** for the two routes that spend
money. **Nothing is published**: no tag, no npm package, no container image and no hosted
deployment. This is an experimental research system and is not production ready.

### Added

- **Durable idempotency for `POST /api/v1/scenarios`.** The route accepts an optional
  `Idempotency-Key` header and, when one is supplied, claims the operation **before** the
  first paid call. A retry with the same key and the same request replays the first response
  and never reaches the provider; the same key with a different request is
  `409 IDEMPOTENCY_CONFLICT` and spends nothing; a live claim answers
  `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After`; an unreachable claim store answers
  `503 IDEMPOTENCY_STATE_UNAVAILABLE` with **nothing claimed and nothing spent**. A caller
  that sends no key gets exactly the behaviour it had before — the change is additive.
  Verified with 19 cases through the real route, counting provider calls at the stub:
  reordered bodies and equivalently-scaled severity mixes replay, a changed field conflicts,
  a classifier rejection is recorded as a completed outcome so a retry replays it for free,
  a provider outage is recorded retryably so a retry re-executes, and a replayed response
  carries the **current** request's correlation id rather than the original's.
- **`claim_paid_operation`, `complete_paid_operation` and `fail_paid_operation` — three MCP
  tools and the store methods behind them.** The claim is a single-document atomic insert and
  the unique index is the whole of the mutual exclusion. Reclaim is one `findOneAndUpdate`
  whose **filter carries the whole predicate** — fingerprint, status and lease expiry — so two
  processes reclaiming together produce exactly one reclaimer, and a stale record belonging to
  a *different* request cannot be taken. Completion and failure are conditional on the claim
  id, and a completion that matches nothing is reported as `completed: false` rather than
  swallowed, because that is the one state in which a second execution exists. Eleven contract
  cases run against the in-process double **and** a real MongoDB.
- **`CERBERUS_IDEMPOTENCY_TTL_SECONDS`** — how long a claim record is retained, default 24
  hours, bounded 60–604 800 seconds and validated fail-closed. There is deliberately **no
  lease setting**: the lease is derived from `OPENAI_REQUEST_TIMEOUT_MS`
  (`clamp(2 × timeout + 30 s, 60 s, 30 min)`), because a lease shorter than a provider call
  would let a second process reclaim a *healthy* operation and spend again. Deriving it makes
  that misconfiguration unrepresentable.
- **`apps/api/src/services/paid-operation.ts` — the claim decision, in one place.** Both paid
  routes must answer identically, so the decision is a discriminated result rather than a
  boolean: `execute`, `replay`, `pending`, `conflict`, `unavailable`. A boolean would make
  "someone else is working on it" and "your key was reused for a different request" both look
  like `false`, and a route that mishandled either would spend. **Money is spent only on
  `execute`.**
- **Failure semantics that distinguish "we do not know whether it spent" from "we know it
  spent".** A provider outage or a cancellation is recorded `retryable`, so a same-key retry
  re-executes. A failure where Cerberus **observed the provider succeed** and could not record
  the result is recorded non-retryable with the failure to replay, so a same-key retry answers
  from the record instead of spending again — and a caller who wants a different outcome uses
  a new key, a deliberate act rather than a silent second charge. The store refuses to write a
  non-retryable failure with nothing to replay, because that would leave the caller with no
  answer at all.
- **`apps/api/src/services/idempotency-key.ts` — the `Idempotency-Key` contract.** Reads the
  header, validates it, and derives the only form of it that is ever stored. The charset is
  `\x21`–`\x7E` — printable ASCII with **no space** — because a key reaches a log line, a
  database field and possibly a terminal (no control characters), because every HTTP stack
  folds header whitespace differently (no whitespace ambiguity), and because every realistic
  generator produces ASCII (no multi-byte aliases). The stored value is `sha256(key)`, and a
  log line carries eight hex characters of that digest, so an operation can be joined across
  log lines without the key ever being written down. A rejection carries **no** key material
  and never echoes the value that failed. An empty header is rejected rather than treated as
  absent, because a caller that sent the header believed the request was protected.
- **`apps/api/src/services/request-fingerprint.ts` — the canonical, versioned request
  fingerprint.** A `sha256` over a canonical serialisation of the fields that decide what a
  paid operation actually does: stable object-key ordering **by UTF-16 code unit** rather
  than `localeCompare`, so two replicas cannot disagree about the digest of one request;
  arrays order-sensitive by construction; `undefined` omitted and `null` preserved; strings
  escaped; no Unicode normalisation, because NFC and NFD spellings are different provider
  inputs and normalising them would make two genuinely different requests collide. The
  version is hashed into the digest as well as stored on the record, so a future change to
  the canonical form is a new version rather than a silent reinterpretation of existing
  records.
- **`operation_claims` — the durable claim collection for a paid operation, and the two
  indexes that make it work.** One document per paid-operation attempt, keyed on
  `(routeFamily, sha256(Idempotency-Key))`. The **unique** index on that pair is the whole
  of the mutual exclusion: two API processes racing one `Idempotency-Key` both attempt the
  insert, the index refuses the second, and the loser reads the winner's record instead of
  calling the provider. The **TTL** index on `expiresAt` (with `expireAfterSeconds: 0`, so
  the deadline is the record's data rather than the index's configuration) bounds the
  collection, which holds one record per caller-supplied key. The specification is declared
  **once** in `packages/mcp-mongodb/src/operation-claims.ts` and applied by both
  `MongoStore.ensureIndexes()` and migration `0004`, because two declarations that drifted
  would make the second to run fail with `IndexOptionsConflict`. The collection stores no
  prompt, no question and no provider output — only a claim, a request fingerprint and the
  response to replay.
- **Migration `0004-paid-operation-claim-indexes`.** Creates the claim collection's two
  indexes, so a database upgraded with `npm run migrate` alone already enforces the claim
  rather than only gaining the ability to. It rewrites no data — the collection is new, so
  there is nothing to repair and no way for it to refuse — which is what makes it safe on a
  `v0.5.0` database of any size.
- **The `v0.5.0` release shape in the upgrade fixture.** `apps/api/test/support/release-fixture.ts`
  now describes the most recent published release, derived from its own release notes
  ("**No schema migration ships with this release.**") rather than from the code. The
  upgrade gate asserts that a `v0.5.0` database has exactly one migration pending, that a
  dry run changes nothing at all, that migrating creates the collection with **both**
  indexes, that the unique index actually **refuses** a second claim for one key, and that
  the documented `connect()` path upgrades in one idempotent step.
- **TTL indexes are now guarded the way unique indexes are.** `critical-indexes.json` gained
  a `ttlIndexes` list, and `apps/api/test/release/critical-indexes.test.ts` asserts it
  against a real store in **both** directions — every entry must exist, and the store must
  not create a TTL index the list omits. `scripts/restore-cerberus.ps1` verifies both kinds
  after every restore. A lost unique index accepts documents the product forbids; a lost TTL
  index changes no answer at all, which is exactly why it is easy to overlook.
- **The backup/restore drill exercises the claim constraint, not just its declaration.** The
  fixture now seeds an `operation_claims` record and both critical indexes, and after
  restoring, the drill inserts a **second** claim for the same idempotency key and asserts
  the restored database refuses it. An index in `getIndexes()` is a declaration; only an
  insert distinguishes "the index exists" from "the index refuses the second write".
- **`docs/development/paid-operation-state-model.md` — the state machine for the two paid
  routes.** `POST /api/v1/scenarios` and `POST /api/v1/auditor/query` are traced step by
  step from the source: which steps spend money, which write anything durable, what the
  route returns, and what a retry of each means. The document specifies the target state
  as well as the current one — the `Idempotency-Key` contract, the canonical versioned
  request fingerprint, the atomic claim and the unique index that is the whole of the
  mutual exclusion, replay and conflict semantics, the pending lease derived from the
  provider timeout, stale-lease reclaim, retention and the TTL index, the redaction rules,
  the measured query cost, and every failure path — and carries an implementation-status
  table so it cannot describe the target as though it were shipped.

### Fixed

- **The recorded paid-call count for `POST /api/v1/auditor/query` was wrong.**
  `docs/development/idempotency-model.md` and `docs/development/maturity-plan.md` both
  recorded **one** paid call per accepted request. The route makes **two**:
  `provider.toMongoPipeline` builds the pipeline and
  `provider.summarizeSessionRecords` summarises the result, with a durable
  `list_sessions` read between them. The route's own module comment and the
  `MAX_QUESTION_CHARS` docstring already said "sent to a paid provider twice"; only the
  two documents disagreed with the code. The correction is recorded rather than silently
  patched, and both documents are corrected in place.

### Changed

- **`docs/development/idempotency-model.md` is marked superseded as a decision.** It
  remains the record of why the duplicate-spend exposure was re-accepted during the
  multi-writer phase, and of what is explicitly not claimed, but the mechanism it
  designed is now specified as a state machine in
  `docs/development/paid-operation-state-model.md`.

## [0.5.0] - 2026-09-26

**Published as a GitHub pre-release** on 2026-09-26. Annotated tag `v0.5.0`, tag object
`a635862e7a726f6362029e3aa711d630551a757f`, target
`000ac1a7ddd837d35790a434a22969d3f6073189`. No npm package, no container image and no hosted
deployment were published, and nothing was marked stable or latest. This is an experimental research
system and is not production ready — see
[docs/release/v0.5.0-release-notes.md](docs/release/v0.5.0-release-notes.md) for what the release
does and does not claim.

The theme is **multi-writer consistency and trust boundaries**: the live session list and detail
reconcile against durable truth on every request, a stale process cache cannot override a newer
durable status, aggregate counters are a batch delta applied with `$inc` so two API processes
accepting distinct events both count, the process whose terminal transition applied owns
`terminalContent`, and the release-verification drill is reproducible in CI. **No schema migration
ships with this release.**

See [docs/release/v0.5.0-release-notes.md](docs/release/v0.5.0-release-notes.md) for the full scope
and, stated plainly, ten things the release does not claim.

### Added

- **`npm run verify:packages` — the private-package guard.**
  `packages/mcp-mongodb` shipped without `"private": true` through four releases, so the
  only thing preventing an accidental registry upload of it was nobody typing the command.
  Every other mistake in this repository is recoverable by a later commit; a registry upload
  is not. Every workspace package must now be unpublishable by construction — `"private":
  true`, or an entry in the guard's allowlist **with a reason**. A workspace entry that
  resolves to no directory, a directory with no manifest, a duplicate package name, an
  allowlist entry with no reason, and a **stale** allowlist entry each fail the guard, because
  each is a way for the guarantee to be turned off while it still reports OK. The guard's
  refusals are asserted over disposable fixture trees by
  `apps/api/test/release/private-packages.test.ts`.
- **The release-verification drill is reproducible in CI.**
  `.github/workflows/release-verification.yml` runs `npm run verify:release` on
  `workflow_dispatch` against a `mongo:7` service container, with `contents: read`, no paid
  provider call, no repository secret, a job timeout, and an assertion that **no step was
  skipped**. The harness was previously a command a maintainer ran on their own machine: the
  evidence existed, but nobody else could produce it. The workflow never tags, publishes or
  creates a release.
- **`docs/development/multi-writer-model.md` — the multi-writer state model.** Every session
  concept classified as durable-authoritative, reconstructed, derived, ephemeral or
  **process-local authority** (the anti-pattern), with the six multi-writer questions
  answered per field: can one process write it while another holds stale memory, what the
  stale process returns, what reconciles it, whether the divergence is acceptable, how long
  it can last, and whether a stale process can write older truth back. It states the
  invariant the read paths owe, the four places the current implementation breaks it, and an
  enforcement table that marks each rule enforced or not rather than describing the target as
  done.
- **`docs/development/live-read-consistency.md` — the freshness contract.** What *current*
  means on each surface, defined as four precise terms (durable current, bounded-stale, local
  best effort, absent), why there is deliberately **no** bounded-stale surface, how the live
  list and live detail reconcile against durable truth, why cache repair is one-directional,
  and the failure-injection matrix each behaviour must satisfy.
- **The multi-writer phase in `docs/development/maturity-plan.md`**, with the charter's
  eighteen exit conditions tracked individually and each marked met only where something in
  this repository proves it.

### Changed

- **The live session list reconciles against durable truth on every request.**
  `GET /api/v1/guardian/sessions` was built from this process's memory and consulted MongoDB
  **only when that memory was empty**, which made it process-local-authoritative. Two false
  statements followed: a session another API process terminated kept being reported `active`
  until its TTL elapsed, a transition happened to run through this process, or it restarted —
  and a session another process had deployed or ingested was **absent from the page
  entirely**. The list now issues one batched durable query per request and merges durable
  over local: status from the document, counters and peak risk as `max(local, durable)`,
  liveness from the more recent of the two activity instants, and identity from the document.
  A durably-terminated session is dropped in the same request that would have reported it, and
  another process's sessions appear.

  The merge is `apps/api/src/services/session-reconciliation.ts` — a pure function with its
  own suite — so the route is a thin adapter and the rule can be tested over states that are
  awkward to produce through HTTP.

  When the store does not answer the page is still served, with `reconciled: false` and every
  row marked `statusSource: "process-local"`. Refusing outright would take the live dashboard
  down during a store blip; presenting the local value as durable truth would be a lie.

  Three additive response fields: `reconciled` on the body, and `statusSource` and
  `ephemeralStateAvailable` on each row. See `docs/compatibility.md` §1b.
- **The live session detail reconciles against durable truth on every request.**
  `GET /api/v1/guardian/sessions/:sessionId` answered from `sessionStore` whenever it held the
  session and **never read the document**. With one process that was free, because the process
  holding the session was also the only writer. With two it was a false statement: a session
  another process had terminated kept reading as `active` here while the review surface, which
  reads MongoDB, said `terminated` about the same session. `session-detail-fallback.test.ts`
  used to assert exactly that division and record it as deliberate.

  The document is now read on every detail request and the same merge applies — status,
  counters and peak risk from the document or `max(local, durable)`, identity from the
  document, `liveness` from the more recent of the two activity instants, and the reconstructed
  workspace and latest payload from this process, labelled `ephemeralStateAvailable`. The read
  asks for the document only (`eventsLimit: 0, includeAssessments: false`), so a detail does
  not become work proportional to a session's history.

  Two additive fields on the session object: `statusSource` and `reconciled`. The cost is one
  bounded read on a path that previously paid none — the same read the restart-recovery path
  already made.
- **`riskIndex`, `overallRiskScore` and `peakRiskScore` are the reconciled maximum.** They were
  already reported from one value on every surface; the change is that a session another process
  scored no longer reads as `0`. `peakRiskScore` is a peak, so the maximum is its documented
  meaning, and the other two follow it because they always have. See `docs/compatibility.md`
  §1b.
- **Aggregate counters are sent as a batch delta and applied with `$inc`, so two processes
  accepting distinct events both count.** They were sent as **absolute totals** and applied with
  `$max`. That is monotonic — which is what stopped a restarted process from replacing the durable
  totals with its post-restart ones — but it is not correct under two writers, and the loss was
  exact:

  ```
  A hydrates eventCount: 10, accepts 5 events, writes $max 15
  B hydrates eventCount: 10, accepts 3 events, writes $max 13
  durable = max(15, 13) = 15          true total = 10 + 5 + 3 = 18
  ```

  Neither process ever saw the other's batch, so the durable aggregate converged to the largest
  single process's total rather than the sum, and the missing counts were never recovered — a
  later batch by either process continued from its own baseline. The counters gate the analysis
  triggers and appear on the review panel, so this was not cosmetic.

  The delta is measured from the session state **before and after** the accepted events were
  applied, rather than derived from the event types, so it cannot drift from what was actually
  applied. A negative or non-finite delta is dropped, so a counter still cannot decrease.
  `peakRiskScore` stays absolute and `$max`-applied, because a maximum is not a total.

  `update_session_counts` gains an optional `countsDelta`; with it absent, `counts` keeps `$max`
  and an existing MCP caller is unaffected. When a field appears in both it leaves `$max` for
  `$inc`, because MongoDB refuses an update that touches one path through two operators. See
  `docs/compatibility.md` §1b.
- **A two-process integration harness against a real MongoDB.**
  `test/integration/multi-process.test.ts` runs **two API processes, the real tool registry and
  the real MongoDB driver against one set of documents** — the combination the in-process
  multi-writer suites cannot reach, because `$max`, a compare-and-set that matches nothing, and
  `$inc` per document are all driver behaviours. Eight flows: two processes accepting distinct
  events both count; two ingests issued together with `Promise.all` still sum; the same event sent
  to both is counted once; a session one process created is visible to the other's live list and
  detail; a status one process set is reported on every surface of the other; the other's ingest
  is refused for a terminated session; **two concurrent terminates leave one durable truth and one
  preserved workspace**; and a restart of one process does not disturb the other's view. Each
  concurrency assertion is the invariant that must hold under any interleaving, rather than a
  guess about which process wins.
- **`docs/development/idempotency-model.md` — the paid-route decision and design.** The two paid
  routes spend money on every request they accept and keep no durable record of a request, so a
  retry after a lost response spends again. The document measures the exposure **from the source**
  (`POST /api/v1/scenarios` makes **two** paid calls per request — a semantic classifier and then
  matrix authoring; `POST /api/v1/auditor/query` makes one), names the three ordinary ways a
  response is lost, bounds the blast radius, and **re-accepts the risk for this phase** with the
  cost stated rather than implying the gap does not exist.

  It also carries the design that would close it — one `operation_claims` collection, a unique
  index on `(routeFamily, keyHash)` as the whole of the mutual exclusion, a TTL index for bounded
  retention, a request fingerprint, and an opt-in `Idempotency-Key` header so an existing client
  is unaffected — plus the exact pending-operation and process-death semantics (a claim past its
  timeout is abandoned; a crash between the provider's response and the record write leaves an
  **unknown outcome**, stated rather than hidden), and the eight assertions that would prove it.
  Nothing here claims exactly-once billing.
- **`docs/operations/multi-replica.md` — running more than one replica.** What is safe with N
  replicas and **why** (predicate-checked transitions, `(sessionId, eventId)` event identity, the
  batch-delta counters, the reconciled live reads, `terminalContent` ownership, the migration
  ledger), and what multiplies or does not work at all.

  It records the **rate-limiting decision**: the limiter stays local, because a Mongo-backed
  limiter would put a write on the hot path of every request — including ingestion, which the
  console drives one event at a time — to enforce a bound that is explicitly a backstop, and
  because per-caller limiting needs caller identity the OSS baseline does not have. The N-replica
  multiplier is stated, along with the consequence that matters most: the `ai` bucket bounds spend,
  so an operator running more than one replica should set that limit at the proxy.

  It also states the rolling key-rotation rule (**the new key is everywhere before the old key is
  anywhere retired**), the per-replica verification loop that makes it checkable — a replica that
  missed the configuration is indistinguishable from a correct one until a client lands on it — the
  MCP adapter's extra ordering constraint, and an explicit refusal to invent a key generation id or
  a revocation list. Plus the two things that simply do not work across replicas: per-process
  operator identity handles, and notification deduplication.
- **`docs/security/threat-model.md` §8b — the multi-writer section.** Each change this cycle made
  and its effect on the model, followed by the boundaries it did **not** move: one shared key still
  grants equivalent authority to every replica, local rate limiting multiplies, idempotency reduces
  duplicates rather than replay or authorization risk, a request id is observability only,
  notifications remain undeduplicated, and there is no new monitored data and no compliance claim.
- **`docs/operations/key-rotation.md` and `docs/operations/reverse-proxy.md`** now point at the
  multi-replica procedure rather than leaving the single-process procedure to be read as complete.
- **`docs/development/multi-writer-checkpoint.md` — the cycle's record.** The eight merged pull
  requests, the five defects and how each was found, the exit criteria with their state (**one
  partially met and stated as such**), the verification at the checkpoint, the immutability proof
  for the four published tags, and the eight limitations accepted rather than fixed.
- **`docs/release/v0.5.0-release-notes.md` and `docs/release/v0.5.0-checklist.md` — the release
  material, since published.** The notes state the theme, the observable changes, the compatibility
  position and ten things the release does not claim; the checklist records the gates verified
  against the frozen candidate and the publication steps.
- **The process whose terminal transition applied owns `terminalContent`.**
  `POST /sessions/:sessionId/terminate` preserved the workspace **before** the status transition,
  and `update_session_terminal_content` was an unconditional `$set`. Two processes terminating
  the same session therefore both wrote, and the last writer won — with whichever process
  happened to hold the **staler** reconstruction of the workspace. The field is one fact ("the
  workspace as monitoring ended") and it had no single owner.

  Only the **write** moved. The workspace is still read while the session is live; the status
  transition — already predicate-checked — is now the atomic claim; and the content is written
  afterwards, gated on the status the transition produced. A terminate that *did* apply writes
  with `expectedStatuses: ["terminated"]`. A terminate that found the session already terminated
  did not claim it, so it may only **repair** through `onlyIfAbsent` — the case where the winning
  process died between its transition and its write — and never overwrites a workspace another
  process preserved.

  Two consequences: a `terminate` refused for a session that does not exist now writes **nothing**
  (it used to write content first), and `applied` on the content write reports whether the write
  happened rather than merely that the request was well-formed.

  `update_session_terminal_content` gains optional `expectedStatuses` and `onlyIfAbsent`, and
  reports `updated`. With neither gate the write stays unconditional, so an external MCP client
  that supplies neither sees no change. See `docs/compatibility.md` §1b.
- **A live read repairs this process's cache toward the document, and only toward it.**
  `SessionTransitionCache.reconcileStatus` is deliberately not `apply`: `apply` stamps the
  cached activity instant to the transition instant, which is right for a transition and wrong
  for a read — a status repair that also moved `lastActivityAt` forward would extend a
  session's monitoring window as a side effect of *looking* at it. `reconcileStatus` changes
  the status and nothing else, and never seeds an entry for a session this process does not
  otherwise hold. Because the cache converges, a later read that cannot reach the store still
  excludes a terminated session rather than resurrecting it.

### Changed

- **`"private": true` on `packages/mcp-mongodb`.** No observable API change: the package was
  never published, and this makes publishing it impossible rather than merely unintended.
- **`apps/api/tsconfig.test.json` sets `allowJs`.** Some release guards live in
  `scripts/release/*.mjs` and are tested from the API test tree; without this the import is a
  compile error and a guard's refusals go untested. `checkJs` stays off, so the JavaScript is
  inferred rather than type-checked.

## [0.4.0] - 2026-09-26

**Published as a GitHub pre-release** on 2026-09-26. Annotated tag `v0.4.0`, tag object
`78fdce26c517ee65cb2bf77fceb379306d36dc30`, target
`ed14728f9dfeaace841474b909ecfba15cd6feb3`. No npm package, no container image and no hosted
deployment were published, and nothing was marked stable or latest. This is an experimental
research system and is not production ready — see
[docs/release/v0.4.0-release-notes.md](docs/release/v0.4.0-release-notes.md) for what the
release does and does not claim.

The theme is **operability and read integrity**: structured logs and one request identifier
per request, a durable read fallback for session detail, one lifecycle vocabulary across the
four surfaces that answer for a session, exact per-component deletion reporting, and a
release-verification harness that runs every release-critical gate in one non-publishing
command. **No schema migration ships with this release.**

### Removed

- **`cleared` from the session status vocabulary.** It had no producer at all: nothing
  wrote it, `set_session_status` never accepted it, and the one "clear" behaviour the
  product has — lifting a lock when the score falls — writes `active`. So the historical
  meaning of `cleared` **is** `active`, and a document holding it now normalises to
  `active`. It was not given a producer, because doing that would mean inventing a human
  review workflow to justify an enum. Recorded in `docs/compatibility.md` §3.1.
- **`flagged` and `investigating` from every status union.** They are a review
  **disposition**, reported under `SessionReviewResponse.disposition`, not lifecycle
  states. `PERSISTED_SESSION_STATUSES` is now the same three values as the adapter's
  `SESSION_STATUSES`, so a session document has exactly one status vocabulary.

### Added

- **`npm run verify:backup` — a repeatable backup/restore drill.** It creates its own
  disposable `mongo:7` container, seeds a documented fixture (one **empty** collection, five
  non-empty ones, the critical indexes, a migration ledger), and walks the whole procedure:
  backup, restore into a scratch database, count verification, index verification, a tampered
  manifest, a non-empty target, and the same-source refusal. Every step is judged on the
  scripts' own output rather than on an exit code, because `mongorestore` exits **0** when it
  restores nothing.
- **Critical-index verification in the restore script.** A count comparison is blind to
  indexes, and `mongorestore` exits 0 whether or not it restored them — so a restore could
  come back with every document and none of the constraints, accepting duplicates the product
  forbids. The list lives in `scripts/release/critical-indexes.json`, and
  `apps/api/test/release/critical-indexes.test.ts` asserts it against a real store in **both**
  directions: every entry must exist, and the store must not create a unique index the list
  omits. The second direction immediately found one — `schema_migrations.migrationId`.
- **`npm run verify:image` — the stale-image defence.** The `v0.3.0` verification reused an
  **old container image**, because nothing compared what the image was built from against the
  source it was supposed to be built from. The image is now built `--no-cache`, tagged
  uniquely per run, and given its version and commit as build arguments that the `Dockerfile`
  bakes into labels and environment; the check compares those with the working tree **and**
  with the running container's `/health`, and asserts the metadata carries no secret. The
  provenance is in image labels rather than in `/health` on purpose: `/health` is public, and
  publishing the exact commit a deployment runs tells an attacker which build to look up.
- **The upgrade gate: a published release's database, migrated by this build.**
  `npm run test:migrations` seeds a database in the shape `v0.2.0` or `v0.3.0` left it and
  walks the documented upgrade against a **real MongoDB** — dry run, migrate, validate,
  re-run. It asserts that the dry run changes nothing, that the duplicate
  `riskAssessmentId` is removed, that the counter is renamed keeping the larger of two
  values, that the ledger records every migration, that the unique index can be built
  afterwards (the ordering only a real database can prove), that a second run is a no-op,
  and that the upgraded data is readable under its new field name.
- **`apps/api/test/support/release-fixture.ts`** — the historical shape of each published
  release, described **once** and derived from the release notes rather than from the code.
  `docs/development/failure-semantics.md` records that a hand-built migration test drifts
  from the state it claims to represent and keeps passing against a shape no deployment ever
  had; this is the answer to that.
- **`npm run verify:release` — the release verification harness.** One non-publishing entry
  point that runs every release-critical check in order and reports each one's outcome:
  build, typecheck, the test tree's typecheck, both test runs, the docs checker, the version
  and configuration censuses, the secret guards, and the Flutter analyze/format/test trio.
  `v0.3.0`'s verification was a session — a sequence of commands run by hand, with one gate
  verified against a **stale image** because nothing compared the image's version against
  its source. Every step is also its own npm script, so a maintainer runs the same thing.
  It **cannot publish**: `secret-guards` fails if `npm publish`, `git push`, `docker push`
  or `gh release create` appears anywhere under `scripts/release/`.
- **`npm run verify:version` — a version census.** The product version is declared in six
  places and nothing asserted they agreed. It now compares all six against `package.json`,
  and asserts the changelog has both an `## [Unreleased]` section and a section for the
  declared version.
- **`npm run verify:config` — a configuration census.** Every environment variable the code
  reads must be described in `configuration.md` and `.env.example`, and every one described
  must be read. Both directions were real problems: a documented variable that had been
  renamed, and a variable read whose name appeared in no table.
- **`npm run typecheck:tests` — a typecheck for the test tree.** `apps/api/tsconfig.json`
  excludes `test/`, which is right for emit and meant that **no test file was typechecked by
  anything**: `npm test` runs through `tsx`, which strips types without checking them. Six
  classes of drift were found the first time it ran, including a local response interface
  that disagreed with the response under test and a contract interface whose return type no
  longer described the store it exists to describe.
- **`.github/workflows/release-verification.yml`** — a manual, non-publishing release drill
  that runs the harness against a disposable `mongo:7` and asserts that nothing was skipped,
  because a drill whose integration step silently skipped verified less than it claims.
- **`docs/release/verification-harness.md`** — what the harness runs, how to run one step,
  why a skip is not a pass, why it can never publish, and what the two censuses found.
- **A repair path for a document holding a retired value.** `normalizeStatus` maps it onto
  `active`, so every transition is legal from it — but a compare-and-set predicate
  expressed in durable statuses would match nothing and report `SESSION_CONFLICT` on every
  attempt, leaving the session permanently un-terminable. The status write is therefore
  unconditional for such a document, and it repairs the field. Logged as
  `session.transition.repaired` with both the raw and the normalised value, because
  silently rewriting a stored field is worth knowing about.
- **A per-component report for session deletion.** A deletion cascades over three domain
  components — `session`, `telemetry`, `assessments` — and it can partly succeed. The
  response now names what was removed and what was not, on success and on failure alike.
- **`PARTIAL_DELETE`** (500) for a deletion that ran and only partly succeeded, with
  `retrySafe: true`. Deliberately distinct from `SESSION_STORE_UNAVAILABLE` (503), which
  means nothing was attempted: a client that treated the two alike would either retry an
  operation that never ran, or fail to retry one that half-ran.
- **`docs/development/read-model.md`** — the four surfaces that answer for one session, the
  three vocabularies (lifecycle status, review disposition, liveness) that must not be
  conflated, the shared durable reader, what must agree and what deliberately differs, and
  the six read-integrity defects that tracing them found.
- **`disposition` on the review detail response** — `flagged`, `investigating` or `none`.
  The derived review vocabulary now has its own field instead of overwriting the lifecycle
  status.
- **The durable counters on the review detail response** — `eventCount`, `pasteCount`,
  `tabSwitchCount`, `focusLossCount` (and its deprecated alias), `copyAttemptCount`,
  `peakRiskScore`, `startedAt`, `targetSystem`, and `timelineTruncated`. A client no longer
  has to count the capped `timeline` to get a total.
- **`apps/api/src/services/session-read-model.ts`** — one reader for every surface that
  answers from a durable session document.
- **A durable read fallback for `GET /api/v1/guardian/sessions/:id`.** The route read the
  two in-memory maps only, so immediately after a restart it answered `404` for a session
  that exists durably — and kept doing so until `GET /api/v1/guardian/sessions` was called,
  because that was the only path that rebuilt the registry. One session was `404` on this
  surface and `200` on the review surface, from the same process, at the same instant. The
  route now reads `sessionStore` (no persistence call), then the durable document, then the
  live registry alone.
- **`source` and `ephemeralStateAvailable` on the detail response.** `source` is
  `"memory"` or `"durable"`; `ephemeralStateAvailable` is `true` only when this process
  holds the session's reconstructed workspace and latest risk payload. A durable answer
  reports `currentCode` empty and `lastRiskPayload` null rather than inventing them, and
  the two flags say so. The numeric risk scores **are** durable and are reported.
- **One shared durable reader** for the live list and the detail fallback, so the two
  surfaces cannot report different counters for the same document.
- **`docs/development/operability-model.md`** — every request path mapped against nine
  operability columns (auth, request id, logs, dependencies, durable writes, response
  status, stable error code, degraded behaviour, fields that must never be logged), the
  design for structured logging and request correlation, the two-layer secret-redaction
  guarantee, and the operational-diagnostics and degraded-state matrices. §10 records
  which parts of the design are implemented, so the document cannot drift into describing
  a design as behaviour.
- **`docs/security/threat-model.md` §9 — the logging threat model.** What request metadata
  is recorded, the never-recorded list, the redaction guarantee and its honest limits, log
  injection and the incoming-request-id validation that prevents it, why the request id is
  not a security control, and why structured logs are not a compliance claim. Retention
  belongs to the deployer.
- **A dependency-free structured logger** — `apps/api/src/observability/`. Four levels,
  two formats (`pretty` for a terminal, `json` for a shipper), one line per HTTP request
  carrying the status, the latency, the matched route **template** and the stable error
  code, and per-step detail at `debug` for MCP calls and provider attempts. No external
  logging vendor and no OpenTelemetry.
- **`CERBERUS_LOG_LEVEL` and `CERBERUS_LOG_FORMAT`.** An explicitly set but unusable value
  is a startup `ConfigError`, not a silent fallback, for the same reason
  `SESSION_TTL_SECONDS` is: a typo in a logging control must not quietly change what is
  recorded.
- **One request/correlation id per request**, accepted from `X-Request-Id` only when it is
  at most 128 characters and uses `A-Z a-z 0-9 . _ : -`, echoed in both `X-Request-Id` and
  `X-Correlation-Id`, recorded on the request line, and returned in every error body's
  `correlationId`. A rejected id is replaced with a generated one rather than failing the
  request, which is why there is no `INVALID_REQUEST_ID` code.
- **`REFERENCE_NOT_FOUND`** (404) for a corpus delete that matched nothing, so a client can
  tell "already gone" from "the store did not answer" — the first is done, the second is a
  retry. Before this the route answered a bare 404 and left the distinction in prose.

### Changed

- **`SESSION_NOT_FOUND` is now returned by every surface that can report the condition**,
  not only by the transition boundary: the live detail route, session deletion, and both
  review routes. One condition, one code — a client no longer has to branch on message
  prose, which `api-errors.md` §1 says is not a contract.
- **The Hono development logger is gone.** It printed `METHOD path status - latency`
  without the correlation id and only in development mode, so it could not be joined to
  anything and left production with no request line at all. The structured request line
  replaces it in every mode.

### Fixed

- **A partial deletion was reported as a complete one.** `deleteSession` ran the session
  record, its telemetry and its assessments under one `Promise.all` and the tool reported
  only the session document's `deletedCount`, so a failed telemetry removal was
  indistinguishable from a clean delete. Worse, the session record was removed **first** —
  and it is what identifies the telemetry, so a failure orphaned `micro_events` and
  `risk_assessments` that no query could find. Each component is now attempted separately
  and reported separately, and the session record is removed **last** so a partial failure
  leaves the session identifiable and the deletion retryable.
- **The review detail reported `flagged` under `status`,** while the review *list* reported
  `active` for the same session — and the console's review panel treated `flagged` as
  `locked`, so a session scoring 52 was displayed as **LOCKED** while the dashboard displayed
  it as active. `status` now carries the lifecycle state under one vocabulary on every
  surface, and the derived value is the separate `disposition` field.
- **The durable `peakRiskScore` lagged by one batch.** The counters write ran *before* the
  analysis, so the peak it wrote was the previous batch's — and for a session whose last
  batch produced the highest score, the durable peak never recorded that score at all. The
  live list's restart recovery and the review surfaces read that field, so the lag showed up
  as the surfaces disagreeing about one session, and as `alertTriggered: false` after a
  restart for a session that scored 98. The peak is now written once the assessment is
  durable, so it never exceeds the evidence for it.
- **The review detail reported an empty `auditId`** for a document that holds only
  `matrixId`, while the live detail reported the matrix id for the same session.
- **The console re-derived its counters by counting `timeline`,** which is capped — so a
  session with more than the window's worth of events was under-reported on the review
  panel. It reads the server's durable totals now, and says when the timeline is truncated.
- **A session detail answered `404` for a session that exists, immediately after a
  restart.** Recorded as open item D4 in `state-transition-model.md` §5 and as a known
  limitation in the `v0.3.0` release notes; now closed. An unreachable store with nothing
  in memory is a `503 SESSION_STORE_UNAVAILABLE` rather than a `404`, because `404` would
  assert that a session does not exist — which a store that did not answer cannot establish.
- **A durable answer reported `liveness: "active"` for a session whose durable monitoring
  window had closed.** The fallback first derived liveness from the empty in-memory maps
  rather than from the durable activity instant — the same class of restart-dependent
  answer the fallback exists to remove. Found by this work's own test suite.
- **The detail route under-reported every counter for a session the registry held but
  `sessionStore` did not.** Its registry branch reported zero, so a session deployed before
  a restart reported `eventCount: 0` here while the live list reported the durable total.
  Both surfaces now read the durable document through one shared reader.
- **The documented `correlationId` promise was false for four of five route groups.**
  `index.ts` set one `X-Correlation-Id` per response while `routes/guardian.ts`,
  `routes/review.ts`, `routes/reference.ts` and `routes/auditor.ts` each minted their own
  `randomUUID()` per handler, so the value in the error body appeared in no header and in
  no log line an operator could key on — and `docs/api-errors.md` §2 said otherwise. One
  identifier per request now flows from the middleware through an `AsyncLocalStorage`
  context, so no service has to be handed one and none can invent one. Recorded in
  `operability-model.md` §4.
- **A log line can no longer carry a monitored workspace, a paste, a telemetry batch, a
  provider prompt or a credential.** The first implementation of the redactor classified
  keys only inside a nested object, so `logger.info("x", { currentCode: … })` — the shape
  every call site uses — emitted the workspace verbatim. Found by the logger's own suite;
  key classification now happens for every field.
- **Logging a large field is no longer quadratic.** A 200 KB field took **32 seconds**,
  because the private-key pattern scanned it quadratically with no match to stop it. The
  pattern phase is bounded, the PEM block is stripped by a linear scan, and the userinfo
  run in the connection-string pattern is bounded. Measured after the fix: 20 fields of
  200 KB each in well under two seconds.
- **The scenarios controller map is keyed on a server-generated value, not the request
  id.** Accepting a caller-supplied `X-Request-Id` would otherwise let two concurrent
  scenario requests collide in that map, so a cancel could abort the wrong generation.
- **Secrets can no longer reach a log through a dependency error.** Every configured
  secret is registered with the redactor at startup, and a `mongodb://user:pass@host` URI,
  a `Bearer` token, a PEM block or a provider-style key is replaced by pattern. Asserted
  by `apps/api/test/logging-secrets.test.ts`, which drives real requests at `debug`.

## [0.3.0] - 2026-09-26

**Published as a GitHub pre-release** on 2026-09-26. Annotated tag `v0.3.0`, tag object
`af22236626019352bddebe8798a659151af7ec4f`, target
`95b57836b4d879766ad94953323ce5811f50041a`. No npm package, no container image and no
hosted deployment were published, and nothing was marked stable or latest. This is an
experimental research system and is not production ready — see
[docs/release/v0.3.0-release-notes.md](docs/release/v0.3.0-release-notes.md) for what the
release does and does not claim.

The theme is **architecture integrity**: one canonical session transition boundary, explicit
partial-failure semantics, truthful domain vocabulary, concurrency-safe state mutation,
bounded read and write paths, and deterministic behaviour under retry, restart and
dependency failure. Two migrations ship with it — `0002` and `0003`.

### Added

- **The architecture-integrity checkpoint record** —
  `docs/development/architecture-integrity-checkpoint.md`. The merged changes, the twelve
  defects the cycle found and how each was found, the exit criteria with their state, the
  verification at the checkpoint, and what remains accepted.
- **`docs/release/v0.3.0-release-notes.md` and `docs/release/v0.3.0-checklist.md`.** The
  notes state the theme, the observable changes, the upgrade path and — plainly — what the
  release does not claim. The checklist records the gates to work through when authorising a
  release, and the results of each for this one.
- **`docs/api-errors.md` §11: the retry and idempotency contract for every mutation route.**
  Which are retry-safe, which are idempotent and on what key, which are non-idempotent, and
  which carry duplicate-spend risk. It records why **no `Idempotency-Key` was added** to the
  two paid routes — what a key would cost, what the evidence says, and the condition that
  would change the decision — rather than leaving the gap implicit.
- **The console words errors from the stable `code`, not the server's prose.**
  `docs/api-errors.md` §1 states the rule: a code is a contract, a message is not. The
  console used to show the server's `error` string verbatim, so its operator-facing wording
  depended on API prose that the compatibility policy explicitly does not freeze.
  `apps/console/lib/services/api_error_codes.dart` maps the 24 documented codes to the
  console's own text and falls back to the server's message for a code it does not know.

  For three codes — `INVALID_REFERENCE_DOCUMENT`, `INVALID_IDENTITY_FIELD` and
  `MISSING_EVENT_ID` — the server's message carries detail the console cannot supply (which
  field, which bound). For those it shows **its own lead sentence and then the server's
  detail**, so the console's framing does not depend on API prose *and* the operator still
  gets the specific field. Neither concern is traded away.

- **`npm run check:docs` — a documentation link and anchor checker, gated in CI.** Every
  relative link in every tracked `*.md` is resolved against the filesystem, and every
  in-repo `#anchor` against the target file's headings. `docs/` is a deliverable, and a
  cross-reference that points at a heading that was renamed is a broken promise that no test
  catches.

  It refuses to pass vacuously: a pathspec that matches nothing exits non-zero rather than
  reporting zero broken links over an empty set, and the file count is printed. That is not
  theoretical — the first version called `git ls-files '*.md'`, whose quotes do not survive
  every shell, and it reported a clean sweep over **zero** files.

  It also splits lines on `/\r?\n/` rather than `"\n"`, because a bare trailing `\r` makes
  `/^(#{1,6})\s+(.*)$/` fail to match — `.` does not match a line terminator — so the heading
  scan silently finds nothing and every anchor looks broken. Editing a file with a tool that
  writes CRLF produced exactly that, and four anchors were reported broken that were fine.
  A checker that lies is worse than no checker, which is why both cases are handled rather
  than worked around.

### Added

- **A real-MongoDB integration suite, and a bounded CI job that runs it.** The unit suite
  drives the real routes against an in-process double, and the contract suite verifies that
  double against a real store. Neither exercises the whole path at once: **real route → real
  tool registry → real MongoDB driver → real documents** — which is where every defect in
  this repository's history actually lived. A retry counted twice, a review reporting the
  oldest assessment, a terminated session resurrected by a later ingest: each was a
  real-database behaviour that a faithful-looking double agreed with the route about.

  `apps/api/test/integration/state-flows.test.ts` closes that gap without a network hop. It
  reuses the **real** `createToolRegistry()` over a real `MongoStore` on a disposable
  database, and presents it through the same `fetch`-stub seam the unit tests use — so an
  integration test is written exactly like a unit test and every layer below HTTP is
  production code. Eleven flows: create, ingest, retry the duplicate, restart; a retry after
  a restart; auto-lock writing its evidence before its status; final-risk ordering against
  the real sort; terminate preserving the workspace and staying irreversible; concurrent
  ingests; a duplicate event across concurrent batches; terminate racing auto-lock; the
  corpus ceiling; and the migrations and their indexes.

  The new `integration` CI job provides a `mongo:7` service and sets
  `CERBERUS_TEST_MONGODB_URI`, turning every skip into a run. It is **bounded** — a
  20-minute timeout — and it **asserts that nothing was skipped**, because a suite that
  silently skips is green for the wrong reason. The unit job still runs without a database,
  so a fast signal is preserved.

- **`runMigrations` makes the ledger idempotent.** A unique index on
  `schema_migrations.migrationId` is created before the first write, and a duplicate-key
  error on the ledger insert is treated as "another runner recorded this" rather than as a
  failure. Without it, two processes starting together both read a pending plan and both
  insert a row for the same migration, so the ledger stopped being a faithful account of
  what the database has been through — which is its whole purpose. A ledger write that fails
  for any other reason still surfaces.

  Two runners may still *execute* a migration concurrently. That is safe and deliberate:
  every migration is idempotent and fails before mutating, so the second execution is a
  no-op rather than a second rewrite. Making execution exclusive needs a claim protocol and
  a lease, and the evidence does not require one — the documented deployment is one API and
  one adapter on one database.

- **Terminal content has one owner, and the API writes it.**
  `update_session_terminal_content` is a published MCP capability that **no route called**,
  so `monitored_sessions.terminalContent` was always absent. The review path therefore
  recovered the workspace from a chain of three sources with no rule about which won:
  the (empty) owner, the in-memory `currentCode` that a restart loses, and the newest
  assessment's `codeSnapshot`.

  **The API now adopts the capability**, and the three sources stop competing:

  | Source | What it is | Role |
  | --- | --- | --- |
  | `monitored_sessions.terminalContent` | the workspace as monitoring ended | **the owner**, written once by `terminate` |
  | the in-memory `currentCode` | this process's live reconstruction | fallback for a session still running |
  | `risk_assessments.codeSnapshot` | the workspace **when that assessment ran** | fallback for a session terminated before terminal content was written at all |

  Those are three different facts, not three copies of one, and the order now says so. A
  session terminated by this build always has `terminalContent` written, so the third
  fallback is unreachable for it.

  The preservation is **best effort**: a failure is logged and the termination proceeds,
  because an operator must be able to end monitoring even when the store is unhappy — the
  telemetry and the assessments are already durable, and the review path still falls back.
  The capability is **not** deprecated and **not** removed: an external MCP client may still
  call it directly, and a test asserts that.

- **`get_session_review` gained an optional `assessmentsLimit`**, and `getRiskAssessments`
  an optional `limit`. Assessments are already sorted newest-first, so `assessmentsLimit: 1`
  is "the latest assessment" — which is what preserving the terminal workspace needs, rather
  than the session's whole analysis history. Both default to the previous unbounded
  behaviour, so no existing caller changes.

- **The reference-corpus ceiling is now enforced at the store.** It was a **read**
  ceiling only: `listReferenceDocuments` returns at most `MAX_REFERENCE_DOCUMENTS`, so a
  201st document was accepted, stored, and then neither listed nor compared against. The
  operator saw a successful add; detection saw nothing. A create past the ceiling is now
  refused with `409 REFERENCE_CORPUS_LIMIT_REACHED`, and the API and the console agree on
  the number (`mcp-tool-mapping.test.ts` asserts the API's constant equals the adapter's,
  and the console's own test asserts its copy is 200).

  It is enforced with an **atomic conditional `$inc`** on a single counter document
  (`reference_corpus_meta`), not with a count-then-insert: two concurrent creates at one
  below the limit would both read the same count and both insert, reaching 201. The
  counter is raised from the real document count before each claim, so one left behind by
  a restore or a write that bypassed the API self-heals rather than letting the corpus
  grow past its ceiling; and it is *never lowered* during a claim, because between a claim
  and its insert it is legitimately ahead of the collection — lowering it there would
  discard the reservation and hand the same slot out twice. It is reconciled exactly once,
  at `connect()`, where nothing can be in flight, which is what reclaims a reservation
  leaked by a process that died mid-claim.

  **Updating an existing document is always allowed, at any size** — an update does not
  grow the corpus, so the ceiling must not block correcting a document in a full corpus.
  Deleting a document releases its slot; deleting an unknown id does not.

- **The MCP adapter's error `code` reaches the API.** `callMcpTool` used to drain a
  non-2xx body and reduce it to `"HTTP 409"`, so a specific refusal was indistinguishable
  from an outage — which is why a full corpus surfaced as `503
  REFERENCE_STORE_UNAVAILABLE`, telling the operator to retry something that would never
  succeed. `McpCallResult` now carries `code`, parsed best-effort from the adapter's
  error body. A new `ReferenceCorpusLimitToolError` maps to `409` in the adapter, and the
  shared test double mirrors that mapping — a gap the new tests caught.

- **Durable risk-assessment identity, so the paid analysis path stores one row per
  incident.** `risk_assessments` gained a unique index on `riskAssessmentId` and
  `MongoStore.storeRiskAssessment` is now idempotent on it: a second store of the same
  id reports `inserted: false` and creates nothing. Before this it was a plain insert
  with no index, so a re-analysis after a restart wrote a **second row for one
  incident** — inflating `riskSummary` on the review surface and double-counting in the
  auditor. The module header of `guardian.ts` had described this dedup layer as
  implemented when it was not; the claim is now true.

  The duplicate-key path is handled rather than pre-checked, because a read-then-insert
  would race: two concurrent analyses of one incident would both see nothing and both
  insert. The unique index is the arbiter, and the duplicate-key error is the *expected*
  outcome of a retry. `isDuplicateKeyError` classifies it from the driver's error code
  rather than by matching a message.

- **Migration `0002-dedupe-risk-assessment-identity`**, which removes pre-existing
  duplicate assessments so the unique index can be created — the same ordering
  constraint as `0001`: migrations run before indexes, because the index cannot be
  created while duplicates exist and the failure would be an opaque duplicate-key error
  at startup rather than a repair. Two copies that disagree on anything but `_id` and
  `_generatedAt` are **not** duplicates: the migration refuses, names the ids and
  deletes nothing. `classifyDuplicateGroups` gained an `ignoredFields` parameter so the
  volatile field can differ by collection — `_ingestedAt` for an event, `_generatedAt`
  for an assessment — because passing the wrong one turns a repairable duplicate into a
  refusal.

- **Two response fields that say whether a step actually succeeded.** Both were
  previously indistinguishable from success:
  - `telemetryPersisted` — whether the persistence layer answered for the events
    write. When it is `false`, **`acceptedCount` and `duplicateCount` are omitted**,
    because a number the server knows is unverified is worse than no number. A failed
    events write used to return `acceptedCount: <batch size>` and `duplicateCount: 0`,
    which is byte-for-byte what a fully successful ingest returns. `processedCount`
    keeps its meaning — the batch size the caller sent — so nothing is lost.
  - `assessmentPersisted` — whether the `riskPayload` in the response is durable.
    Absent when no analysis ran. `false` means the paid analysis completed and its
    persistence did not, so the payload exists only in the response body and in this
    process's memory.

  Both are additive. `apps/api/src/routes/guardian.ts` also tracks
  `lastRiskPayloadStored` in memory, so the code-hash dedup branch reports the reused
  payload truthfully instead of claiming a stored assessment for one whose write
  failed.

- **A central session transition boundary** — `apps/api/src/services/session-transition.ts`
  — so a session lifecycle status changes in exactly one place. Status was previously
  written by five paths (deploy, ingest's auto-lock, ingest's auto-clear, reactivate,
  terminate) that ordered their cache and durable writes **three different ways**,
  three of which did not inspect the durable write's result, and none of which
  validated the current status.

  The callers are domain actions rather than a generic `setStatus` — `terminate`,
  `autoLock`, `autoClear`, `reactivate`, `updateTerminalContent` — and the legal
  transitions are an explicit table. Every action follows one order: **read the durable
  document → validate against the table → write durably with a predicate on the status
  that was read → repair the caches from the durable outcome.** The result distinguishes
  *applied*, *already in that state* (a legal no-op), *refused* and *conflict*, so a
  route never has to guess what happened.
- `apps/api/src/services/session-status.ts` — the status vocabulary in one place,
  naming three sets that were previously spread across two modules: the **durable**
  set the store can hold (`active`, `locked`, `terminated`), the **persisted** set
  `normalizeStatus` maps onto (which additionally carries the derived `flagged`,
  `investigating` and `cleared`), and the derived set itself, which is never written.
  It also owns the stable transition codes and their HTTP statuses. `guardian.ts`
  re-exports every name, so existing importers are unaffected.
- `docs/api-errors.md` — the census of stable client-facing error codes, with the HTTP
  status and the client-actionable meaning of each, and an explicit statement of what
  is deliberately *not* exposed.

- `docs/development/state-transition-model.md` — every session lifecycle mutation
  mapped from the source: its initiator, precondition, durable source of truth,
  cache writes, write ordering, side effects, AI involvement, retry and
  idempotency behaviour, terminal behaviour, failure behaviour, restart behaviour
  and concurrency behaviour. It also states the explicit transition table, and
  records the transitions the code performs that the model forbids.
- `docs/development/failure-semantics.md` — what every multi-step operation
  guarantees when one of its steps fails, window by window: DB-succeeds-cache-fails,
  cache-changes-DB-fails, provider-succeeds-persistence-fails, process death
  between writes, a response lost after durable success, an optional notification
  failure, and a retry arriving after an ambiguous response. It states plainly which
  guarantees the system can make and which it cannot.
- `docs/development/test-double-contract.md` — a contract matrix comparing every
  in-process store double against the real `MongoStore`, the three divergences that
  let real defects through, and the plan for one shared faithful double plus a
  contract suite that runs against both it and a real MongoDB.
- `apps/api/test/support/mcp-store-double.ts` — **one faithful in-process double**
  for the MCP persistence layer, replacing four independent reimplementations that
  each disagreed with `MongoStore` in a different way. It implements the `MongoStore`
  *method* surface and the real `createToolRegistry()` wraps it, so tool-name
  mapping, argument validation, the `SESSION_STATUSES` check, the bounded-string and
  bounded-tag rules and every response shape are the production implementations;
  counters go through the real `buildSessionCountsUpdate()`, so `$max` monotonicity
  and the "set `status` only when supplied" rule are the real rules rather than a
  spread-merge that looks similar. It also reproduces the adapter's error mapping —
  404 for an unknown tool, 400 for `ToolArgumentError`, 500 otherwise — so a route's
  behaviour on an adapter *rejection* is reachable for the first time.
- `apps/api/test/store-contract.test.ts` — **37 named contract cases run twice**:
  against the shared double always, and against a real `MongoStore` when
  `CERBERUS_TEST_MONGODB_URI` is set. Sort order, the 500-event read cap, uniqueness,
  upsert, `$setOnInsert`, `$max`, duplicate-key behaviour, timestamps, missing
  fields, newest-first ordering, projections and cascade deletion. When the variable
  is unset the real half is skipped **with a stated reason** rather than silently
  passing. The suite also carries a fidelity guard asserting that every store method
  the tool registry calls exists on both `MongoStore.prototype` and the double, so a
  missing or renamed method is loud rather than surfacing only when a route happens
  to call it. One case deliberately **characterises** the missing assessment identity
  rather than endorsing it, so the fix cannot land silently.

### Fixed
- **The backup script failed on any database with an empty collection, and recorded a
  vacuous manifest.** Two defects, both found by running the documented backup/restore drill
  against a real database rather than by reading the script.

  First: `mongodump` writes a **0-byte** `.bson` file for a collection that exists and holds
  zero documents, and the script treated *any* 0-byte file as an incomplete backup. So
  `npm run backup` **failed on a perfectly healthy deployment** whose `risk_assessments` or
  `threat_scenarios` were still empty — which is every fresh deployment, until an analysis
  runs or a scenario is authored. The check is now **count-aware**: a 0-byte file for a
  collection holding 0 documents is correct, a 0-byte file for one holding documents is
  still a failure, and a collection holding documents that produced **no dump file at all**
  is now a failure too. The document counts are read before the dump is judged, because file
  size alone cannot tell the two cases apart.

  Second, and worse: the count script embedded a `"`, which Windows PowerShell 5.1 mangles
  when passing it to `docker exec`. mongosh received a truncated script, printed a
  `SyntaxError`, and the manifest recorded **0 documents for every collection** while the
  backup itself was fine. That is worse than no manifest — the restore compares restored
  counts against the manifest, so an empty manifest makes the comparison **vacuous**, and a
  restore that brought back nothing would have been reported as verified. The count script
  no longer contains a quote (mongosh's `print` joins its arguments with a space, so none is
  needed), and the backup now **fails loudly if the count read produces nothing**, so no
  future variant of the same problem can produce a vacuous manifest.

  Verified end to end against a real MongoDB: backup of a 207-document database across 7
  collections with two of them empty, restore into a scratch database with every count
  matching, the unique identity indexes restored, a tampered manifest refused with exit 1,
  and each of the three documented refusals (no manifest, restore over the source, non-empty
  target without `-Drop`) stopping with exit 1.

- **The console described the retired corpus-ceiling behaviour.** The corpus panel told the
  operator, at capacity: *"Only the 200 most recently updated documents are listed and
  compared, so a new one would be stored but never read."* That was true when the ceiling was
  a **read** ceiling and is false now: the store refuses the create outright with
  `409 REFERENCE_CORPUS_LIMIT_REACHED`, so nothing is stored and nothing is silently excluded
  from comparison.

  The browser QA pass caught it the same way it caught the identity claim — by rendering the
  panel at capacity against a real corpus and reading what it said. The notice now states the
  server's actual behaviour, names the stable code an operator can search for, and adds the
  fact that **updating an existing document is still allowed** at the ceiling.

  Two supporting comments (`reference_document.dart`, `reference_corpus_provider.dart`) that
  still described the ceiling as read-only are corrected, the test that encoded the old
  semantics is renamed, and a new widget test asserts the notice contains none of the retired
  wording and does state the real behaviour.


- **The console claimed an identity integration it does not have.** The operator identity
  gate carried the line *"Production deployments integrate with Google Cloud Identity
  Platform."* That was **false** and it was operator-facing: Cerberus has no identity
  provider, no sign-in, no roles and no per-user attribution, and accounts/RBAC/tenancy are
  an explicit owner decision to stay out of scope. It described a capability that does not
  exist, in text an operator reads.

  The browser QA pass for this release is what caught it — no test could, because nothing
  asserted what the console must *not* claim. The footnote now states what is true: the
  label is ephemeral, it is not an account, and there is no sign-in, no roles and no
  per-user attribution. Two code comments that implied a third-party identity flow was
  merely pending are corrected to match the owner decision.

  `apps/console/test/release_claims_test.dart` asserts the gate claims none of a list of
  forbidden phrases and does state the truthful posture, so a screenshot is no longer the
  only thing standing between this claim and a release.

- **The risk-notification surface had no test coverage.** The behaviour-context grid is
  where the renamed focus-loss counter is displayed, and it is only reachable when an
  analysis produces a payload — so the browser QA pass could not reach it without driving a
  paid provider. A widget test now renders it directly and asserts the label reads **Focus
  Loss** and not the deprecated **Fullscreen Exit**, that the value it was given is shown,
  and that it renders without overflow at a narrow width.

### Fixed

- **Four console files were not `dart format` clean.** `flutter analyze` does not check
  formatting, and the Flutter CI job ran `analyze` and `test` but not `format` — so a gate
  the release checklist names was documented but never enforced. Four files reached a release
  candidate unformatted, two of them edited through a tool that writes CRLF, which the
  formatter rewrites. They are formatted, and **`dart format --output=none
  --set-exit-if-changed .` is now a CI step**, so the documented gate is real rather than
  aspirational. Formatting only: no semantic change.

### Changed

- **The review-list read is bounded by the number of sessions, not by their history.**
  `GET /api/v1/sessions` issues one `get_session_review` per session, and each one asked for
  the default: **up to 500 micro-events plus every risk assessment**. With 20 sessions
  holding 500 events that is **10 000 event documents** fetched and discarded per list
  request, and the work grew with each session's history rather than with the number of
  sessions.

  Nothing in those events was load-bearing. Every counter the route re-derived from them is
  **already durable on the session document** — written on every ingest with `$max`, so
  monotonic and hydrated across a restart. The read now asks for `eventsLimit: 0` (the query
  is skipped outright) and `assessmentsLimit: 1`, because a single `riskScore` needs only the
  newest assessment. **Event documents carried: 10 000 → 0. Assessments: 60 → 20.**

  `lastEventTimestamp` was the newest **client-supplied** event timestamp, read from the
  window the route no longer fetches. It is now the durable, server-written `updatedAt` —
  the same instant from a trustworthy source, and the value the liveness decision already
  uses for exactly that reason. Reporting a client-supplied timestamp while refusing to
  trust it for expiry was a quiet inconsistency.

  The **detail** route is unchanged: it exists to show the timeline, so it keeps the
  documented 500-event read, which is a bound rather than an amplification because it is one
  request for one session. A test asserts that the bound was not applied to it.

  See [performance-baseline.md](docs/development/performance-baseline.md#the-review-list-read-before-and-after).


- **The focus-loss counter is named for what it measures.** `applyEventToSession` treated
  `WINDOW_BLUR` and `FULLSCREEN_EXIT` identically and incremented one counter, which was
  called `fullscreenExitCount` — so the field name described **one of the two events that
  produced it**: a window blur that was never a fullscreen exit was counted as one, and the
  incident summary said "fullscreen exit detected" for what may have been a blur. Browser
  telemetry cannot distinguish the two, so the counter has always measured *focus loss*.

  The canonical name is now `focusLossCount`, and migration
  `0003-rename-fullscreen-exit-to-focus-loss` renames the durable field. **No score moves:**
  the penalty was gated on `count > 0`, which is "focus was lost", never on "fullscreen was
  exited" — so this corrects a name rather than a behaviour. A test asserts that a blur and
  a fullscreen exit score identically, because a silent scoring change would be the worst
  possible outcome of a rename.

  The old names are kept where they are cheap and where a caller may depend on them:

  | Surface | Canonical | Deprecated alias, same value |
  | --- | --- | --- |
  | Session detail and both list responses | `focusLossCount` | `fullscreenExitCount` |
  | `update_session_counts` argument | `focusLossCount` | `fullscreenExitCount` |
  | `behavioralContext` in a risk assessment | `totalFocusLosses` | `totalFullscreenExits` |
  | The durable field | `focusLossCount` | read as a fallback for an un-migrated document |

  `update_session_counts` maps both spellings to **one** durable field, so the two names
  cannot become two counters that drift; when both are supplied the larger wins, so a caller
  mid-migration cannot lower the total. The `list_sessions` projection carries both, because
  a document written before the migration still holds the legacy field and projecting only
  the canonical name would report zero for it. The console reads the truthful name and falls
  back to the old one, and its panel now says **Focus Loss** rather than Fullscreen Exit.

- **The incident summary says "focus lost"** rather than "fullscreen exit detected", for the
  same reason.


- `POST /api/v1/guardian/sessions/:sessionId/terminate` now returns **`503`** when the
  persistence layer cannot be reached, instead of the previous `404` — which reported
  "not found" for a session that exists. It returns `409 SESSION_CONFLICT` when the
  status changed while the transition was being applied, instead of silently
  overwriting the change.
- `GET /api/v1/guardian/sessions` excludes terminated sessions from all three of its
  paths, not just the registry write of one.
- `terminate` now writes the durable status **before** touching either cache. The
  cache used to be mutated first, so a failed durable write still returned
  `200 success: true` and a restart resurrected the session.

- **`get_session_review` gained two optional arguments, and the API now uses them.**
  It returns up to 500 micro-events plus every risk assessment by default, and
  `POST /api/v1/guardian/ingest` — which consults **only the session document** — was
  paying for all of it on every request and discarding it. The console sends one
  event per request, so that was a read cost proportional to a session's whole
  history, paid per event. Two additive arguments bound it:
  - `eventsLimit` — how many recent events to return; `0` **skips the query**
    entirely, because MongoDB's `.limit(0)` means "no limit" and passing `0` down
    would return the entire collection;
  - `includeAssessments` — `false` skips the assessment query.

  Both default to the previous behaviour, so every existing caller is unaffected.
  Ingest and reactivate now pass `eventsLimit: 0, includeAssessments: false`. This is
  the "adding an optional field is cheap preservation" case from
  [compatibility.md](docs/compatibility.md) §2, so nothing breaks and no migration is
  needed.
- **`set_session_status` gained an optional `expectedStatuses` argument**, making the
  write a compare-and-set: the update applies only while the stored status is one of
  the listed values, so a transition that lost a race reports `updated: false`
  instead of silently overwriting the winner. Omitted, the behaviour is unchanged —
  an unconditional `$set`. An empty array is treated as *no predicate*, not "match
  nothing", because an empty `$in` matches nothing and would turn a caller's empty
  list into a silent no-op.

  This is the primitive the central transition boundary needs in order to close the
  last-writer-wins race recorded in
  [state-transition-model.md](docs/development/state-transition-model.md) §3.2 (D7).
  The routes do not use it yet; they adopt it with the boundary. A single-document
  predicate is sufficient and needs no replica set, so the documented single-node
  deployment is unaffected.
- `installFetchStub` accepts a full `Response` from its `mcpResponse` responder, so
  the MCP adapter's status codes are reachable from a route test. A plain object
  keeps the historical HTTP 200 behaviour, so every existing caller is unaffected.
- `apps/api/test/session-lifecycle.test.ts`, `session-durability.test.ts`,
  `event-idempotency.test.ts` and `reference-corpus.test.ts` now use the shared
  double; their four local doubles are deleted. `session-durability.test.ts` is the
  significant one: its double returned `{success: true, updated: true}` from
  `set_session_status` **without persisting anything**, so it could not observe a
  status write at all — which is why the confirmed P1 below survived a 481-test
  suite. That defect is now observable from the same suite, and its regression test
  lands with the fix.
- `mongodb` is added to `apps/api` devDependencies for the disposable-database
  cleanup in the real-store half of the contract suite. The lockfile change is one
  line.

### Fixed

- **The ingest write order put side effects before durable evidence.** The risk
  assessment was written **last** — after the notification and the status change — so a
  process death in that window left a durably `locked` session with a delivered alert
  and **no recorded justification**. The order is now: paid analysis → paid
  recommendation → **assessment write** → status transition → notification.

  If the assessment write fails, the status is deliberately **not** changed and no
  notification is sent: a lock whose justification was never recorded is exactly the
  failure this ordering exists to prevent, and an alert describing an incident with no
  review record is worse than no alert. Telemetry is unaffected — it is already durable,
  and the next batch with a changed workspace retries the whole path.
- **A failed delete was reported as a successful one.** `DELETE
  /api/v1/guardian/sessions/:id` cleared the caches first and consulted the durable
  result only to compute `deleted`, so an unreachable store returned
  `200 success: true` for a session that was still there — and a restart brought it
  back. It also returned `404 "not found"` for a session that exists, a different wrong
  answer to the same failure. The durable deletion is now attempted first; a store that
  does not answer is `503 SESSION_STORE_UNAVAILABLE` and nothing is changed.
- **P1 — a terminated session is not terminal.** `POST /api/v1/guardian/ingest`
  checked only whether the session's monitoring window had expired, never its status,
  and `lockSession()` had no precondition either. A `terminated` session that had not
  yet exceeded `SESSION_TTL_SECONDS` therefore accepted telemetry, advanced its durable
  counters, and — on a high-risk batch — was moved to `locked`: a state the operator
  never chose, on a session they had explicitly stopped. `reactivate` already refused
  exactly that transition, so the two paths disagreed about whether `terminated` was
  reversible. Ingest now refuses a terminated session with
  `409 SESSION_TERMINATED`, before any write, and stores nothing.
- **A terminated session was still returned by the live session list.** The TTL
  predicate was the only filter on the in-memory path, and the durable-recovery path
  guarded only the *registry* write, not the list entry — so a terminated session
  appeared in `GET /api/v1/guardian/sessions` with `liveness: "active"` until its TTL
  elapsed or the process restarted. All three paths now exclude it, and it remains
  fully visible through the review surfaces, which is where it belongs.
- **A refused transition no longer leaves a stale cache behind.** A refusal that read
  the durable status reconciles the cache to the value it read, so a status that
  diverged because another writer moved it is corrected rather than reported. A refusal
  still never changes the durable status and never applies the requested change.
- **`set_session_status` result is now inspected on every path.** Auto-lock,
  auto-clear and terminate previously wrote the cache first and ignored whether the
  durable write matched, so a failed write returned `200 success: true` while MongoDB
  held the old status — invisible until a restart, at which point the change vanished.

- **A brittle source-text assertion in `persistence-naming.test.ts`** matched the
  exact `setSessionStatus` signature and sliced a fixed 300-character window from it.
  Adding an optional parameter both broke the match and shortened the window, so a
  signature change could have silently moved the assertions off the method body they
  were meant to check. It now locates the method body and asserts what the test is
  actually about — that `setSessionStatus` deletes nothing and writes exactly the
  status and `updatedAt`.

- **Documentation:** `apps/api/src/routes/guardian.ts` listed four deduplication
  layers in its module header; layer 1 — "identical risk-assessment id from the AI
  provider" — **is not implemented**. Nothing in the ingest path reads
  `riskAssessmentId` for comparison, and `risk_assessments` carries no unique index
  on it, so a retry after a restart can write a second assessment row for one
  incident. The false claim is removed from the header, which now lists the three
  layers that exist and records the missing one as open work, and the finding is
  documented in `docs/development/failure-semantics.md` §3.9. Implementing the
  durable assessment identity is queued.

### Verified

- The transition table is exercised through the real routes: every allowed transition,
  every disallowed one, a repeated transition, the terminal state, restart, a stale
  cache versus a newer durable document, and four concurrency cases with deterministic
  interleaving rather than sleeps.
- 604 tests pass against a real **MongoDB 7** (0 skipped, 0 failed), and 565 without it
  (564 pass, 1 skipped — the real-store half of the contract suite, with its reason).

- The contract suite was run twice on the same commit. Without
  `CERBERUS_TEST_MONGODB_URI`: 512 API tests, 511 pass, 1 skipped (the real half,
  with its reason). With it pointed at a real MongoDB 7: **546 tests, 546 pass,
  0 skipped, 0 failed**. All 37 contract cases pass against both implementations, so
  the double is *verified* faithful to the real store for every asserted property
  rather than asserted to be — which is what the four doubles it replaces relied on.

### Recorded findings (not yet fixed)

These were found by tracing the source for the documents above, and each is
reproduced or traced rather than inferred. They are listed here so the change that
fixes one can reference it. Five of the original six — the P1 above, the
last-writer-wins status race, the uninspected status-write result, the undisclosed
failed events write, and the assessment-after-side-effects order — are now fixed and
are described under `Fixed`.

- **P2 — `GET /api/v1/guardian/sessions/:sessionId` has no durable fallback.** It
  reads the two in-memory maps only, so immediately after a restart it answers `404`
  for a session that exists until something calls the live list, which is the path
  that rebuilds the registry. The review route is durable and is unaffected.
- **P2 — the risk assessment write is not idempotent.** `storeRiskAssessment` is a
  plain insert with no unique index on `riskAssessmentId` and no dedup in the route, so
  a re-analysis after a restart writes a second row for one incident. The contract
  suite **characterises** this rather than endorsing it, so the fix cannot land
  silently.

## [0.2.0] - 2026-09-25

**Published as a GitHub pre-release.** Annotated tag `v0.2.0`, tag object
`c987767494f4d1c624005f6f498334e658d2c1bc`, peeling to release target
`a355f310eefb5345ddafe8af53cfec805eb21c64`. No npm package, no container image and no
hosted deployment were published, and nothing was marked stable or latest. This is an
experimental research system and is not production ready — see
[docs/release/v0.2.0-release-notes.md](docs/release/v0.2.0-release-notes.md) for what
the release does and does not claim.

### Added

- **The console can manage the reference corpus.** It had no surface for it at all —
  a search for "reference" under `apps/console/lib` returned nothing — so populating
  the corpus meant hand-writing `curl`. That stopped being defensible once the corpus
  became load-bearing: with nothing in it, `findSimilarityMatches` always returns
  nothing, so an operator who never populated it would see an empty match set and
  could read that as "nothing leaked". A dashboard panel now lists, adds and removes
  documents, validates against the API's own limits before sending, and states two
  things rather than leaving them to be inferred: **Cerberus never populates the
  corpus itself**, and a match is evidence about phrasing rather than about copying.
  The assessment and the reasoning are in
  `docs/operations/corpus-management.md`.
- `docs/migration-v0.1-to-v0.2.md`: what changed between the two versions, which two
  changes require action (the unique index needing a migration, and events without an
  `eventId` now being rejected), and how to verify the upgrade.
- `docs/release/v0.2.0-release-notes.md` and `docs/release/v0.2.0-checklist.md`.
  The notes state the theme, the breaking changes, the upgrade path, and — plainly —
  what the release does not claim. The checklist records the gates that were run for
  the release and their results.
- `npm run bench`, and `docs/development/performance-baseline.md`. The benchmark
  drives the compiled API in process through `app.request()` with the persistence
  layer and AI provider stubbed, so it is reproducible anywhere with no MongoDB, no
  network and no paid inference, and a regression is attributable to this code
  rather than to a container's warm-up. Every case warms up before sampling, and
  latencies are reported as p50/p95/p99 because request latency is right-skewed and
  a mean hides the tail.
  It found two real defects, both the same shape — work proportional to how much a
  session already holds:
  - **Ingest cost grows linearly with the events a session already holds.**
    Throughput falls from 2 263 req/s against an empty session to 78 req/s against
    one holding 5 000 events, and p50 rises from 0.44 ms to 11.53 ms. A 5 000-event
    session is an ordinary day of telemetry, and the console sends one event per
    request.
  - **In-memory session state has no per-session cap.** About 1.4 KiB per event held
    in memory; `MAX_EVENTS_PER_BATCH` bounds one request, not a session's lifetime.
  Neither is visible from a throughput figure taken on a fresh database, which is
  why the scaling case exists.

  **Correction.** The first of those two was wrong, and the document now says so.
  The benchmark's own MCP double returned *every* event from `get_session_review`,
  while the real store caps that at 500 (`MongoStore.getSessionEvents`,
  `limit ?? 500`) — so the double re-serialised a growing array on every ingest and
  the growth was attributed to the application. With a faithful double the scaling
  table **plateaus** at ~700 req/s from 500 events onward. The memory figure was
  similarly contaminated: the double's own event log shares the process heap, so the
  memory case now uses a stub that retains nothing. Both bounds are explicit in the
  script with comments saying why. This is the third time in this repository that a
  double which did not match the real store produced a false conclusion, and the
  document records it as a pattern rather than quietly deleting the finding.
- `scripts/backup-cerberus.ps1` and `scripts/restore-cerberus.ps1`, plus
  `npm run backup` and `npm run restore`. Cerberus still has no backup mechanism of
  its own — it writes to MongoDB, so the mechanism is MongoDB's — but an unverified
  backup is a guess, so the scripts make one verifiable. The backup dumps, counts
  every collection, writes a manifest beside the dump, and **fails if any collection
  dumped to 0 bytes**. The restore restores into a scratch database by default,
  **refuses to restore over the source** without `-AllowSameDatabase`, **refuses a
  non-empty target** without `-Drop`, and **compares the restored counts against the
  manifest**.
  That last check is the one that matters: `mongorestore` exits **0** when it
  restores nothing — point it at the wrong directory level and it prints
  `don't know what to do with file ..., skipping` for every collection, reports
  `0 document(s) restored successfully`, and succeeds. An exit-code check would pass
  while the deployment came back empty. Verified by tampering with a manifest to
  claim 99 documents in a collection holding 3: the restore reports
  `FAIL micro_events expected 99 got 3` and exits 1.
- `docs/operations/backup-restore.md`: what to back up (including
  `schema_migrations`, which is easy to overlook and makes the runner re-apply
  migrations if omitted), what is deliberately **not** backed up (configuration and
  secrets — the manifest records the source rather than the connection string,
  which can carry a password), the end-to-end drill, and the gaps this does not
  close: no scheduling, no point-in-time recovery, no off-host storage, no
  encryption, no retention.
- `GET /ready`, and a real split between liveness and readiness. `/health` is
  **liveness**: it checks nothing and always answers `200`, so a dependency outage
  cannot make an orchestrator restart a healthy process in a loop. `/ready` is
  **readiness**: it asks the persistence layer, answers `200` or `503`, and is what a
  load balancer should use to stop routing traffic without killing the instance.
  The MCP adapter exposes the same pair, where `/ready` pings MongoDB. Before this,
  `/health` returned `healthy` unconditionally — a deployment whose sidecar was down
  reported itself healthy and kept accepting telemetry it could not persist.
  The readiness probe is cached for two seconds and concurrent probes share one
  in-flight check, so being watched closely does not add load in proportion to how
  closely it is watched. It always answers: a dependency that throws, hangs or
  returns nonsense is reported as `down`, never as a `500`, and each check has its
  own deadline. `docs/operations/health-probes.md` records which endpoint belongs in
  each probe slot, and the `Dockerfile` and `docker-compose.yml` now probe `/ready`.
- A schema and data migration framework
  (`packages/mcp-mongodb/src/migrations.ts`): ordered and append-only, idempotent,
  failing **before** it mutates, and recording what it did in a `schema_migrations`
  ledger. There are no down-migrations — reversing a data migration would be a
  fiction, since the removed documents are gone.
- `npm run migrate` and `npm run migrate:dry-run`. The dry run prints the plan,
  marking migrations that rewrite data, and changes nothing — it does not even read
  the telemetry collections.
- Migration `0001-dedupe-micro-event-identity`. The pre-fix ingestion path wrote
  every event in a retried batch, so a database that ran it holds duplicate
  `micro_events` documents — and the unique index on `(sessionId, eventId)` cannot
  be created over duplicates. Without this migration such a deployment would fail to
  start with an opaque duplicate-key error. The migration removes only copies that
  are otherwise **identical**, and refuses — having written nothing — when a pair's
  copies disagree, naming the pairs, because removing either version would destroy
  data.
- Migrations run **before** index creation, and the order is load-bearing: the
  unique identity index cannot be built over duplicates, so creating indexes first
  would turn a repairable database into one that will not start.
  `MongoStore.connect()` now applies migrations then indexes, and accepts
  `{ migrate: false }` for the CLI.
- `docs/operations/upgrade.md`: back up, read the plan, apply, restart, confirm —
  plus what to do when a migration refuses to run, why there are no
  down-migrations, and why the MCP adapter starts before the API.
- In-process rate limiting: token buckets, one per route category, applied
  **after** authentication. A refused request is `429` with code `RATE_LIMITED`, a
  `Retry-After` header, and `X-RateLimit-Limit` / `X-RateLimit-Remaining` on every
  response. `CERBERUS_AI_REQUESTS_PER_MINUTE` (default 10) caps the AI-backed
  endpoints, which are the ones that spend money; `ingest`, `mutation` and `read`
  have documented fixed ceilings, and `GET /health`, `GET /ready` and `GET /` are
  exempt because a rate-limited probe looks like a dead service.
  `CERBERUS_RATE_LIMIT_ENABLED` turns it off, and an unrecognised value for it is a
  startup error rather than a silent `false`, so a typo cannot disable the control.
  It is a backstop, not DDoS defence: it is per process, it does not key on the
  caller, and it deliberately does not limit unauthenticated requests — a limiter
  before auth would let an anonymous caller exhaust a bucket and deny service to
  the operator. Per-caller and unauthenticated throttling belong at the reverse
  proxy; see `docs/operations/reverse-proxy.md`.
- `docs/operations/reverse-proxy.md` records what a proxy in front of Cerberus must
  own, why `X-Forwarded-For` is deliberately not trusted, a minimal nginx
  configuration, and what happens with more than one replica.
- `CERBERUS_API_KEY_PREVIOUS` and `CERBERUS_MCP_TOKEN_PREVIOUS` support rotating
  either shared secret without a hard cutover: set the new value, put the old one
  in the previous slot, restart, move every client across, then unset it and
  restart again. **Both comparisons always run**, so the response time does not
  reveal which key matched, and neither key is ever logged. Setting a previous key
  without a current one is a startup `ConfigError` — an overlap is not a
  replacement. `docs/operations/key-rotation.md` documents the procedure and what
  an overlap does not do. There is still no key identity and no revocation list:
  ending the overlap is the revocation.
- `POST /api/v1/guardian/ingest` reports `acceptedCount` and `duplicateCount`
  alongside `processedCount`, which keeps its meaning (the batch size). A caller
  retrying after a network ambiguity can see that its events were already stored.
- `micro_events` gains a unique index on `(sessionId, eventId)`.
- `CONTRIBUTING.md` records that Cerberus is single-maintainer and does not use
  `CODEOWNERS`, why a file of invented or wildcard entries would be worse than
  none, and the condition for revisiting it: a second real owner relationship.
- `docs/development/maturity-plan.md` records the maintainer's decisions —
  `CODEOWNERS` not used while single-maintainer, the endpoint agent deferred,
  `v0.2.0` published as a pre-release under explicit authorisation, and operational durability as the next
  focus — and states the current phase's exit condition as a tracked table.
- `docs/index.md` — an entry point for the documentation set. It lists every
  document under `docs/` with the audience it is written for, and is linked from
  the `README.md` documentation section.
- `docs/development/maturity-plan.md` — the current maturity state, completed
  milestones, the next work queue, accepted limitations and the decisions that
  need a maintainer.
- `docs/compatibility.md` — what counts as a public contract, the breaking-change
  and deprecation policies, versioning, supported runtimes, and the dependency and
  license policy with the current audit results. Linked from the documentation
  index, `README.md` and `CONTRIBUTING.md`.
- `SESSION_TTL_SECONDS` is now enforced. A session is live while its most recent
  activity is younger than the configured lifetime; once the window closes the
  session is excluded from `GET /api/v1/guardian/sessions`, is not restored as
  live by a restart, and refuses new telemetry with `409 SESSION_EXPIRED`.
  Expiry is computed on every read from the session's activity and the configured
  TTL — there is no `expired` status, no TTL index and no background sweep. It is
  **not** an evidence-retention policy: nothing is deleted, and the review
  endpoints still serve expired sessions.
- `POST /api/v1/guardian/sessions/:sessionId/reactivate` reopens a closed
  monitoring window. Reopening is explicit so that a monitoring window cannot be
  extended indefinitely as a side effect of continuing to emit events. It is
  idempotent for a live session and refuses a `terminated` session with
  `409 SESSION_TERMINATED`.
- A derived `liveness` field (`"active"` or `"expired"`) on
  `GET /api/v1/guardian/sessions/:sessionId`, `GET /api/v1/sessions` and
  `GET /api/v1/sessions/:sessionId`.
- `createApp()` accepts an optional injected `clock`, and
  `apps/api/src/services/session-liveness.ts` exports a manual clock, so the TTL
  boundary is asserted exactly in tests instead of by sleeping.
- The console sends the scenario panel's risk-distribution sliders as a
  structured `severityMix` object. The mapping lives in
  `apps/console/lib/models/severity_mix.dart`: `routine → low`,
  `elevated → medium`, and the third slider is a budget split
  `60% high / 40% critical`. `ApiService.authorScenario` accepts an injectable
  `http.Client` so the generated request body is tested.
- `CERBERUS_MAX_BODY_BYTES` bounds the request body the API will buffer. The API
  previously had **no request body size limit at all** — `@hono/node-server`
  exposes no `bodyLimit` option and none was configured — so every route read
  whatever the caller sent. An oversized request is now refused with
  `413 PAYLOAD_TOO_LARGE` before the body is read, for authenticated and
  unauthenticated callers alike. Default 8 MiB, matching the ceiling the MCP
  adapter already applied to its own bodies.

### Changed

- `README.md` and `CONTRIBUTING.md` now state where `flutter build web --release`
  writes its output: `apps/console/build/web`. `CONTRIBUTING.md` previously
  stopped at `flutter run -d chrome` and had no build step at all.
- Request fields that reach a paid provider are now length-capped: `prompt`
  (8 000 characters) and `roleContext` (200) on `POST /api/v1/scenarios`, and
  `question` (2 000) on `POST /api/v1/auditor/query`. Each is refused with
  HTTP 400 before any inference is spent. Telemetry batches are capped at
  1 000 events per request, and identity fields at 200 characters each.
- The auditor truncates its result set to 200 records whatever pipeline the model
  produces, so a model-generated pipeline with no `$limit` can no longer pass
  every session to the provider.
- The scenario panel's third risk slider is labelled **"Severe"** rather than
  "Critical", because only 40% of its budget becomes `critical`. The panel prints
  the resulting four percentages beneath the sliders, so the split is shown
  rather than hidden.
- The risk distribution is no longer folded into the scenario prompt as prose.
  It travels only as the structured `severityMix` field, and the server states it
  to the model from those exact numbers — one source of truth instead of two that
  could disagree.
- `SESSION_TTL_SECONDS` is validated at startup: it must be a positive whole
  number of seconds. `0`, `-1`, `1.5`, `1e3` and `7200abc` now raise a
  `ConfigError` and exit with code 1 instead of being silently parsed into a
  different monitoring window. An unset value still takes the `7200` default.
- The telemetry activity signal that drives expiry is server-generated only. The
  client-supplied `MicroEvent.timestamp` is recorded and displayed but is
  deliberately not an expiry input, and a deduplicated replay does not refresh
  the activity stamp.
- Model-supplied numbers are now clamped to the ranges their contracts document,
  in `apps/api/src/ai/parsers.ts`: `overallRiskScore` and `dimensionScores.*` to
  0-100, `flags[].confidence`, `exfiltrationReport` similarity fields and the
  classifier `confidence` to 0-1, mandate `weight` to 0-1, vector `riskScore` to
  0-100, and every `antiExfiltrationThresholds` field to its own range. Finiteness
  was already checked; range was not, so a well-formed `-1e9` or `1e9` passed
  through and would have corrupted threshold comparisons, sorting and the
  auto-lock decision.
- Model-supplied arrays and strings are bounded: at most 50 entries per array,
  2 000 characters of free text, 200 per identifier, and `subMandates` recursion
  is depth-limited to 5. Non-object array entries are dropped rather than
  coerced into fieldless records that read like real evidence.
- `exfiltrationReport` and `behavioralAnomalies` are now parsed field by field
  instead of being cast to their contract types, so a malformed model structure
  no longer reaches the console and the review timeline untouched.
- The composed risk score is clamped through `clampScore()`, which maps a
  non-finite value to 0 rather than `NaN`. `NaN >= AUTO_LOCK_THRESHOLD` is false,
  so a `NaN` score would have silently disabled the auto-lock instead of failing
  loudly.
- Outbound Slack and SendGrid notifications are bounded by a 5 000 ms deadline.
  Ingestion awaits both channels before returning, so a webhook that accepted a
  connection and never answered previously stalled the ingest request for as long
  as the socket stayed open — the notification path could block telemetry
  collection. A timed-out notification is logged as a timeout and otherwise
  ignored, so the failure semantics are unchanged.
- The operator identity registry is bounded in size and time. It was a `Map` that
  grew by one entry per `POST /api/v1/identity/set` and never evicted anything,
  while `GET /me` already described an unknown handle as "unknown or expired"
  although nothing expired it. Handles now expire after 12 hours and the registry
  reclaims expired entries, then the oldest, at a ceiling of 100.
- Retry fatality is classified from the OpenAI SDK error's HTTP status and
  machine-readable `code` instead of by searching the error message for `"401"` /
  `"403"`. Any error whose text happened to contain those digits — a token count,
  a request id, a URL — was treated as an authentication failure and skipped the
  retry budget entirely.
- The auditor's pipeline translation uses the same defensive JSON recovery ladder
  as every other model-reading path. A raw `JSON.parse` discarded an otherwise
  usable pipeline whenever the model wrapped it in a markdown fence or a
  sentence.
- The MCP adapter refuses an oversized request body with `413 PAYLOAD_TOO_LARGE`
  and `Connection: close`, and a malformed body with `400 INVALID_JSON` or
  `400 INVALID_BODY`. It previously destroyed the request without settling its
  promise — so the handler hung and the client saw a connection reset instead of a
  status — and collapsed both an oversized and a malformed body into `{}`, which
  surfaced as a misleading "Missing required parameter". The adapter now reads the
  same `CERBERUS_MAX_BODY_BYTES` variable as the API, so the two ceilings cannot
  drift apart.
- `npm test` runs the MCP workspace's suite as well as the API's. The MCP package
  had no tests at all; request body parsing now has integration tests over a real
  socket.
- `DATA_LEAKAGE_SIMILARITY_THRESHOLD` now gates something. Exfiltration similarity
  was previously left to the model, which never saw the threshold, and the
  reference source was a stub returning `[]`, so matches were always empty while
  the setting was still documented as doing something. Similarity is now computed
  **locally and deterministically** (`apps/api/src/services/text-similarity.ts`:
  normalise → 3-token shingles → Jaccard) against an operator-managed reference
  corpus, and pairs at or above the threshold become `ExfiltrationMatch` entries.
  The model's `exfiltrationReport` is replaced rather than merged, because only
  the local comparison is reproducible from inputs an operator can inspect.
  `aiCompletionLikelihood` is always `0`, since Cerberus does not attempt to
  determine whether content was machine-generated.
- `POST`, `GET` and `DELETE /api/v1/reference-documents` manage the reference
  corpus: a local MongoDB collection (`reference_documents`) that **Cerberus never
  populates itself**. There is no crawler, no bundled corpus and no third-party
  content — every entry is submitted by the authenticated operator. Label 200
  characters, content 20 000 characters, 20 tags of 50 characters, 200 documents
  loaded per analysis.
- The MCP package gains `store_reference_document`, `list_reference_documents` and
  `delete_reference_document`, plus the `reference_documents` collection and its
  indexes. `store_reference_document` upserts on `referenceId`, so re-submitting a
  document updates it rather than creating a duplicate that would double-count in
  similarity scoring.
- `DATA_LEAKAGE_SIMILARITY_THRESHOLD` is validated at startup: it must be a number
  between 0 and 1 or the process exits with a `ConfigError`. A value above 1 could
  never be reached by a similarity score, so it would have silently switched the
  matcher off while appearing to be configured.

### Fixed

- A batch retried after a restart was re-ingested and re-counted. Deduplication
  lived in a 128-entry fingerprint ring in process memory, which is empty after a
  restart. `micro_events` now carries a unique index on `(sessionId, eventId)`,
  `ingest_micro_events` upserts each event with `$setOnInsert` and reports which
  events were **newly inserted**, and the ingest path applies only those. Verified
  against real MongoDB across a real process restart: a two-event batch sent twice
  reports `accepted=2 duplicate=0` then `accepted=0 duplicate=2`, the durable
  `eventCount` stays 2, and exactly 2 documents are stored.
- Content deduplication was applied to **signal** events, silently dropping
  legitimate telemetry: two keystrokes with the same inter-key delay are two
  keystrokes, not a replay. It is now scoped to content-bearing types (`PASTE`,
  `PASTE_TRIGGER`, `EDIT`, `CODE_DELTA`, `SUBMIT`); every other event is
  identified by `eventId` alone.
- An event with no `eventId` is rejected with `400 MISSING_EVENT_ID`.
  `MicroEvent.eventId` was already required by the contract and is now the durable
  idempotency key, so an event that cannot be identified cannot be deduplicated.
- A restart reset a session's durable counters. `update_session_counts` was
  applied with `$set`, so the durable totals were whatever the API held in memory
  — and a restarted process held counters starting at zero. Its first write
  replaced a session's lifetime totals with the post-restart ones: 40 events and
  20 pastes came back as 1 and 1. Counters are now **hydrated** from the durable
  document before any event is applied, and applied with **`$max`** at the storage
  layer so a durable total cannot regress even if the caller sends a lower value.
  Verified across a real process restart: five events before, one after, and the
  durable `eventCount` reads 6 with `tabSwitchCount` and `fullscreenExitCount`
  intact.
- `SessionState.eventCount` was declared, initialised to zero and never read. It
  now means "events accepted for this session, including before this process
  started", and is what the durable `eventCount` is written from.
- The session review reported the **oldest** risk assessment as the final one.
  `MongoStore.getRiskAssessments()` sorts `{ generatedAt: -1 }` — newest first —
  while the review route read `reports[reports.length - 1]` as "the last report".
  Against MongoDB that is the first assessment ever recorded, so `finalRiskScore`
  was wrong and the derived `flagged` status was decided from a stale score. The
  in-process test stub returned assessments in insertion order, so the suite
  agreed with the route and disagreed with the database. The route now sorts the
  assessments itself, by `generatedAt`, rather than depending on the store's
  ordering, and the new tests use a stub that orders them the way MongoDB does.
- `monitored_sessions.terminalContent` is never written — no route calls
  `update_session_terminal_content` — so after a restart the session review
  reported an empty workspace even though the newest risk assessment holds the
  identical content in `codeSnapshot`. The review route now falls back to it. The
  evidence was always durable; only the view lost it.
- `fullscreenExitCount` was never persisted. The counter drives the
  fullscreen-exit analysis trigger and its score penalty, but it was absent from
  the `update_session_counts` payload, so MongoDB never learned it and a restart
  reset it to 0 — silently disabling both. It is now written, read back, and
  exposed on both session-list paths and in the review list.
- Corrected two documentation claims that the code had already outgrown.
  `docs/architecture.md` and `docs/migration.md` both stated that session
  creation writes the status `in_progress`; it does not. Sessions are created as
  `active`, and `apps/api/test/persistence-naming.test.ts` asserts the retired
  literal is absent from the API source.
- `docs/architecture.md` no longer says the repository has no `docs/` index page.
- `POST /api/v1/identity/set` returns HTTP 400 for a non-string field instead of
  throwing inside the handler. A numeric `displayName` used to be cast to a
  string and `.trim()` called on it, which surfaced as an unhandled 500.

## [0.1.0] - 2026-09-22

The initial independent open-source extraction. Cerberus began as "Cerberus
FinSec" in the **Google Cloud Rapid Agent Hackathon 2026** (Financial Services
track, MongoDB partner track), built on Google Cloud Agent Builder and Gemini.
The AI boundary was later migrated to the OpenAI SDK during **OpenAI Build Week
2026** (Agentic Coding track). The project was subsequently extracted from the
historical `Google-Cloud-Hackathon` repository into this standalone repository.
Published 2026-09-22 as a pre-release; this section describes the state of the
repository at extraction.

### Added

- **Durable risk-assessment identity, so the paid analysis path stores one row per
  incident.** `risk_assessments` gained a unique index on `riskAssessmentId` and
  `MongoStore.storeRiskAssessment` is now idempotent on it: a second store of the same
  id reports `inserted: false` and creates nothing. Before this it was a plain insert
  with no index, so a re-analysis after a restart wrote a **second row for one
  incident** — inflating `riskSummary` on the review surface and double-counting in the
  auditor. The module header of `guardian.ts` had described this dedup layer as
  implemented when it was not; the claim is now true.

  The duplicate-key path is handled rather than pre-checked, because a read-then-insert
  would race: two concurrent analyses of one incident would both see nothing and both
  insert. The unique index is the arbiter, and the duplicate-key error is the *expected*
  outcome of a retry. `isDuplicateKeyError` classifies it from the driver's error code
  rather than by matching a message.

- **Migration `0002-dedupe-risk-assessment-identity`**, which removes pre-existing
  duplicate assessments so the unique index can be created — the same ordering
  constraint as `0001`: migrations run before indexes, because the index cannot be
  created while duplicates exist and the failure would be an opaque duplicate-key error
  at startup rather than a repair. Two copies that disagree on anything but `_id` and
  `_generatedAt` are **not** duplicates: the migration refuses, names the ids and
  deletes nothing. `classifyDuplicateGroups` gained an `ignoredFields` parameter so the
  volatile field can differ by collection — `_ingestedAt` for an event, `_generatedAt`
  for an assessment — because passing the wrong one turns a repairable duplicate into a
  refusal.

- API-key authentication middleware for the HTTP API, comparing the presented
  credential against `CERBERUS_API_KEY` in constant time. The middleware accepts
  `Authorization: Bearer <key>` and `X-API-Key: <key>`, admits `/health` and `/`
  without a credential, and returns an identical `401 UNAUTHENTICATED` response
  for a missing and a mismatched key.
- Explicit CORS allow-list. Cross-origin access is granted only to origins named
  in `CERBERUS_CORS_ORIGINS`, with development-only defaults applied when
  `CERBERUS_DEV_MODE=true`.
- Automated test suite using the Node.js built-in test runner (`node:test`)
  executed through `tsx`, wired up as `npm test`.
- GitHub Actions continuous integration.
- Open-source documentation set: `README.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`, `CHANGELOG.md`, `NOTICE`,
  and the GitHub issue and pull request templates.
- Docker Compose local startup for the MongoDB dependency and the Cerberus
  services.

### Changed

- MongoDB collections renamed to Cerberus-native names: `threat_scenarios`,
  `monitored_sessions`, `micro_events`, and `risk_assessments`. `micro_events`
  keeps its historical name because it was already domain-neutral.
- Default database name renamed to `cerberus`.
- MCP tools renamed to Cerberus-native names, declared once in
  `packages/mcp-mongodb/src/tool-names.ts` and mirrored by the API-side client.
- The AI client consolidated into a single `OpenAIProvider` boundary. All
  inference now goes through the OpenAI Node SDK behind that one interface.
- Repository restructured into an npm workspaces monorepo: `apps/api` (Hono
  HTTP API), `apps/console` (Flutter web operator console), and
  `packages/mcp-mongodb` (MCP server for MongoDB).

### Removed

- The Assessment-era type-alias layer that duplicated the domain types.
- The legacy `GeminiClient` class name, replaced by `OpenAIProvider`.
- Hackathon-only files, tracked build artifacts, and unrelated cloud-project
  identifiers.

### Fixed

- The OpenAI provider no longer sends a `temperature` unless one is explicitly
  configured. Every request previously carried a temperature — the
  `OPENAI_TEMPERATURE` default of `0.2`, or a hard-coded `0`, `0.1` or `0.2` at
  individual call sites — and the default model (`gpt-5.6`) rejects any value
  other than its own default with HTTP 400. The effect was that **every** AI
  path failed: scenario authoring, risk analysis, incident recommendations, the
  natural-language auditor and session summarisation. `OPENAI_TEMPERATURE` is
  now an opt-in override; when it is unset the parameter is omitted and the
  model uses its own default.
- The default per-attempt AI request timeout is raised from 90s to 180s
  (`OPENAI_REQUEST_TIMEOUT_MS`). A multi-vector scenario matrix routinely takes
  longer than 90s to generate on the default model, so the provider exhausted all
  three attempts and the route returned a retryable `AI_UNAVAILABLE` for a
  request size its own contract accepts.
- Corrected the Code of Conduct enforcement contact and removed the placeholder
  banner.

### Security

- Removed the `origin: "*"` CORS wildcard. Cross-origin access now requires an
  explicit allow-list entry.
- Removed secret material from startup logs. The configuration banner reports
  only whether each credential is `set` or `unset`.
- Added fail-closed configuration validation: the API refuses to start when
  `OPENAI_API_KEY`, `CERBERUS_API_KEY`, or `CERBERUS_MCP_TOKEN` is missing, and
  refuses to start with `CERBERUS_DEV_MODE=true` while `NODE_ENV=production`.

<!--
Comparison links for the real repository.

Both `v0.1.0` and `v0.2.0` are tagged, so the compare links resolve.
-->

[Unreleased]: https://github.com/Bilal-Lodhi/cerberus/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Bilal-Lodhi/cerberus/releases/tag/v0.2.0
[0.1.0]: https://github.com/Bilal-Lodhi/cerberus/releases/tag/v0.1.0
