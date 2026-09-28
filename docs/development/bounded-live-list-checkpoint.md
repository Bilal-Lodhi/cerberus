# The bounded live-list checkpoint

The record of the cycle that asked one question and answered it:

> **Can the live-session list stop scanning the entire session collection while remaining exactly
> equivalent to the current reconciler semantics for every legacy and malformed stored document?**

**Yes.** The list is answered by a bounded, index-backed durable query whose result is proven equal
to the previous build's full scan — field by field, in order — over a hand-written case table, sixty
generated fixtures and a real server. Its p50 is flat from 20 to 20 020 stored sessions, where it
used to grow linearly.

Nothing was published. `v0.1.0`–`v0.6.1` are untouched, and there is no `v0.7.0` tag.

---

## 1. What landed, by theme

| Theme | Where |
| --- | --- |
| The current semantics, written down before anything changed | [live-list-equivalence-model.md](live-list-equivalence-model.md) |
| A 41-row adversarial fixture, and the v0.6.1 release shape | `apps/api/test/support/release-fixture.ts` |
| Migration `0005` and the pure normalisation it applies | `packages/mcp-mongodb/src/session-list-normalisation.ts`, `migrations.ts` |
| The predicate, its two indexes and their shared specification | `packages/mcp-mongodb/src/live-list-query.ts` |
| The bounded query, wired into the store and the route | `mongo-client.ts` `listSessions`, `routes/guardian.ts`, the `list_sessions` tool |
| The equivalence proof | `live-list-bounded-query.test.ts`, `live-list-equivalence-generated.test.ts`, `release/live-list-mirror-vs-query.test.ts` |
| The query-plan gate and the critical-index guard | `release/live-list-query-plan.test.ts`, `scripts/release/critical-indexes.json` |
| Two-process terminal and list safety | `integration/multi-process-live-list.test.ts` |
| The before/after measurement and its gate | `scripts/bench/run-read-path-bench.mjs`, `scripts/release/live-list-bench-sanity.mjs` |
| Backup/restore of the normal form | `scripts/release/backup-restore-drill.mjs`, `scripts/restore-cerberus.ps1` |

## 2. The equivalence argument, and where each part of it lives

The reconciler was **not modified**. That is what makes the proof tractable: the question is only
whether the bounded query returns everything the reconciler needs, and the answer decomposes into
three claims, each checked separately.

| Claim | Statement | Checked by |
| --- | --- | --- |
| **The migration is reconciler-neutral** | It rewrites `status` into the value `normalizeStatus` was already computing (idempotent by construction) and adds a field the reconciler never reads. `updatedAt`, `deployedAt`, `createdAt` and the counters are untouched. | `live-list-normalisation.test.ts`; the migration's own test asserts every other field is byte-identical |
| **The query is complete** | `Q ⊇ {documents of this process's own sessions} ∪ {documents that are live under the durable-only rule}`. Over-selecting is harmless — the reconciler drops what is not live — and under-selecting is not, so every branch is written to be a superset. | `live-list-query-plan.test.ts` for the shape; `live-list-equivalence-generated.test.ts` for the property |
| **The predicate is exactly the rule** | `status ≠ "terminated"` *is* `isMonitored(normalizeStatus(status))`; `liveListUpdatedAt > cutoff` *is* `parse(tsString) is null ∨ parse(tsString) > cutoff`, established for every document by migration `0005`. | `live-list-normalisation.test.ts` evaluates the invariant at six clocks, from a year before the fixture to a hundred years after it, by calling `reconcileLiveList` |

The end-to-end comparison is one function over two document sets, so it cannot collapse into a
comparison of a value with itself:

```
expected = reconcileLiveList(local, wire(documentsAsV061LeftThem))
actual   = reconcileLiveList(local, wire(selectBounded(migratedDocuments)))
```

`sessions` — every field, in order — plus `repairs`, `localOnly`, `addedFromDurable` and
`reconciled` are compared exactly. `dropped` is the one field allowed to differ, and its difference
is asserted rather than ignored: it counts the documents the request fetched, and a bounded request
fetches fewer.

## 3. Three predictions that the evidence corrected

The previous cycle designed this change and wrote its design into the maturity plan. Three parts of
that design were wrong, and finding out why was most of the work.

**"`monitored` is `$ne: "terminated"` — which is not an index-friendly predicate."** It is. With a
`status` prefix MongoDB turns `$ne` into the bounds `[MinKey, "terminated") ∪ ("terminated",
MaxKey]`, which skips the terminated bucket — usually the largest one — and includes the `null`
bucket, where a document with no status is indexed. It is also *complete* where an enumeration of
the live values is not: `normalizeStatus` maps a missing, `null`, unknown, case-variant or
wrong-typed status onto `active`, and the historical `undefined`-to-`null` clobber produced exactly
those documents. Measured, not assumed.

**"Migration rewrites `updatedAt` from `createdAt` where it is missing or not a date."** It must
not, and this is the cycle's most important finding. The reconciler evaluates expiry through **two
branches**: the durable-only branch falls through `updatedAt → deployedAt → createdAt → now`, while
the local-row branch consults only `readDurableString(updatedAt)` — a *non-empty string* and
nothing else. For a document with no usable `updatedAt`, a recent `deployedAt` and a local row whose
own instant is stale, the current code **drops** the session; after rewriting `updatedAt =
deployedAt` the local row gains a durable candidate, the maximum wins, and the session is
**reported live**. The normalised instant therefore goes in its own field, and every timestamp the
read surfaces display is left alone.

**"One index on `{ status: 1, updatedAt: -1 }`."** Two, because the predicate ranges over two
different fields and the branches are alternatives rather than a conjunction: a compound
`{ status, updatedAt, liveListUpdatedAt }` is usable only when `updatedAt` is constrained, which is
exactly what the derived-instant branch does not do. The second index is
`{ status: 1, liveListUpdatedAt: -1 }`.

## 4. The measurement

One machine, one loopback `mongod` 7.0.43, one process, 20 live sessions throughout, at commit
`42f7234` (the head of the release-harness branch the run was taken on; that change is `829e713` on
`main`, identical apart from documentation).

### The list

| Stored sessions | Live list p50 | p95 | Previous build: documents examined | Bounded: documents examined | Bounded plan |
| --- | --- | --- | --- | --- | --- |
| 20 | 2.63 ms | 3.43 ms | 20 (**COLLSCAN**) | **20** | IXSCAN, OR |
| 520 | 2.64 ms | 3.23 ms | 520 (**COLLSCAN**) | **20** | IXSCAN, OR |
| 5 020 | 3.45 ms | 5.64 ms | 5 020 (**COLLSCAN**) | **20** | IXSCAN, OR |
| 20 020 | 2.92 ms | 4.12 ms | 20 020 (**COLLSCAN**) | **20** | IXSCAN, OR |

`v0.6.1` measured the same fixture shape at **75.58 ms p50** for 5 020 stored sessions. The point
that cost 75.58 ms now costs 3.45 ms, and the documents examined are the live set at every size
rather than the store. The 5 020 stage's figure is the one that stands out, and it is a measurement
artefact — that stage inserts 5 000 documents immediately before measuring, and its *detail* figure
is elevated too, which a unique-index lookup cannot be. The deterministic evidence is the examined
count, and it is 20 at every size.

### Everything else

| | p50 | p95 | persistence calls/request |
| --- | --- | --- | --- |
| Live detail (process holds the session) | 1.64 ms | 2.70 ms | 1.00 |
| Live detail (after restart) | 2.11 ms | 3.26 ms | 1.00 |
| Review detail | 8.32 ms | 10.38 ms | 1.00 |
| Live list (20 sessions, steady state) | 2.67 ms | 3.51 ms | 1.00 |

The live detail and the review detail were not touched by this cycle; their figures moved against
`v0.6.1` by machine variance. **No read surface acquired an N+1**: `mcp/req` is 1.00 everywhere,
including the list.

## 5. Migration `0005`, and the upgrade path

`0005-normalise-session-list-fields` writes two fields and deletes nothing:

- `status` → the value `normalizeStatus` was already computing from the stored one;
- `liveListUpdatedAt` → the instant the durable-only liveness rule compares against, derived from
  `updatedAt`, then `deployedAt`, then `createdAt`, with a **sentinel** meaning "conservatively
  never expires" when no truthful instant exists. The migration never reads the clock.

It streams the collection in bounded batches, guards every write with a compare-and-set on the
values its plan was computed from (so a session the application transitions mid-scan is not
overwritten with a stale normalisation), records counts by category, and is a no-op on a re-run —
`modifiedRows === 0`, asserted at the storage layer rather than inferred from the ledger.

The dry run reports the same categories as the applied run, from the **same code path**, because
`Migration.inspect` was added for it. On the adversarial fixture:

```
scanned 41 document(s): status 4 missing and 6 unrecognised normalised, 31 already normal
liveListUpdatedAt: 25 from updatedAt, 4 from deployedAt, 2 from createdAt, 10 unverifiable, 0 already normal
0 document(s) unchanged, 41 rewritten, 41 modified
```

**Upgrade ordering**, and the honest answers:

| Question | Answer |
| --- | --- |
| Can the migration run before the new build? | Yes, and it is the ordinary path: `connect()` applies migrations **before** it creates indexes and before any route serves. |
| Can the old build tolerate normalised rows? | Yes — the status it writes is the value the old build already computed, and every timestamp it reads is untouched. |
| Can the new build start before the migration finishes? | It cannot start *during* one: `connect()` awaits the pass and a failure stops the process. A process started with `migrate: false` against a database with pending migrations reads the collection as the previous build did and **warns once** — correct, and not yet faster. |
| Can two replicas race the migration? | The runner is idempotent and the ledger's unique index makes double-recording impossible, so the second execution is a no-op. Stop one instance anyway. |
| A document an **older** process writes afterwards? | Still visible: every write path sets a `Date` `updatedAt` and a durable status, which is the branch that needs no derived field. |

## 6. The residuals, stated

1. **One document shape is not covered.** A document the migration has *not* classified whose
   `updatedAt` is not a `Date` is invisible to the bounded query. No version of the store can
   produce it — every write path sets a `Date` `updatedAt`, and `connect()` migrates before it
   serves — so the only way to reach it is to hand-edit a document after the migration ran. Writing
   the document closes it. The shape, the reason and the remedy are pinned as a test rather than
   left as a gap in the prose.
2. **`liveListUpdatedAt` is derived storage.** A direct database edit that writes a status outside
   `active | locked | terminated`, or that leaves a document with no `liveListUpdatedAt` and no
   `Date` `updatedAt`, can make a session invisible to the live list until it is written again.
   [../operations/upgrade.md](../operations/upgrade.md) states the rule; the API always produces the
   normal form.
3. **The unbounded read is still reachable**, deliberately: a process started with `migrate: false`
   against a database with pending migrations reads the collection exactly as the previous build
   did. Correctness never depends on having migrated; only cost does.
4. **The `updatedAt` reader asymmetry is retained, with the proof that closing it would change an
   answer.** See [read-model.md](read-model.md) §2.1 and
   `apps/api/test/session-read-model-timestamps.test.ts`.
5. **The console's polling defects are unchanged** — no visibility guard, no in-flight guard,
   duplicate detail requests on selection, `stopStreaming` not awaiting cancellation.
6. **No cache, no endpoint agent, no accounts, no RBAC, no tenancy, no incident identity, no
   notification outbox, no distributed rate limiter, no new AI provider.**
7. **No latency guarantee.** The figures above are one machine, one loopback `mongod`, one process,
   no reverse proxy, and a single run each.

## 7. What was verified, and how

| Gate | Command | Result |
| --- | --- | --- |
| Sources and test tree typecheck | `npm run typecheck`, `npm run typecheck:tests` | clean |
| The whole suite against a real MongoDB | `npm test` with `CERBERUS_TEST_MONGODB_URI` | **1282 + 21 tests, 0 failed, 0 skipped** at the last local run |
| The live-list gates | `npm run verify:live-list` | pass |
| The query-plan gate | inside the above | no `COLLSCAN`, named index used, examination bounded, no `SORT` |
| The benchmark gate | `npm run verify:live-list-bench` | pass — the previous query collect-scans, the bounded one does not, cost does not follow the collection |
| Backup and restore | `npm run verify:backup` | **14 checks, 0 failed**, including the normal form, the ledger's `0005` row and the bounded predicate on the restored database |
| The release harness | `npm run verify:release` | the two new steps pass; the full run is the `workflow_dispatch` job |
| Docs, version, config, secrets, packages, idempotency | `check:docs`, `verify:version`, `verify:config`, `verify:secrets`, `verify:packages`, `verify:idempotency` | all pass |
| CI | every pull request | green, including the real-MongoDB integration job that asserts nothing was skipped |

**Not verified locally, and stated as such:** the container-build and backup/restore steps of the
full release harness were last run before the local Docker daemon stopped; the `workflow_dispatch`
job runs them on a runner that provides both, and its result is recorded in the release-candidate
checklist this cycle prepares (`docs/release/v0.7.0-checklist.md`).

## 8. What this does not claim

- **Not production ready.** The repository remains experimental.
- **No latency, throughput or availability guarantee.** One machine, one loopback `mongod`, single
  runs.
- **No compliance or auditability claim.** `DURABLE_CURRENT` means the value was read from the store
  in this request.
- **No API-breaking change**, and no cache. Every response shape is unchanged except for the
  additive stored field and the now-specified order of rows sharing a `deployedAt`; see
  [../compatibility.md](../compatibility.md) §1d.
- **Nothing was published** — no release, tag, package, image or deployment.
