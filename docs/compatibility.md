# Compatibility, deprecation and dependency policy

What Cerberus treats as a public contract, how it changes, and how its
dependencies are chosen and kept current.

This document is a policy, not a description of the code. Where it names a
concrete value (a supported Node version, an audit result) that value is verified
and the verification is stated.

## 1. What counts as public

`v0.1.0` and `v0.2.0` are published, so the following are contracts. Changing one is
a breaking change, not a refactor:

| Surface | Where it is defined |
| --- | --- |
| Environment variables: names, defaults, accepted values, and whether they are required | `apps/api/src/config.ts`, `.env.example`, [configuration.md](configuration.md) |
| HTTP routes: paths, methods, success status codes and JSON response fields | `apps/api/src/index.ts`, the route modules, [architecture.md](architecture.md) |
| Stable error `code` values (`UNAUTHENTICATED`, `PAYLOAD_TOO_LARGE`, `SESSION_EXPIRED`, `CLASSIFIER_UNAVAILABLE`, …) | the route modules |
| MCP tool names and their argument names | `packages/mcp-mongodb/src/tool-names.ts`, mirrored in `apps/api/src/services/mcp-tool-names.ts` |
| MongoDB collection names | `COLLECTION_NAMES` in `packages/mcp-mongodb/src/tool-names.ts` |
| Session status values (`active`, `locked`, `terminated`) | `SESSION_STATUSES` in the same module |
| Session counter field names in API responses and MCP arguments | the route modules and `packages/mcp-mongodb/src/tools.ts` |
| The console's build contract: the `--dart-define` names it reads and the output directory it writes | `apps/console/lib/main.dart`, [configuration.md](configuration.md) |

## 1a. What the architecture-integrity cycle added to the public surface

All of it is **additive**. Every MCP change is an added optional argument, and every
renamed field keeps a deprecated alias, so an existing client keeps working without a
change. The full record is in
[development/architecture-integrity-checkpoint.md](development/architecture-integrity-checkpoint.md).

| Surface | Change | Kind |
| --- | --- | --- |
| `get_session_review` | optional `eventsLimit`, `includeAssessments`, `assessmentsLimit` | added |
| `set_session_status` | optional `expectedStatuses` compare-and-set predicate | added |
| `store_risk_assessment` | response gains `riskAssessmentId` and `inserted` | added |
| `store_reference_document` | response gains `created`, `count`, `limit`; a full corpus is `409` | added / behaviour |
| `update_session_counts` | accepts `focusLossCount`; `fullscreenExitCount` is deprecated and writes the same field | added / deprecated |
| Error codes | `REFERENCE_CORPUS_LIMIT_REACHED`, `SESSION_CONFLICT`, `SESSION_NOT_FOUND`, `SESSION_STORE_UNAVAILABLE`, `INVALID_SESSION_TRANSITION` | added |
| Session responses | `focusLossCount` alongside the deprecated `fullscreenExitCount` | added / deprecated |
| `behavioralContext` | `totalFocusLosses` alongside the deprecated `totalFullscreenExits` | added / deprecated |
| Ingest response | `telemetryPersisted`, `assessmentPersisted`; `acceptedCount`/`duplicateCount` omitted when the store did not answer | added / behaviour |
| Collection | `reference_corpus_meta` — one counter document for the corpus ceiling | added |
| Durable field | `monitored_sessions.focusLossCount` replaces `fullscreenExitCount`; migration `0003` renames it | **migration** |

Three changes are **observable** rather than additive, and each is a correction:

- `terminate` returns `503` where it used to return a misleading `404` for a session that
  exists, and `409 SESSION_CONFLICT` where it used to overwrite a concurrent change.
- `GET /api/v1/guardian/sessions` no longer lists terminated sessions, and its
  `lastEventTimestamp` is the durable server-written `updatedAt` rather than the newest
  client-supplied event timestamp.
- Ingest refuses a terminated session with `409 SESSION_TERMINATED`.

Under §4's pre-1.0 rule these may ship in a minor version, and each has the changelog
entry and migration note §2 requires.

Explicitly **not** public, and changeable without notice:

- internal module structure, file layout and function signatures inside
  `apps/api/src` and `packages/mcp-mongodb/src`;
- the session-state shape held in memory;
- log line wording (the `code` values and status codes are the contract, not the
  prose);
- the Flutter widget tree, route names inside the console, and its visual design;
- `docs/` content other than the guarantees this document makes.

## 1b. What the multi-writer cycle added to the public surface

Mostly **additive**. The two live read surfaces gained fields; one value changed meaning, and
it is recorded below. The record is in
[development/multi-writer-model.md](development/multi-writer-model.md) and
[development/live-read-consistency.md](development/live-read-consistency.md).

| Surface | Change | Kind |
| --- | --- | --- |
| `GET /api/v1/guardian/sessions` | response gains `reconciled: boolean` — false when the store did not answer, so the page could not be reconciled against the durable documents | added |
| `GET /api/v1/guardian/sessions` rows | each row gains `statusSource: "durable" \| "process-local"` | added |
| `GET /api/v1/guardian/sessions` rows | each row gains `ephemeralStateAvailable: boolean`, matching the field the detail surface already reports | added |
| `GET /api/v1/guardian/sessions/:sessionId` | the session object gains `statusSource: "durable" \| "process-local"` | added |
| `GET /api/v1/guardian/sessions/:sessionId` | the session object gains `reconciled: boolean` | added |
| `update_session_terminal_content` | optional `expectedStatuses` compare-and-set predicate and `onlyIfAbsent` gate; response gains `updated` | added |

Four changes are **observable** rather than additive, and each is a correction to a statement
that was false:

- **The live list now includes sessions this process did not deploy or ingest.** It was
  previously built from this process's own memory and consulted the database only when that
  memory was empty, so a session another API process was monitoring was absent from the page.
- **A session another process terminated stops appearing immediately, on both live surfaces.**
  The list previously kept it until its TTL elapsed, a transition happened to run through this
  process, or the process restarted; the detail reported `active` for it while the review
  surface reported `terminated`.
- **`riskIndex`, `overallRiskScore` and `peakRiskScore` are now the reconciled maximum** of
  this process's latest score and the durable peak, rather than this process's latest score
  alone. All three were already reported from a single value on every surface; the change is
  that a session another process scored no longer reads as `0` here. `peakRiskScore` is a peak,
  so the maximum is its documented meaning, and the other two follow it because they always
  have.
- **A `terminate` refused for a session that does not exist writes nothing.** The workspace used
  to be preserved *before* the transition, so a `404` terminate had already written content for
  a session that does not exist. Only the **write** moved; the workspace is still read while the
  session is live.

`update_session_terminal_content` also reports `updated`. `success` keeps its meaning — the call
was handled — so a caller reading only `success` is unaffected, and without either gate the write
stays unconditional, so an external MCP client that supplies neither sees no change.

No field name, type or status vocabulary changes, so an existing client needs no change: it
sees more rows, a corrected risk score, and new fields it can ignore. A client that needs to
know whether a response was checked against durable truth should require `reconciled: true`.

Still explicitly **not** public, and changeable without notice:

- the merge's internal shape, the reconciler's module path, and the
  `SessionTransitionCache` interface, all of which are internal to `apps/api/src`.

## 2. Breaking-change policy

Before breaking a public surface, in order:

1. **Ask whether it can be preserved cheaply.** If yes, preserve it. Adding an
   optional field, accepting a second spelling, or keeping a route that delegates
   to its replacement are all cheap and all preferable.
2. **If it cannot be preserved cheaply, do not publish it.** Prepare the change
   on a branch with:
   - an entry under `[Unreleased]` in `CHANGELOG.md` that names the surface and
     says what breaks;
   - a migration note — for a renamed collection, tool or field, an entry in
     [migration.md](migration.md); for a route or variable, the old and new
     spelling side by side;
   - the reason it could not be preserved.
3. **Publishing is a separate, human decision.** See section 5.

A breaking change must not be smuggled into a release note as a "fix". If a
published behaviour was wrong, correcting it is still a breaking change and is
documented as one.

### Unsafe aliases are not kept

Compatibility is preserved for *cheap* changes, not for *unsafe* ones. Cerberus
does not retain a compatibility shim that would keep a security hole open, a
deprecated authentication path alive, or a collection writable by an old code
path. When compatibility and safety conflict, safety wins and the break is
documented loudly.

## 3. Deprecation

There is no deprecation *mechanism* — no runtime warning headers, no
`Deprecation` response field. Deprecation here means a documentation state, and it
has three steps:

1. **Announced.** The surface is marked `Deprecated` in the document that owns it,
   with the replacement named and the reason stated. It keeps working.
2. **Removed.** The surface is deleted in a later change, with the removal
   recorded under `Changed` or `Removed` in `CHANGELOG.md` and the migration note
   from section 2.

A deprecation is not announced before its replacement exists. Because Cerberus is
pre-1.0 (section 5), the gap between the two steps may be short; the requirement
is that both are recorded, not that a fixed number of releases elapses.

### 3.1 Recorded removals

| Surface | Removed in | Replacement | Migration note |
| --- | --- | --- | --- |
| `cleared` as a session status value | `[Unreleased]` → `0.4.0` | Nothing. The value is not a state the system can reach: nothing ever produced it, `set_session_status` never accepted it, and the product's one "clear" behaviour — lifting a lock when the score falls — writes `active`. | **No action for a client.** `GET /api/v1/sessions/:id` never returns it, and the review detail's derived `flagged`/`investigating` values moved to a new `disposition` field in the same release. A **document** still holding `cleared` (or `flagged`, or `investigating`) is normalised to `active` on read and repaired to a real status on its next transition, so no data migration is required. |
| `flagged` / `investigating` under `SessionReviewResponse.status` | `[Unreleased]` → `0.4.0` | `SessionReviewResponse.disposition` | A client that branched on `status` for `flagged` must read `disposition`. `status` now carries the lifecycle state on every surface, which is what made the old behaviour a read-integrity defect: the review detail reported `flagged` while the review list reported `active` for the same session, and the console displayed such a session as LOCKED. |

## 4. Versioning

Cerberus follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html), with
the standard pre-1.0 caveat: **below `1.0.0`, a minor version may contain a
breaking change.** `0.x` signals that the shape of the system is still moving.

What that does *not* license:

- A breaking change still gets the section 2 treatment — changelog entry,
  migration note, stated reason.
- A version number is never bumped to mark activity. `0.1.0` → `0.2.0` means the
  contract moved or a capability landed, not that commits accumulated.
- `1.0.0` is a statement that the public surface is stable enough to promise.
  Nothing about the current maturity work makes that claim.

## 5. Release authority

`v0.1.0` and `v0.2.0` are published, and both tags are immutable. Both are
pre-releases. Publishing anything further, marking a release stable or latest, or
declaring production readiness requires an explicit human decision. Preparing a
release candidate — version plan, changelog, notes, a local tag — does not.

## 6. Supported runtimes

| Component | Requirement | Where it is declared |
| --- | --- | --- |
| API, MCP adapter | Node.js >= 20 | `engines.node` in `package.json` and both workspace manifests |
| CI | Node.js 22 | `.github/workflows/ci.yml` |
| Console | Flutter stable, Dart SDK ^3.9.2 | `apps/console/pubspec.yaml` |
| Database | MongoDB 7 (the Compose service and the documented default) | `docker-compose.yml` |

The declared floor is what the code is written against; CI exercises the current
LTS. A change that raises a floor is a breaking change for anyone self-hosting on
the old one, and gets the section 2 treatment.

## 7. Dependency policy

### Adding one

Before adding a dependency, answer:

- Can the standard library, or a dependency already present, do this? Cerberus
  has no date, validation, hashing or HTTP-client library, because Node provides
  them. The request body cap uses Hono's built-in `body-limit` middleware rather
  than a new package.
- Is it maintained, and does it have a plausible release cadence?
- Is its license compatible with Apache-2.0 (section 8)?
- What does it add to the browser bundle, if it reaches `apps/console`?
- How much of the security surface does it become? A dependency that parses
  untrusted input is a larger decision than one that formats a string.
- Is the lockfile churn justified by the value?

A dependency that fails any of these needs a reason recorded in the pull request,
not a silent addition.

### Updating

- **Security updates first**, always, and without waiting for a feature reason.
- **Toolchain and framework compatibility second.**
- **Feature upgrades only when the feature is wanted.** There is no
  "upgrade everything" change: a major bump arrives on its own, with the test
  suite run against it and the changelog recording anything observable.
- The lockfile is committed. `npm ci` is what CI and the documented local setup
  run, so an unrecorded dependency cannot reach a build.

### Current audit

Verified against the tree at the time of writing:

| Check | Command | Result |
| --- | --- | --- |
| Known vulnerabilities | `npm audit` | 0 |
| Runtime-only vulnerabilities | `npm audit --omit=dev --audit-level=high` | 0 |
| License compatibility | production dependency tree | 111 packages: MIT (92), ISC (7), Apache-2.0 (6), BSD-2-Clause (3), BSD-3-Clause (2). No GPL, AGPL, SSPL, BUSL or missing license. |

`npm audit --omit=dev --audit-level=high` runs on every CI build. It is marked
`continue-on-error` on purpose: a transitive advisory should be visible on a
documentation-only pull request without blocking it. **That makes it advisory, not
enforced** — triage is a maintainer action, and a green build does not mean the
audit was clean.

## 8. License

Cerberus is Apache-2.0 (`LICENSE`, `NOTICE`). Contributions are accepted under the
same license; there is no CLA. See [CONTRIBUTING.md](../CONTRIBUTING.md).

A dependency under a copyleft or non-commercial license cannot be added to the
shipped runtime. A development-only dependency under such a license needs an
explicit decision, because the distinction between "not shipped" and "not
distributed" is a legal question rather than an engineering one.

## 9. What this policy does not promise

- It does not promise that `0.x` is stable. Section 4 says the opposite.
- It does not promise that every change is backwards compatible — only that a
  break is recorded, explained and authorised.
- It does not make Cerberus production ready, and nothing in it should be read as
  a claim that it is.
