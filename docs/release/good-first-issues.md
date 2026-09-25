# Good first issue candidates — v0.1.0

Nine small, self-contained issue candidates collected during the extraction. Each
one was verified against the repository at the time of writing: the file paths and
line numbers below are citations, not estimates.

**Re-triaged against the release-prep tree before filing.** Of the nine, three
were fixed during the extraction and are kept only as a record (3, 5 and 7 — do
not file them), and one (8) had a premise that had already become false and has
been rewritten below. That leaves five genuinely open candidates.

Four are being filed. The status line on each section says which:

| # | Title | Filed as | Labels |
| --- | --- | --- | --- |
| 1 | `SESSION_TTL_SECONDS` is parsed but never enforced | Filed | `bug`, `help wanted` |
| 2 | `DATA_LEAKAGE_SIMILARITY_THRESHOLD` gates nothing | Deferred | — |
| 3 | Reconcile the session-status vocabulary | Already fixed | — |
| 4 | Send the console's risk weights as `severityMix` | Filed | `enhancement`, `help wanted` |
| 5 | Align the `LICENSE` and `NOTICE` copyright lines | Already fixed | — |
| 6 | Add an index for `docs/` | Filed | `documentation`, `good first issue` |
| 7 | Fix two documentation claims that are no longer true | Already fixed | — |
| 8 | Document the console web build output directory | Filed | `documentation`, `good first issue` |
| 9 | Add a `CODEOWNERS` file | Deferred | — |

The statuses above describe the triage as it stood when the issues were filed.
Three of the filed candidates were subsequently resolved on `main`:

- **1** — `SESSION_TTL_SECONDS` is now enforced, with expiry defined as
  active-liveness rather than evidence retention.
- **6** — `docs/index.md` exists and is linked from `README.md`.
- **8** — the console web build output directory (`apps/console/build/web`) is
  documented in `README.md` and `CONTRIBUTING.md`.

The section bodies below are kept as the historical record of the triage and are
not updated in place. Candidate 4 remains open.

Candidates 2 and 9 are real and still open, but each needs a maintainer decision
before a contributor can start: 2 needs a choice between building a reference
set and deleting the setting, and 9 needs the maintainer to name real owners. They
are recorded here rather than filed so the tracker stays free of issues that
cannot be started.

Before opening one of these as a GitHub issue:

1. Re-check it against the current commit. Line numbers move.
2. Apply the labels named above.
3. Add the acceptance criterion verbatim to the issue body, so "done" is not a
   matter of opinion.

The required labels already exist on the repository: `bug`, `enhancement`,
`documentation`, `good first issue` and `help wanted`.

---

## 1. Enforce `SESSION_TTL_SECONDS`, or remove it

> **Status: filed as a `bug` + `help wanted` issue.** The setting is verified
> inert, but the fix requires a maintainer choice between enforcing it and
> deleting it, so it is not labelled `good first issue`.

`SESSION_TTL_SECONDS` is documented as "session expiry in seconds", but nothing
in the codebase ever reads it. `loadConfig()` parses it into
`SecurityConfig.sessionTTLSeconds` and then no other module consumes that value,
so a session lives until it is terminated or deleted no matter what the setting
says. Either implement expiry (for example, a lazy sweep that drops
`sessionStore` and `activeSessions` entries whose last event is older than the
TTL) or delete the setting and the documentation that promises it.

**Files involved**

- `apps/api/src/config.ts:66` — `sessionTTLSeconds` declared on `SecurityConfig`.
- `apps/api/src/config.ts:191` — the only place the variable is read.
- `apps/api/src/routes/guardian.ts:85-87` — `sessionStore` and `activeSessions`,
  the two in-memory maps that hold live session state.
- `apps/api/src/routes/guardian.ts:535-663` — `GET /api/v1/guardian/sessions`,
  where an expired session would have to stop being reported as live.
- `apps/api/src/config.ts:64-73` — the `SecurityConfig` interface.
- `docs/architecture.md:343-344` — already documents the setting as parsed but
  not enforced.
- `docs/configuration.md:137` — the variable reference entry.
- `apps/api/test/helpers.ts:38` — the test config fixture that would need the new
  field if one is added.

**Acceptance criterion**

Either (a) a session whose most recent event is older than
`config.security.sessionTTLSeconds` is no longer returned by
`GET /api/v1/guardian/sessions` as a live session, and an automated test in
`apps/api/test/session-lifecycle.test.ts` asserts the boundary using an injected
TTL; or (b) `SESSION_TTL_SECONDS` no longer appears in `config.ts`,
`docs/configuration.md`, `docs/architecture.md`, `README.md`,
`docs/security/threat-model.md`, `.env.example`, `docker-compose.yml` or
`apps/api/test/helpers.ts`, and `docs/architecture.md` records that session
lifetime is unbounded by design.

**Difficulty**

Medium. The code change is small, but it changes observable behaviour of the
session list and needs a test plus a documentation update. If the maintainers
prefer option (b), it drops to easy — it becomes a pure deletion across the eight
files listed above.

**Evidence:** confirmed by inspection. A repository-wide search for
`sessionTTLSeconds` / `SESSION_TTL_SECONDS` across every file (excluding
`node_modules`, `dist`, `build` and `.dart_tool`) returns only the declaration,
the assignment, the test fixture, and documentation — no consumer, and no sweep.

---

## 2. Make `DATA_LEAKAGE_SIMILARITY_THRESHOLD` do something, or delete it

> **Status: deferred — not filed.** The gap is real and verified, but option (a)
> needs a data source for reference completions and option (b) reaches into the
> scenario contract and the Flutter model, so it needs a maintainer decision
> first. Filing it as a beginner issue would set a contributor up to fail.

`DATA_LEAKAGE_SIMILARITY_THRESHOLD` is parsed into configuration and passed into
the risk-analysis prompt, but the similarity comparison it is supposed to gate
can never match, because the reference-completion source is a stub that returns
an empty array. The effect is that `ExfiltrationReport.matchedSnippets` is always
empty and the threshold is decorative. Either populate the reference set and
apply the threshold when scoring matches, or remove the setting and stop
advertising similarity matching.

**Files involved**

- `apps/api/src/config.ts:72` — `dataLeakageSimilarityThreshold` declared.
- `apps/api/src/config.ts:194-197` — read from the environment.
- `apps/api/src/routes/guardian.ts:1045-1047` — `getReferenceCompletions()`
  returns `[]`.
- `apps/api/src/routes/guardian.ts:222-227` — the empty array is passed into
  `analyzeRisk()`.
- `apps/api/src/ai/provider.ts:565-570` — with an empty list the prompt says
  "No reference completions available."
- `apps/api/src/types.ts:270-281` — `ExfiltrationReport` / `ExfiltrationMatch`,
  the contract that currently always comes back empty.
- `docs/configuration.md:148-151` — already documents the setting as inert.
- `docs/architecture.md:340-343` — same, in the roadmap gaps section.

**Acceptance criterion**

Either (a) `getReferenceCompletions()` returns a populated, non-empty set that is
compared against paste content, and a test asserts that a paste above the
configured threshold produces at least one `ExfiltrationMatch` while one below it
does not; or (b) `DATA_LEAKAGE_SIMILARITY_THRESHOLD` is removed from `config.ts`,
`.env.example`, `docker-compose.yml`, `docs/configuration.md`, `README.md` and
`docs/architecture.md`, and `ExfiltrationReport` is documented as
contract-only.

**Difficulty**

Not beginner-suitable in either direction. Option (a) is a real feature and needs
a data source for reference completions, which is a design decision. Option (b)
looks mechanical but is not: the same constant also lives in
`apps/api/src/types.ts:120` (`AntiExfiltrationThresholds`),
`apps/api/src/ai/parsers.ts:240` (the default thresholds object),
`apps/api/test/helpers.ts:41`, `apps/api/test/parsers.test.ts:242-243`, and
`apps/console/lib/models/scenario_model.dart:374,382,393-394`; and
`ExfiltrationReport` is a live field (`apps/api/src/types.ts:211`, parsed at
`apps/api/src/ai/parsers.ts:216`). Removal touches the scenario contract and the
console model, so it needs a maintainer to decide the shape first.

**Evidence:** confirmed by inspection. `getReferenceCompletions` at
`apps/api/src/routes/guardian.ts:1045-1047` has a body of `return [];`, and its
doc comment states the historical cache "was never populated".

---

## 3. Reconcile the session-status vocabulary

> **Status: already fixed during extraction.** Fixed by
> `fix(api): never resurrect a terminated session after a restart`. Session
> creation now writes `status: "active"` (`guardian.ts:760`), `createSession`
> defaults to `"active"` and honours a caller-supplied status
> (`mongo-client.ts:148-166`), and `normalizeStatus` recognises `terminated`
> through `PERSISTED_SESSION_STATUSES` (`guardian.ts:983-999`). Regression tests
> exist at `apps/api/test/dedup.test.ts:238-248`. The residual vocabulary spread
> is documented as a deliberate deferral in `docs/architecture.md:345-352`. Kept
> here as a record; do not re-file it as an issue.

Three different sets of session status values exist in the codebase, and a fourth
behaviour sits on top of them. `ActiveSession` permits five values, the MCP
adapter's `SESSION_STATUSES` permits three, session creation writes a seventh
value (`in_progress`) that the MCP status tool would reject, and `normalizeStatus`
does not recognise `terminated` at all — so a session that was terminated through
the durable store is reported as `active` when it is recovered from MongoDB. Pick
one vocabulary, use it in all four places, and make the recovery path preserve a
terminated session's state.

**Files involved**

- `apps/api/src/types.ts:340-348` — `ActiveSession.status`:
  `active | flagged | investigating | cleared | locked`.
- `packages/mcp-mongodb/src/tool-names.ts:56-58` — `SESSION_STATUSES`:
  `active | locked | terminated`.
- `apps/api/src/routes/guardian.ts:757` — `create_session` is called with
  `status: "in_progress"`.
- `packages/mcp-mongodb/src/tools.ts:290-299` — `set_session_status` rejects any
  value not in `SESSION_STATUSES` with HTTP 400.
- `packages/mcp-mongodb/src/mongo-client.ts:132-147` — `createSession` ignores the
  caller's status and hardcodes `status: "in_progress"` in `$setOnInsert`.
- `apps/api/src/routes/guardian.ts:973-982` — `normalizeStatus` accepts only the
  five `ActiveSession` values and maps everything else to `"active"`.
- `apps/api/src/routes/guardian.ts:619` — `normalizeStatus` applied to the status
  read back from MongoDB.
- `apps/api/src/types.ts:352-361` — `SessionReviewResponse.status`, which is a
  third list (the five plus `terminated`).
- `docs/architecture.md:346-352` — already documents the inconsistency.

**Acceptance criterion**

A single exported status vocabulary is the only one used by `ActiveSession`,
`SESSION_STATUSES`, `SessionReviewResponse` and session creation; `normalizeStatus`
recognises every value in it, including `terminated`; and an automated test
asserts that a session persisted with status `terminated` is still reported as
`terminated` by `GET /api/v1/guardian/sessions` after the in-memory store is
emptied. `flutter analyze` and `npm run typecheck` stay clean.

**Difficulty**

Medium. The change itself is small, but it touches the API types, the MCP
package's canonical constants and the review contract, so it needs care to stay
backwards-compatible with existing documents. Good for a contributor who is
comfortable reading TypeScript across two workspaces.

**Evidence:** confirmed by inspection at the cited lines. The claim that the MCP
tool "would reject" `in_progress` is exact: `set_session_status` validates
against `SESSION_STATUSES` (`packages/mcp-mongodb/src/tools.ts:293-296`), while
`create_session` does not validate at all and overwrites the value with
`in_progress` (`packages/mcp-mongodb/src/mongo-client.ts:139`).

---

## 4. Send the console's risk-distribution weights as `severityMix`

> **Status: filed as an `enhancement` + `help wanted` issue.** Every citation
> below was re-verified against the release-prep tree and is exact. The three
> sliders map onto four severity keys, which is a product decision, so it is not
> labelled `good first issue`.

The scenario panel exposes three "Risk Distribution Weights" sliders, but the
values never leave the client as structured data: they are interpolated into the
prompt string, and the request body carries only `prompt`, `roleContext` and
`vectorCount`. The API accepts a `severityMix` object with `low`, `medium`,
`high` and `critical` keys and normalises it, so the sliders can be wired to the
real contract instead of being smuggled through prose.

**Files involved**

- `apps/console/lib/widgets/scenario_panel.dart:277-279` — `_routineWeight`,
  `_elevatedWeight`, `_criticalWeight`.
- `apps/console/lib/widgets/scenario_panel.dart:954-1004` — the sliders and the
  "Risk Distribution Weights" label.
- `apps/console/lib/widgets/scenario_panel.dart:602-610` —
  `_buildStructuredPrompt`, which folds the three weights into a
  "Risk distribution: N% routine, N% elevated, N% critical" line.
- `apps/console/lib/services/api_service.dart:124-146` — `authorScenario`, whose
  JSON body has no `severityMix` key.
- `apps/console/lib/providers/scenario_provider.dart:160-172` — the provider call
  that would need to forward the mix.
- `apps/api/src/types.ts:294-299` — `ThreatScenarioRequest`, which already
  declares `severityMix`.
- `apps/api/src/routes/scenarios.ts:195-203` — `vectorCount` is validated and
  `normalizeSeverityMix(body.severityMix)` is applied.
- `apps/api/src/routes/scenarios.ts:449-476` — `normalizeSeverityMix`, which
  renormalises any four weights to sum to 1.0.

**Acceptance criterion**

Changing a slider changes the request body: `authorScenario` sends a
`severityMix` object with `low`/`medium`/`high`/`critical` keys derived from the
three sliders (routine → `low`, elevated → `medium`, critical split across
`high` and `critical`, or an equivalent documented mapping), and the generated
matrix's severity distribution reflects it. `flutter analyze` and
`flutter test` stay clean.

**Difficulty**

Easy to medium. It is a single client-side data-plumbing change with no server
work, but the mapping from three sliders to four severity keys is a product
decision that needs a maintainer's answer before the code is written.

**Evidence:** confirmed by inspection at the release-prep tree. The panel sliders
and the prompt-folding line are cited above, and `api_service.dart:141-145` shows
a three-key body. The API side is verified by `scenarios.ts:203` and
`normalizeSeverityMix` at `scenarios.ts:449`. `severityMix` appears nowhere under
`apps/console/lib`. `flutter analyze` is clean at this commit, so the console is
safe to edit again.

---

## 5. Align the `LICENSE` and `NOTICE` copyright lines

> **Status: already fixed during extraction.** `NOTICE:2` now carries the same
> line as `LICENSE:189`. Kept here as a record; do not re-file it as an issue.

The repository shipped two copyright lines naming different owners, which made
attribution ambiguous for anyone redistributing Cerberus. `LICENSE` names an
individual plus "Cerberus AI Contributors"; `NOTICE` named "The Cerberus
Authors".

**Files involved**

- `LICENSE:189` — `Copyright 2026 Muhammad Bilal Raza Lodhi (Cerberus AI
  Contributors)`.
- `NOTICE:2` — now identical to the line above.

**Acceptance criterion**

The copyright holder named in `LICENSE` and in `NOTICE` is identical, both lines
carry the same year, and `NOTICE` still states that the project is not affiliated
with, endorsed by or sponsored by Google, OpenAI or MongoDB.

**Difficulty**

Trivial — a two-line documentation change. It needs one maintainer decision (who
the copyright holder is), which makes it a good first issue for someone who
simply wants to make a first contribution to the repository's paperwork.

**Evidence:** confirmed by inspection of both files.

---

## 6. Add an index for `docs/`

> **Status: filed as a `documentation` + `good first issue` issue.** Re-verified:
> no `docs/index.md` and no `docs/README.md` exists, and the corrected file count
> is nine.

`docs/` contains nine documents and no entry point. `README.md` links each one
individually, but a reader who lands in `docs/` — or who follows a link to
`docs/architecture.md` and wants to know what else is there — has no table of
contents. Add a short index that lists each document with a one-line description
and the audience it is for.

**Files involved**

- `docs/` — nine tracked files: `architecture.md`, `configuration.md`,
  `migration.md`, `security/threat-model.md`, and the five release-preparation
  documents under `docs/release/` (`community-health-checklist.md`,
  `good-first-issues.md`, `release-checklist.md`, `repository-metadata.md`,
  `v0.1.0-release-notes.md`).
- `docs/index.md` (new) or `docs/README.md` (new).
- `README.md:293-301` — the existing documentation list, which the new index
  should stay consistent with.

**Acceptance criterion**

`docs/index.md` or `docs/README.md` exists; it links every file under `docs/`
including `docs/security/threat-model.md` and the `docs/release/` set; every link
resolves; and `README.md` links to the new index instead of, or in addition to,
listing each document.

**Difficulty**

Trivial. Pure documentation, no code, no build step. This is the easiest item on
the list and is a good way to learn how the documentation set fits together.

**Evidence:** confirmed by inspection of the `docs/` tree.

---

## 7. Fix two documentation claims that are no longer true

> **Status: already fixed during extraction.** The `README.md` note was removed
> and `docs/architecture.md` now describes the test suite as present. Kept here
> as a record; do not re-file it as an issue.

Two documents described files as absent when those files exist. `README.md` told
readers that `SECURITY.md` was not in the tree and to report issues privately
instead, and `docs/architecture.md` said the API test directory was not present
in this release. Both statements misled a contributor about what is actually
shipped, and both needed correcting rather than deleting the files they
describe.

**Files involved**

- `README.md` — the note claiming `SECURITY.md` "is not yet present in the tree".
- `SECURITY.md` — exists, and describes private vulnerability reporting.
- `docs/architecture.md` — the claim that the test directory "is not present
  in this release".
- `apps/api/test/` — exists and holds eight test files: `auth.test.ts`,
  `dedup.test.ts`, `helpers.ts`, `mcp-tool-mapping.test.ts`, `parsers.test.ts`,
  `persistence-naming.test.ts`, `scenarios.test.ts`, `session-lifecycle.test.ts`.
- `apps/api/test/mcp-tool-mapping.test.ts` — the specific test
  `docs/architecture.md` claims is missing.

**Acceptance criterion**

`README.md` no longer states that `SECURITY.md` is absent, and its security
section links to the file; `docs/architecture.md` no longer states that the test
directory is absent, and instead names `apps/api/test/` as the location of the
`node:test` suites run by `npm test`. Neither change adds a claim that is not
verifiable from the tree.

**Difficulty**

Trivial. Two documentation edits, and the evidence for both is a directory
listing.

**Evidence:** confirmed by inspection. `SECURITY.md` is present at the repository
root (130 lines), and `apps/api/test/` contains the eight files listed above;
`npm test` runs them.

---

## 8. Document the console web build output directory

> **Status: rewritten and filed as a `documentation` + `good first issue`
> issue.** The original draft claimed nothing documented a production web build.
> That was already false when it was written: `README.md` documents
> `flutter build web --release` with both `--dart-define` values. The real,
> narrower gap is below.

`README.md` shows how to produce a deployable console bundle, but it never says
where the bundle lands, and `CONTRIBUTING.md` stops at `flutter run -d chrome`,
which is a development command. A contributor who follows either document has to
guess the output directory before they can serve the bundle.

**Files involved**

- `README.md:162-172` — the `flutter build web --release` block. It sets both
  defines but never names the output directory.
- `CONTRIBUTING.md:76-86` — the console command block, which stops at
  `flutter run` and has no build step at all.
- `apps/console/web/index.html:15` — notes that a `--base-href` argument is
  expected from `flutter build`.
- `apps/console/lib/main.dart:28-35` — reads `API_BASE_URL` and
  `CERBERUS_API_KEY` through `String.fromEnvironment`, so any documented build
  command must set both defines.
- `docker-compose.yml:11-12` — the comment stating the console is not
  containerised and pointing at `flutter run -d chrome`.
- `SECURITY.md:113-114` — mentions the console's build-time
  `--dart-define=CERBERUS_API_KEY=...` value.

**Acceptance criterion**

`README.md` states the output directory produced by `flutter build web --release`
(and it is the directory Flutter actually writes to when the documented command
is run from `apps/console`), and `CONTRIBUTING.md` gains the same build command
so the two documents agree. The documented command succeeds from a clean
checkout.

**Difficulty**

Trivial. Two documentation edits, plus running the documented command once to
confirm the output path. No Compose service is required — the original draft's
optional static-file-server service is out of scope for a first contribution.

**Evidence:** confirmed by inspection. `git grep -n "flutter build"` returns
`README.md:165` and `apps/console/web/index.html:15`; `build/web` appears
nowhere in `README.md` or `CONTRIBUTING.md`; and `CONTRIBUTING.md`'s console
block contains only `flutter pub get`, `flutter analyze`, `dart format` and
`flutter run`.

---

## 9. Add a `CODEOWNERS` file

> **Status: deferred — not filed.** Still accurate: no `CODEOWNERS` file exists
> anywhere. It is not a beginner issue, because the acceptance criterion requires
> every handle to be a real GitHub user or team, which only the maintainer can
> supply. It becomes fileable the moment the maintainer names the owners.

GitHub looks for a `CODEOWNERS` file to decide who reviews a pull request, and
this repository has none — so no review is requested automatically on any path.
The repository is a four-way split between the API, the MCP server, the Flutter
console and the documentation, which is exactly the shape `CODEOWNERS` is for.

**Files involved**

- `.github/CODEOWNERS` (new). `.github/` currently contains only
  `ISSUE_TEMPLATE/`, `workflows/` and `pull_request_template.md`.
- `CONTRIBUTING.md:146-160` — the pull-request expectations, where the review
  model should be described.
- `.github/pull_request_template.md:23-31` — the "Scope boundaries" section that
  a reviewer uses to confirm a change stayed in its slice.

**Acceptance criterion**

`.github/CODEOWNERS` exists, assigns a default owner for the repository, and
names owners for `apps/api/`, `packages/mcp-mongodb/`, `apps/console/` and
`docs/`; every handle in the file is a real GitHub user or team; and
`CONTRIBUTING.md` states that a review is requested automatically through
`CODEOWNERS`.

**Difficulty**

Trivial in mechanics, but it needs a maintainer decision about who owns which
path, so it is only suitable for a contributor who has already asked. If the
maintainers decide a single-maintainer project does not need it, the correct
outcome is to record that decision in `CONTRIBUTING.md` instead and close the
issue — see `docs/release/community-health-checklist.md`.

**Evidence:** confirmed by inspection. No `CODEOWNERS` file exists anywhere in
the repository, and `.github/` contains no such file.
