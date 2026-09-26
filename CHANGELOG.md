# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
