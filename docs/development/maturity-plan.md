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

Last updated for the reference-corpus work (see `CHANGELOG.md` `[Unreleased]`).

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

Nothing in flight. The next item selected is the P0 audit (below).

## Next queue

Ordered by the value of the outcome, not by effort.

1. **P0 security and correctness audit.** A route-by-route pass over auth, CORS,
   body limits, the provider boundary, MongoDB query construction, session
   lifecycle, telemetry validation, the auditor whitelist, notifications and the
   console, answering the questions in the audit checklist rather than assuming
   the answers.

   **Remediated:**

   - The API had **no request body size limit at all** — `@hono/node-server`
     exposes no `bodyLimit` option and none was configured, so every route read
     whatever the caller sent. Hono's built-in `body-limit` middleware now
     refuses anything above `CERBERUS_MAX_BODY_BYTES` (default 8 MiB) with
     `413 PAYLOAD_TOO_LARGE`, before the auth middleware, so it applies to
     authenticated and unauthenticated callers alike. No new dependency.
   - Fields that reach a paid provider were unbounded. `prompt` (8 000 chars),
     `roleContext` (200), `question` (2 000) and telemetry batches (1 000 events)
     are now capped before any inference or persistence happens.
   - The auditor passed whatever the model's pipeline produced to the summariser,
     with no ceiling. It is now truncated to 200 records regardless of `$limit`.
   - `POST /api/v1/identity/set` cast a field to a string and called `.trim()` on
     it, so a numeric `displayName` threw inside the handler and surfaced as an
     unhandled 500. It now returns `400 INVALID_IDENTITY_FIELD`, and identity
     fields are length-capped.
   - Model-supplied numerics were **not clamped**. `parseRiskAssessment` accepted
     any finite number for `overallRiskScore`, `dimensionScores.*` and
     `flags[].confidence`, and `guardian.ts` only capped the blended score at the
     top, so a well-formed `-1e9` or `1e9` flowed through and would have corrupted
     threshold comparisons, sorting and the auto-lock. Every documented range is
     now clamped at the parser boundary, arrays and strings are bounded, and
     `exfiltrationReport` / `behavioralAnomalies` are parsed field by field
     instead of cast. Non-object array entries are dropped rather than becoming
     fieldless records. See
     [architecture.md](../architecture.md#6-score-composition-and-model-output-bounds).

   - Outbound notifications had **no timeout**. `notifySlack` and `sendEmail`
     called `fetch` with no `AbortSignal`, and ingestion awaits both before
     returning, so a hung webhook stalled the ingest request for as long as the
     socket stayed open — the notification path could block telemetry
     collection. Both now carry a 5 000 ms deadline, verified against a real
     server that accepts and never answers.
   - The identity registry was an unbounded in-memory `Map`. Every
     `POST /api/v1/identity/set` added an entry that was never evicted, while the
     `GET /me` handler already described an unknown handle as "unknown or
     expired" although nothing expired it. Handles now expire after 12 hours and
     the registry evicts expired entries, then the oldest, at a ceiling of 100.

   - `OpenAIProvider.isFatal()` decided fatality by substring-matching the error
     message for `"401"` / `"403"`. Any error whose text happened to contain those
     digits — a token count, a request id, a URL — was treated as an
     authentication failure and skipped the retry budget. It is now classified
     from the SDK error's HTTP status and machine-readable `code`.
   - `toMongoPipeline` used a raw `JSON.parse`, so a pipeline the model wrapped in
     a markdown fence or a sentence was discarded even though the rest of the
     boundary exists to tolerate exactly that. It now uses the same recovery
     ladder as every other model-reading path.
   - The MCP adapter's `parseBody` destroyed an oversized request without
     resolving its promise, so the handler hung and the client saw a connection
     reset instead of a status; and a malformed body was indistinguishable from a
     missing one, surfacing as a misleading "Missing required parameter". The
     parser is extracted into `packages/mcp-mongodb/src/body.ts`, always settles,
     and returns `413 PAYLOAD_TOO_LARGE`, `400 INVALID_JSON` or
     `400 INVALID_BODY` explicitly. The adapter reads the same
     `CERBERUS_MAX_BODY_BYTES` variable as the API so the two ceilings cannot
     drift. Verified against a real MongoDB and a real socket.

   **No open items.** Every finding from this audit pass is remediated, and the
   MCP package now has its own test suite wired into `npm test`. **Complete.**

2. **`DATA_LEAKAGE_SIMILARITY_THRESHOLD` gates the exfiltration matcher.**
   **Implemented.** The reference source was a stub returning `[]`, so
   `ExfiltrationReport` matches were always empty while the threshold was still
   parsed and documented.
   - The corpus is a local, operator-managed MongoDB collection
     (`reference_documents`) managed through `POST`/`GET`/`DELETE
     /api/v1/reference-documents`. **Cerberus never writes to it itself** — there
     is no crawler, no bundled corpus and no third-party content.
   - Similarity is computed **locally and deterministically**
     (`apps/api/src/services/text-similarity.ts`: normalise → 3-token shingles →
     Jaccard). The model's `exfiltrationReport` is replaced rather than merged,
     because only the local comparison is reproducible from inputs an operator can
     inspect — and because the model never sees the threshold.
   - The threshold is the gate: pairs at or above it become `ExfiltrationMatch`
     entries; pairs below it do not, though the best score is still reported so an
     operator can see how close a paste came.
   - `aiCompletionLikelihood` is always `0`: Cerberus does not attempt to
     determine whether content was machine-generated, and a guess there would
     present an unfounded number as a measurement.
   - Texts under 10 tokens are not compared at all, so two short strings cannot
     match by accident. The threshold itself is validated fail-closed to 0-1: a
     value above 1 could never be reached and would silently disable the matcher.
   - Verified through the full stack against real MongoDB and a stubbed provider:
     a near-copy paste produced a match at 0.854 with the corpus label, a
     half-overlap paste produced none at 0.474, and the provider's deliberately
     fabricated match was discarded.

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
| No `CODEOWNERS` file | Needs decision | Requires the maintainer to name real owners. A single-maintainer project may reasonably record that decision instead. |

## Decisions requiring the owner

These cannot be resolved by engineering judgement alone.

1. **`CODEOWNERS`.** Either name owners for `apps/api/`,
   `packages/mcp-mongodb/`, `apps/console/` and `docs/`, or record in
   `CONTRIBUTING.md` that a single-maintainer project does not use one.

The reference-corpus decision that used to sit here was resolved by implementing
the local design: an operator-managed collection compared with a transparent
deterministic algorithm, no external service and no spend. Nothing that would
require web crawling, a paid embedding provider or a vector-database service was
introduced.

Neither blocks the work above: the P0 audit is independent of both.

## Release readiness

**No new release is proposed.** `v0.1.0` remains the only published baseline and
its tag is immutable.

`main` accumulates changes under `[Unreleased]` in `CHANGELOG.md`. A release
candidate report is prepared when a coherent milestone has accumulated — not
because a number of commits have passed. Publishing a release, moving a tag or
declaring production readiness requires explicit maintainer authorisation.
