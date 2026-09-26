# Test-double contract

Every in-process stand-in for a real dependency, what it does and does not model,
and how a shared contract suite will make the difference checkable.

## 1. Why this document exists

This repository has found four defects that its own test suite could not see, and
**every one of them for the same reason: a double that did not match the real
store.** That is recorded in
[maturity-plan.md](maturity-plan.md#defects-found-and-fixed-during-this-phase), and
in [performance-baseline.md](performance-baseline.md) for a fifth case where the
double produced a *false finding* rather than a missed one.

The pattern is specific and worth naming:

> A double that is **more capable** than the real store makes the application look
> correct. A double that is **less capable** makes it look broken. Neither agrees
> with production, and the suite passes either way.

Three of the four MCP doubles in this repository return
`{success: true, updated: true}` from `set_session_status` **without persisting
anything and without checking that the session exists**. Any test that terminates a
session and then reads its status back is reading its own seed data, not the
route's write. That is precisely how the confirmed P1 in
[state-transition-model.md](state-transition-model.md) §3.1 — ingest resurrecting a
terminated session — survived a 481-test suite.

## 2. Inventory

| # | Double | Location | Models | Layer |
| --- | --- | --- | --- | --- |
| D0 | `installFetchStub` | `apps/api/test/helpers.ts` | `fetch`: MCP `/tools/*` and `api.openai.com` | transport |
| D1 | `statefulMcp()` | `apps/api/test/session-lifecycle.test.ts` | sessions, events, assessments, statuses | store |
| D2 | `mongoOrderedMcp()` | `apps/api/test/session-durability.test.ts` | as D1, assessments newest-first | store |
| D3 | `idempotentMcp()` | `apps/api/test/event-idempotency.test.ts` | sessions, event identity | store |
| D4 | `statefulMcp()` | `apps/api/test/reference-corpus.test.ts` | sessions, events, assessments, corpus | store |
| D5 | bench double | `scripts/bench/run-bench.mjs` | sessions, events | store |
| D6 | `createManualClock` | `apps/api/src/services/session-liveness.ts` | the clock | time |

D6 is the one double in the repository that is **exactly** the real thing's
contract: `Clock` has a single method and the manual implementation differs only in
who advances it. It is the model to copy.

There is **no shared contract suite.** D1–D5 are four independent reimplementations
of the same interface, each with different semantics, and nothing asserts that any
of them agrees with `MongoStore`.

## 3. Contract matrix

**This section is a historical record of the doubles as they were when the audit
was written.** D1–D4 have since been deleted and replaced by the shared double in
§5; the matrix is kept because the divergences it names are the reason that work
happened, and because a future double should be measured against the same columns.

`MongoStore` is the reference. A `✔` means the double matches the real behaviour,
`✘` means it does not, and `–` means the double does not implement the tool at all
(so it falls through to the stub's default, which is discussed in §4).

| Contract | Real `MongoStore` | D1 lifecycle | D2 durability | D3 idempotency | D4 corpus | D5 bench |
| --- | --- | --- | --- | --- | --- | --- |
| **Assessments sort order** | `{generatedAt: -1}` newest-first | ✘ insertion order | ✔ newest-first | – | ✘ insertion order | – |
| **`getSessionEvents` limit** | 500, `{timestamp: -1}` newest-first | ✘ unbounded | ✘ unbounded | – (always `[]`) | ✘ unbounded | ✔ `slice(-500)` |
| **Counters applied with `$max`** | ✔ monotonic | ✘ spread-merge (`$set`) | ✘ spread-merge (`$set`) | ✘ spread-merge (`$set`) | – no-op | ✘ |
| **`set_session_status` persists** | ✔ | ✔ | ✘ | ✘ | ✘ | – |
| **`set_session_status` checks existence** | ✔ `matchedCount > 0` | ✔ | ✘ always `true` | ✘ always `true` | ✘ always `true` | – |
| **Event identity `(sessionId, eventId)`** | ✔ unique index | ✔ | ✔ | ✔ | ✔ | ✘ |
| **`ingest_micro_events` reports accepted vs duplicate** | ✔ from `upsertedIds` | ✔ | ✔ | ✔ | ✔ | ✘ |
| **`create_session` is `$setOnInsert`** | ✔ cannot overwrite | ✔ | ✔ | ✔ | ✔ | – |
| **`delete_session` removes events + assessments** | ✔ | ✔ | – | – | – | – |
| **Reference corpus sort order** | `{updatedAt: -1}` newest-first | – | – | – | ✘ insertion order | – |
| **Reference corpus upsert on `referenceId`** | ✔ preserves `createdAt` | – | – | – | ✔ | – |
| **`update_session_terminal_content`** | ✔ `$set` | – | – | – | – | – |
| **Adapter rejects an unknown tool** | ✔ | ✘ returns success | ✘ returns success | ✘ returns success | ✘ returns success | – |
| **Adapter returns non-200 for a bad body** | ✔ 400 / 413 | ✘ always 200 | ✘ always 200 | ✘ always 200 | ✘ always 200 | – |
| **`get_session_review` returns the session document** | ✔ | ✔ | ✔ | ✔ | ✔ | – |

### 3.1 The three divergences that matter

**`$max` vs spread-merge.** D1, D2, D3 and D5 merge counters with
`{...session, ...counts}`, which is `$set` semantics. The real store applies them
with `$max`, and the monotonicity guarantee is the whole point of that
([session-state-model.md](session-state-model.md) §5.4). So the durability suite's
test named *"the durable counters are monotonic at the storage layer"* cannot
actually test the storage layer — it asserts only that the API's payload never
carries a value below a floor. The real guarantee is asserted separately and
correctly in `persistence-naming.test.ts`, against `buildSessionCountsUpdate`
directly. **That is the right way to test a pure update document**, and it is why
the `$max` guarantee is not untested — but no test exercises a *regression attempt*
against a store that would reject it.

**`set_session_status` in D2, D3 and D4.** These return `{success: true, updated:
true}` unconditionally and persist nothing. Consequences:

- A route that terminates a session and then reads the status back sees the
  *seeded* status, so a route that never wrote anything passes.
- A route that writes a status for a nonexistent session passes, because the
  double never checks existence.
- The `found` logic in `terminate` (`result.data?.updated === true`) is untestable
  against these doubles: it is always `true`.

D1 is the only store double that models `set_session_status` faithfully, and D1 is
the double that no terminate-then-mutate test is written against.

**Assessments in insertion order (D1, D4).** The real store returns newest-first.
This is the exact defect recorded as P0 in the maturity plan — the review route
read `reports[reports.length - 1]` as "the latest", which against MongoDB is the
*oldest*. D2 was created specifically to model the real order, and the fix was to
sort at the point of use. **D1 and D4 still return insertion order**, so a future
regression that reintroduces a reliance on the store's ordering would pass in
those suites and fail only in D2's.

### 3.2 What no double models

| Real behaviour | Modelled anywhere? |
| --- | --- |
| `$max` refusing a lower counter value | no |
| A unique-index violation (`E11000`) on `(sessionId, eventId)` | no — every double pre-checks instead, which is a different mechanism |
| `ordered: false` partial-batch semantics | no |
| `limit(0)` meaning "no limit" | no |
| A `matchedCount === 0` status write | only D1 |
| Adapter HTTP error statuses (400 / 413 / 503) | no — D0 always answers 200 |
| `compact()` dropping `undefined` before `$set` | partially — D0's default returns a canned success, so a route sending `undefined` sees success |
| Adapter body-size rejection | no (covered separately in `packages/mcp-mongodb/test/body.test.ts` and `request-limits.test.ts`) |

## 4. The transport stub's own contract

D0 (`installFetchStub`) is a legitimate and well-built transport double: it lets
the real provider, the real parsers and the real route handlers execute. Two
properties of it are load-bearing and are easy to forget:

1. **Its default response is `{success: true, mongoDocumentId: "stub-doc-id"}` for
   every tool.** A route that calls a tool the test author did not think about gets
   a plausible success. This is what makes an unknown-tool call invisible rather
   than loud.
2. **It always answers HTTP 200.** `callMcpTool`'s non-2xx branch
   (`{ok: false, status, error: "HTTP …"}`) is therefore never exercised through a
   route. It is exercised directly, and the MCP adapter's own error statuses are
   covered in `packages/mcp-mongodb/test/body.test.ts`.

Neither is wrong; both mean a passing route test is evidence about the route's
logic and **not** about its behaviour when the adapter rejects something.

## 5. The plan

The goal is not "replace the doubles". It is: **one faithful store double, one
contract suite that runs against both it and a real MongoDB, and no test trusting a
double that fails the contract.**

### 5.1 A single shared store double

`apps/api/test/support/mcp-store-double.ts`, replacing D1–D5. It models:

- counters applied with `$max` (so a lower value is refused, as the real store
  refuses it);
- assessments returned newest-first, `{generatedAt: -1}`;
- `getSessionEvents` capped at 500, newest-first, with the cap configurable so a
  test can prove a caller does not depend on it;
- `set_session_status` persisting the status **and** returning
  `updated: matchedCount > 0`, so a write for an unknown session is observable;
- `create_session` as a true `$setOnInsert`, including that the server owns
  `createdAt` / `updatedAt` and a caller-supplied value is ignored;
- reference documents newest-first with `createdAt` preserved on upsert;
- an unknown tool **rejected with 404**, so an unmodelled call is loud;
- the adapter's error mapping — 404 for an unknown tool, 400 for
  `ToolArgumentError`, 500 otherwise — so a route's behaviour on an adapter
  *rejection* is reachable for the first time;
- `failToolTransport` / `failToolWithStatus` / `failToolsMatching` hooks, so the
  partial-failure windows in [failure-semantics.md](failure-semantics.md) are
  reachable deterministically.

Two structural choices do more for fidelity than any amount of care in the
implementation, and both are worth stating plainly because they are what make this
double different from the four it replaces:

1. **The tool layer is not faked at all.** The double implements the `MongoStore`
   *method* surface and the real `createToolRegistry()` wraps it, so tool-name
   mapping, argument validation, the `SESSION_STATUSES` check, the bounded-string
   and bounded-tag rules and every response shape are the production
   implementations. Only storage is simulated.
2. **The update documents are the production ones.** Counters go through the real
   `buildSessionCountsUpdate()`, so `$max` monotonicity and the "set `status` only
   when supplied" rule are the real rules rather than a spread-merge that happens to
   look similar.

It must not model: BSON, indexes, `ordered: false`, or transactions. Those belong
to the real-database suite.

### 5.2 A contract suite run twice

`apps/api/test/store-contract.test.ts` declares 37 named contract cases and runs
them against:

1. the shared double, always;
2. a real `MongoStore`, **when `CERBERUS_TEST_MONGODB_URI` is set**, and skipped
   with an explicit reason when it is not.

The cases cover sort order, the 500-event read cap, uniqueness, upsert,
`$setOnInsert`, `$max`, duplicate-key behaviour, timestamps, missing fields,
newest-first ordering, projections, terminal filtering and cascade deletion. A
double that cannot satisfy the contract is not used. That is the enforcement
mechanism, and it is why the contract lives in one file rather than in prose.

The suite also carries a **fidelity guard**: it asserts that every store method the
tool registry calls exists on both `MongoStore.prototype` and the double, so a
missing or renamed method is loud and immediate rather than surfacing only when a
route happens to call it.

### 5.3 The real-Mongo integration suite

`apps/api/test/integration/`, gated on `CERBERUS_TEST_MONGODB_URI` and skipped
otherwise, covering the highest-risk state flows:

- create session, ingest, retry the duplicate, restart;
- auto-lock, terminate, final-risk ordering;
- terminal content;
- the two concurrency cases that a single-document predicate must decide
  (terminate vs auto-lock; two terminal transitions racing);
- the corpus limit at its boundary;
- a migration applied twice, and a migration that fails before mutating.

No paid AI: the provider boundary is stubbed exactly as the unit suite does it. A
bounded CI job provides a `mongo:7` service container so the suite actually runs;
without it the job would be green for the wrong reason, which is the failure mode
this document exists to prevent.

### 5.4 Ordering, and what is done

| Step | Work | State |
| --- | --- | --- |
| 1 | This audit | **Done** |
| 2 | Shared double + contract suite | **Done** — 37 cases, verified against a real MongoDB 7 |
| 3 | Central transition boundary, tested against the shared double | Planned |
| 4 | Real-Mongo integration suite + bounded CI job | Planned |
| 5 | Migrate D1–D5 onto the shared double; delete the originals | **D1–D4 done**; D5 is addressed with the benchmark work |

### 5.5 What the migration changed

D1–D4 were deleted, and their suites now construct the shared double directly:

| Suite | Was | Now |
| --- | --- | --- |
| `session-lifecycle.test.ts` | D1 — insertion-order assessments, `$set` counters, unbounded event reads | shared double |
| `session-durability.test.ts` | D2 — `set_session_status` returning `updated: true` without persisting | shared double |
| `event-idempotency.test.ts` | D3 — `get_session_review` always returning no events | shared double |
| `reference-corpus.test.ts` | D4 — insertion-order corpus, no reference-failure family | shared double |

`session-durability.test.ts` is the one that matters most. Its double returned
`{success: true, updated: true}` from `set_session_status` **without persisting
anything and without checking that the session existed**, which is why the suite
could not see the confirmed P1 in
[state-transition-model.md](state-transition-model.md) §3.1 — a terminated session
being resurrected to `locked` by a later ingest. The shared double persists the
status and reports `matchedCount`, so that defect is now observable from the same
suite, and the regression test for it lands with the fix.

D5 — the benchmark double in `scripts/bench/run-bench.mjs` — is deliberately left
for the benchmark work rather than migrated here. It has two properties the shared
double must not have: it retains nothing for the memory case, and it is the
instrument whose own unfaithfulness has twice produced a false finding
([performance-baseline.md](performance-baseline.md)). Changing an instrument while
also changing what it measures would make neither attributable.

### 5.6 What is deliberately not planned

- **No mock of the MongoDB driver.** `MongoStore` is the thing under test in the
  integration suite; mocking the driver would test the mock.
- **No HTTP-level replay of the MCP adapter in unit tests.** The adapter has its
  own suite; the API's contract is `callMcpTool`, which D0 covers.
- **No golden-fixture store.** A recorded set of responses would freeze the current
  behaviour, including its defects. Where a defect must be pinned — the missing
  assessment identity — the contract suite asserts the defect **explicitly**, so the
  fix cannot land silently.

## 6. Verified result

The contract suite was run twice against a real `mongo:7`, on the same commit:

| Configuration | Result |
| --- | --- |
| `CERBERUS_TEST_MONGODB_URI` unset | 512 API tests, 511 pass, **1 skipped** (the real half, with its stated reason) |
| `CERBERUS_TEST_MONGODB_URI=mongodb://127.0.0.1:27170` | 546 API tests, **546 pass, 0 skipped, 0 failed** |

All 37 contract cases pass against both implementations, so the double is
*verified* faithful to the real store for every property the contract asserts —
rather than asserted to be, which is what the previous four doubles relied on.

The one case that fails on neither is the characterisation of the missing
assessment identity: it passes on both, which is the point — the defect is real and
not an artefact of the double.
