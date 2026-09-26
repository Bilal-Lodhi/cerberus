# Idempotency on the paid routes

What happens when a caller retries a request whose response was lost, what Cerberus does about
it today, and the mechanism it will use.

## 1. The decision

**Re-accepted for this phase, with the exposure stated exactly and a mechanism designed.**

No durable idempotency record exists. The two routes that spend money execute the provider call
on every request they accept, and a retry after a lost response therefore spends again.

This is recorded as a decision rather than as an unfinished item because the honest options were
"build it" and "say precisely what it costs" — and a mechanism half-built onto a paid path is
worse than either. What follows is what it costs, what the mechanism is, and what will prove it.

## 2. The exposure, measured from the code

| Route | Paid calls per accepted request | Source |
| --- | --- | --- |
| `POST /api/v1/scenarios` | **2** — a semantic classifier, then matrix authoring | `routes/scenarios.ts`, `classifyScenarioRequest` and `authorThreatScenarioMatrix` |
| `POST /api/v1/auditor/query` | **1** | `routes/auditor.ts` |

Neither route reads or writes anything keyed on the request. `grep -i idempot` over
`apps/api/src` returns nothing.

The failure that matters is **response loss**, not a hostile caller:

```
caller ──POST /api/v1/scenarios──▶ API ──▶ provider  (spends)
                                    │
                                    └──▶ 200, but the response is lost in transit
caller ──retry, same body────────▶ API ──▶ provider  (spends again)
```

Three ways a response is lost, all ordinary: a dropped connection, a client timeout shorter than
the provider's latency, and an operator pressing the button again because nothing appeared. The
third is the most likely in practice, and the console offers no other signal than the response.

Two further facts bound the exposure:

- **The blast radius is cost, not correctness.** A duplicate scenario matrix is a second
  `threat_scenarios` document with its own `matrixId`; a duplicate audit answer is a second
  response. Neither corrupts existing evidence, and neither is a security boundary — the route
  is already behind the shared operator key and the `ai` rate-limit bucket.
- **The rate limiter is a cost backstop, not a deduplicator.** `ai` is 10 requests/minute
  *per process*, so a retry loop is bounded at roughly ten spends a minute per replica — and that
  ceiling multiplies by the replica count, as the rate-limiting section of
  [multi-writer-model.md](multi-writer-model.md) records.

## 3. What is explicitly not claimed

- **Not exactly-once billing.** Even with the mechanism below, a process that dies after the
  provider responds and before the record is written leaves an operation whose outcome is
  unknown. That is stated in §6 rather than papered over.
- **Not replay protection, and not authorization.** A durable idempotency key stops a *retry*
  from executing twice. It does not stop a caller from sending a new key, and it grants no
  authority the shared key did not already grant.
- **Not a general queue.** The record is a claim and an outcome, not a job system.

## 4. The mechanism

Deliberately small, and entirely Mongo-backed — a unique index is the whole of the mutual
exclusion, so it works on the documented single-node deployment without a transaction.

### The record

One collection, `operation_claims`, one document per claim:

| Field | Purpose |
| --- | --- |
| `routeFamily` | `"scenarios"` or `"auditor"`, so one key namespace cannot collide with another |
| `keyHash` | SHA-256 of the caller's `Idempotency-Key`. The raw key is **never stored** |
| `fingerprint` | SHA-256 of the canonical request body, so a reused key with a different body is detectable |
| `status` | `pending`, `completed` or `failed` |
| `createdAt`, `expiresAt` | When the claim was made, and when it may be swept |
| `resultRef` | For `completed`, a reference to the stored result — the matrix id, or the answer |
| `errorCategory` | For `failed`, a stable category. Never a provider message |

Constraints:

- **A unique index on `(routeFamily, keyHash)`** is the mutual exclusion. The first writer to
  insert owns the operation; every other writer gets `E11000` and reads the winner's record.
- **A TTL index on `expiresAt`** bounds retention, so the collection cannot grow without limit.
- **No prompt body, no provider response body, and no key material** is stored. The fingerprint
  is a digest, and `resultRef` is an identifier rather than a payload.

### The protocol

```
Idempotency-Key absent ──────────────▶ today's behaviour, unchanged
Idempotency-Key present:
  insert {status: pending} ── succeeds ─▶ run the paid call
                                          ├─ success ─▶ status: completed, resultRef
                                          └─ failure ─▶ status: failed, errorCategory
                          ── E11000 ───▶ read the existing record
                                          ├─ completed, same fingerprint ─▶ replay the result, 200
                                          ├─ pending,  same fingerprint ─▶ 409 + Retry-After
                                          ├─ failed,   same fingerprint ─▶ 409, the caller may retry
                                          │                                  with a **new** key
                                          └─ any status, different fingerprint ─▶ 409
```

Five properties, each of which is a charter requirement:

1. **Bounded key length and a safe charset.** The key is validated before it is hashed: at most
   255 characters, restricted to a printable subset. Anything else is `400`, not a claim.
2. **Same key, same request → the prior result.** No second provider call.
3. **Same key, different request → `409`.** A key is a promise about one request; reusing it for
   another is a caller error, and answering it would be a lie about which request ran.
4. **Race-safe across processes.** Two replicas racing the same key both attempt the insert; the
   unique index lets exactly one through, and the loser reads the winner's record rather than
   executing. No lock, no leader election.
5. **Survives a restart.** The claim is a document. A process that dies mid-operation leaves a
   `pending` record, which is the case §6 defines.

### Retention

`expiresAt` is set from a configured window — long enough that a caller retrying an hour later
still gets the prior result, short enough that the collection stays bounded. A TTL index does the
sweeping. The window is a documented configuration value rather than a constant, because it is
the one number an operator may need to change.

## 5. Why the key is opt-in

The `Idempotency-Key` header is optional. A caller that does not send one gets exactly today's
behaviour, which keeps the change additive and means an existing client is unaffected. A caller
that does send one gets the guarantee.

The alternative — making the server generate a key — cannot work: the server has no way to know
that two requests are the same request, which is precisely what the caller knows and the server
does not.

## 6. Pending operations, and process death

The honest part. A `pending` claim is a promise that someone is working; it is not evidence that
anyone still is.

| Situation | Behaviour |
| --- | --- |
| A second caller arrives while the claim is fresh | `409` with `Retry-After`. The operation is in progress. |
| A second caller arrives after the pending timeout | The claim is treated as **abandoned**. The next caller may retry, and the record is replaced. |
| The process died after the provider responded but before the record was written | **Unknown outcome.** The operation may have spent. A retry after the timeout may spend again. |
| The process died before the provider was called | The claim is abandoned and a retry executes once. |

The third row is the guarantee's edge, and it is stated rather than hidden: **the mechanism
prevents a duplicate execution, not a duplicate spend after a crash in a narrow window.** That
window is the time between the provider's response and one document write, which is small and
not zero.

A retry is never silently answered from a `pending` record, because the record does not know
whether the provider ran.

## 7. What will prove it

The mechanism is not implemented in this phase, so nothing here is claimed as verified. When it
is, these are the assertions that would have to hold, and the reason each one exists:

| Assertion | Why |
| --- | --- |
| Same key, same body, twice → **one** provider call, the first result replayed | The whole point. Counted at the stub, not inferred from the response. |
| Same key, different body → `409`, and **no** provider call | A key is about one request. |
| A key longer than the limit, or with an unsafe character → `400`, and no claim written | The key is a caller-controlled string on a paid path. |
| Two processes, same key, `Promise.all` → exactly one provider call | The race the unique index exists for. Asserted as the invariant, not as a guess about the winner. |
| A claim survives a restart and still replays | "Durable" is the word that distinguishes this from an in-process `Map`. |
| A `pending` claim past its timeout does not block a retry, and a fresh one does | §6, both directions. |
| No document holds the raw key, a prompt body, or a provider message | The record is on a path that handles operator-authored content. |
| The collection is bounded by `expiresAt`, and the TTL index exists | Retention, asserted against a real MongoDB rather than assumed. |

The last row belongs with `scripts/release/critical-indexes.json`: a restore that loses the unique
index would silently turn the mutual exclusion off, and a restore that loses the TTL index would
silently unbounded the collection.

## 8. Why this is a document and not a patch

A claim protocol touches the store (two collections and two indexes), the migration ledger, the
MCP tool surface, both paid routes, and the failure semantics of each. Every one of those has a
real-MongoDB test in this repository, and the paid routes are the two places where a mistake costs
money rather than a wrong number on a dashboard.

Building that in the same pass as the session read and write paths — which is what this phase
did — would have meant shipping it with less evidence than the rest of the phase, on the path
where the evidence matters most. The design above is the artifact; the implementation is the next
cycle's first item.
