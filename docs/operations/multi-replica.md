# Running more than one replica

Cerberus was written as a single process. The multi-writer cycle made its **session state**
correct with more than one, and this document states exactly what that does and does not cover —
because "we fixed multi-writer" is a claim an operator could reasonably read as much wider than
it is.

Nothing here requires new infrastructure. There is no lock service, no message bus and no shared
cache: the guarantees come from MongoDB, and the gaps are gaps in the *design* rather than things
a second system would patch over.

## 1. What is safe with N replicas

| Behaviour | Why it is safe |
| --- | --- |
| **Session lifecycle transitions** (`terminate`, `reactivate`, auto-lock, auto-clear) | The durable write is predicated on the status the caller read, so a concurrent transition is detected and reported as `SESSION_CONFLICT` rather than overwriting the winner. |
| **Telemetry ingestion** | Events are keyed on `(sessionId, eventId)` by a unique index, so the same event sent to two replicas is stored once and counted once. |
| **Aggregate counters** | Sent as a batch **delta** and applied with `$inc`, so two replicas accepting distinct events both count. An absolute total applied with `$max` would have converged to the largest single replica's total rather than the sum. |
| **Live session list** | One batched durable query per request, merged with durable over local, so a session another replica terminated is dropped and a session another replica created appears. |
| **Live session detail** | The session document is read on every request, so the status reported is the durable one. |
| **Review list and review detail** | Always read MongoDB. |
| **`terminalContent`** | The replica whose terminal transition applied owns the field. A replica that did not claim the session writes only when the field is empty, so a stale workspace cannot overwrite a preserved one. |
| **Migrations** | The ledger is a collection with a unique index on `migrationId`, so two replicas starting at once cannot both apply a migration. |

## 2. What multiplies, or does not work at all

### 2.1 Rate limiting multiplies by the replica count

**Decision: the limiter stays local, and the proxy owns per-caller limiting.**

The limiter is a token bucket per route category, held in the process. With N replicas the
effective ceiling is up to **N × the configured limit**, because no replica can see another's
buckets.

A Mongo-backed limiter was considered and rejected:

- it puts a **write on the hot path of every request** — including ingestion, which the console
  drives one event at a time — to enforce a bound that is explicitly a backstop rather than a
  defence;
- it would be *coarse* anyway. There is one shared operator key and no per-caller identity, so the
  bucket is global per category. A distributed global bucket is a more expensive way to enforce
  the same thing a single replica already enforces;
- the honest fix for per-caller limiting needs **caller identity**, which the OSS baseline does
  not have. That is a reverse-proxy concern: the proxy sees the client, and it can limit per
  client without Cerberus inventing an identity system.

So the limiter's documented meaning is unchanged and now stated for N replicas: **a per-process
backstop against a runaway client, whose ceiling multiplies by the replica count.** An operator
who needs a real ceiling sets it at the proxy — see
[reverse-proxy.md](reverse-proxy.md).

The `ai` category is the one where this has a cost consequence: it bounds spend, and its ceiling
multiplies too. If you run more than one replica, set the proxy's limit rather than relying on
`CERBERUS_AI_REQUESTS_PER_MINUTE`.

### 2.2 Operator identity handles are per-process

`POST /api/v1/identity/register` returns an opaque handle that is a display identity, **not a
credential**. It is stored in a `Map` in the process that minted it, so a handle presented to a
different replica is unknown there.

This is not a defect to fix — the handle is deliberately not an authorization token, and the
threat model says so. It is a deployment fact: **if you run more than one replica behind a load
balancer, either pin the console to one replica for the duration of a session, or do not rely on
the handle surviving a subsequent request.** Nothing else depends on it.

### 2.3 Notification delivery is best-effort per process

There is no durable outbox and no delivery guarantee. What follows is what was **measured from
the code**, what was **reduced**, and what is **still possible** — stated precisely rather than
as a blanket "duplicates can happen".

#### Reduced: one alert per stored assessment

`store_risk_assessment` is an insert with a unique index on `riskAssessmentId`, so a second
write of one id reports `inserted: false` and changes nothing. That response used to be
discarded — the route read only `stored.ok` — so a second analysis producing an id already in
the database locked the session and **sent a second alert** for an incident that had already
been alerted on.

The route now reads it and suppresses the alert when the evidence was already durable. This is a
durable, atomic, cross-replica dedupe that needed **no new collection, index or migration**: the
unique index already existed and was already the arbiter. The status transition still runs,
because it is a compare-and-set and idempotent, and skipping it could leave a session unlocked
when the durable evidence says it should be locked.

So: **an alert is now at-most-once per stored `riskAssessmentId`, whoever produced it.**

#### Still possible: two alerts for one *incident*

Two API processes analysing one session concurrently each mint their **own**
`riskAssessmentId`. The id comes from the model — it is parsed from the provider's response, or
replaced with a local `randomUUID()` when the model omits one — so two independent analyses of
one incident produce two ids, both rows are new, and both processes notify.

**This cannot be fixed with a marker keyed on `riskAssessmentId`, because that id is not an
incident identity.** A durable dedupe here would need a durable *incident* identity, and none
exists: the natural candidate, the session's workspace content, is reconstructed in memory and
differs between replicas. Building a marker on a key that is not stable would trade a duplicate
alert for a **lost** alert, which is worse.

Also unchanged: a replica that dies mid-send may deliver nothing, and nothing records that a
notification was attempted.

#### Why no outbox

A durable outbox is the mechanism that would close both, and it is not built. It is not built
because the smallest correct version is not small: it needs a durable incident identity first,
and that is a product decision about what an "incident" is rather than an engineering task. An
outbox keyed on an unstable identity would be a queue that either double-delivers or drops. See
[threat-model.md](../security/threat-model.md) §8b and
`apps/api/test/notification-dedupe.test.ts` for the suite that asserts the reduced behaviour and
the surviving gap.

### 2.4 The two paid routes are idempotent when a key is supplied

Both accept an optional `Idempotency-Key`. With one, a retry after a lost response replays the
first response and does not call the provider; the same key with a different request is `409`.
Without one, a retry executes the provider call again on any replica. The mechanism, its
retention window and its remaining crash window are in
[development/paid-operation-state-model.md](../development/paid-operation-state-model.md).


## 3. Rotating the shared secrets across replicas

The overlap procedure in [key-rotation.md](key-rotation.md) is written for one process. With N,
the ordering matters more, because a replica still holding the retired key is a replica that
rejects every request.

**The rule: the new key is everywhere before the old key is anywhere retired.** Concretely, for
`CERBERUS_API_KEY`:

1. **Set the new key as `CERBERUS_API_KEY` and the current one as
   `CERBERUS_API_KEY_PREVIOUS` on every replica's configuration**, then roll the replicas.
   Because both values are accepted, the order within this step does not matter and there is no
   window in which a client's key fails.
2. **Confirm every replica accepts the old key** before moving any client. A replica that did not
   pick up the configuration is the failure this step exists to find, and it is invisible until a
   client lands on it:

   ```bash
   # Run against each replica directly, not through the load balancer.
   for host in api-1 api-2 api-3; do
     printf '%s ' "$host"
     curl -s -o /dev/null -w '%{http_code}\n' \
       -H "Authorization: Bearer <old key>" \
       "http://$host:8080/api/v1/sessions"
   done
   ```

   Every line must read `200`.

3. **Move every client to the new key**, and confirm.
4. **Remove `CERBERUS_API_KEY_PREVIOUS` from every replica and roll again.** After the roll, every
   replica must reject the old key. Repeat the loop above and expect `401` on every line. **That
   unset is the revocation** — there is no revocation list.

For `CERBERUS_MCP_TOKEN`, the same rule applies to both the API replicas and the adapter, and the
adapter must be rolled **first**: it is the side that validates. Rolling the API first would leave
the adapter still accepting only the old token while the API already presents the new one.

### What is not available, and is not being invented

- **No key identity, no generation id, no revocation list.** A replica cannot tell an operator
  which key generation it is running, because that would mean publishing information about the
  secret. The banner reports `set` / `unset` per secret and nothing else, and it is the only
  signal there is.
- **No automatic detection of an inconsistent replica.** Step 2's loop is the detection. A replica
  configured differently from its peers is indistinguishable from a correct one until a client
  lands on it, which is exactly why the check is per-replica rather than through the load
  balancer.
- **No hash of a secret is ever exposed**, in a log, a response or a health payload. A hash of a
  shared key is an offline attack surface, and it would also tell an attacker when two deployments
  share a key.

## 4. What "multi-writer safe" does not mean

- **It is not an authorization model.** One shared operator key still grants equivalent authority
  to every replica. Reconciling reads improved *correctness*; it changed nothing about *who may do
  what*.
- **It is not per-user attribution.** Replicas do not create identity. There is still no account,
  role, tenant, or audit trail that distinguishes operators.
- **It is not a compliance control.** The session model is an engineering property.
- **It is not a distributed system.** Every guarantee above is a property of a single MongoDB
  document or index. Where that is insufficient, this document says so rather than adding a
  system.

See [multi-writer-model.md](../development/multi-writer-model.md) for the field-by-field model and
[live-read-consistency.md](../development/live-read-consistency.md) for what *current* means on
each read surface.
