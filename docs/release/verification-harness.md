# The release verification harness

`npm run verify:release` runs every release-critical check, in order, and reports each
one's outcome. It **never publishes anything**.

The problem it exists for: the `v0.3.0` verification was a session — a sequence of commands
run by hand, with the results written into a checklist. Two of the gates were re-run rather
than repeated, and the container gate was verified against a **stale image**, because
nothing compared the image's version against the source it was supposed to be built from.
A gate that lives in one person's terminal is not a gate.

## Running it

```bash
# Everything. Needs a MongoDB for the integration step, or that step is skipped.
CERBERUS_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm run verify:release

# The plan, without running it.
npm run verify:release -- --list

# One or more steps.
npm run verify:release -- --only docs --only version-census

# Any single check, on its own.
npm run verify:version
npm run verify:config
npm run verify:secrets
npm run typecheck:tests
```

On Windows, `$env:CERBERUS_TEST_MONGODB_URI = "mongodb://127.0.0.1:27017"` before the
command.

## What it runs

| Step | What it proves | npm script |
| --- | --- | --- |
| `build` | The TypeScript compiles, and the entrypoints the `Dockerfile` expects exist | `npm run build` |
| `typecheck` | The product sources typecheck | `npm run typecheck` |
| `typecheck-tests` | **The test tree typechecks**, which nothing else covers | `npm run typecheck:tests` |
| `test` | The unit suites pass with no database; the real-database halves skip here | `npm test` |
| `test-integration` | The same suites with every real-database half actually run | `npm test` with `CERBERUS_TEST_MONGODB_URI` |
| `migrations-previous-release` | **A published release's database is upgraded by this build** — dry run, migrate, validate, re-run | `npm run test:migrations` |
| `docs` | Every relative link and heading anchor resolves | `npm run check:docs` |
| `version-census` | Every version declaration agrees with `package.json` | `npm run verify:version` |
| `config-census` | Every environment variable read is documented, and every one documented is read | `npm run verify:config` |
| `secret-guards` | No tracked credential file, no retired deployment identity, and no publishing command in this directory | `npm run verify:secrets` |
| `console-format` | The Flutter sources are formatted, which `flutter analyze` does not check | `npm run console:format` |
| `console-analyze` | The Flutter console analyses clean | `npm run console:analyze` |
| `console-test` | The Flutter widget and release-claim tests pass | `npm run console:test` |

Every step is an npm script, so the harness and a maintainer run the same thing. Adding a
step means adding a script and one entry to the plan in
`scripts/release/verify-release.mjs`.

## A skip is not a pass

A step whose precondition is absent is **skipped with the reason printed**, and the
summary counts it separately:

```
  PASS    test-integration   18.0s
  SKIPPED docs               ...
```

A harness that reported a skip as a pass would be green for the wrong reason, which this
repository's own documentation warns about. The
[release-verification workflow](../../.github/workflows/release-verification.yml) asserts
that nothing was skipped, because it provides the only precondition any step has.

## It never publishes

No executable file under `scripts/release/` may contain a publishing command. The list
lives in `scripts/release/publish-guard.json` and covers `npm publish`, `npm run publish`,
`git push`, `docker push`, `gh release create` and `gh release upload`; the
`secret-guards` step fails if one appears, so the harness cannot grow a publishing step
without the guard failing first.

Two details are worth knowing, because getting them wrong is how the guard was first
written:

- **Comments are stripped before the scan.** A command described in a comment cannot run,
  and the first version reported four mentions of these commands in its own documentation.
  The stripper is a scanner rather than a regular expression, so a `https://` inside a
  string survives.
- **The patterns live in a JSON data file, not in the guard.** A pattern written inside the
  file being scanned is a match for itself — the first version reported its own label table.
  A JSON file is also not scanned, which is safe rather than convenient: nothing in it can
  execute.
- **Each pattern allows a short run of punctuation between the words.** The realistic form
  is `execFileSync("git", ["push"])`, which a literal `git push` pattern does not match. The
  first version missed exactly that.

Release publication is a separate, human decision. See
[release-checklist.md](release-checklist.md) and
[v0.3.0-checklist.md](v0.3.0-checklist.md) for what that decision involves.

## The two censuses

These are the two checks that are not a command anyone would run by hand, and both found
real drift the first time they ran.

**`verify:version`** reads every place the product version is declared — the three
`package.json` files, `SERVICE_VERSION` in the API's health route, `MCP_SERVER_VERSION` in
the MCP package, and the Flutter console's `pubspec.yaml` — and compares each against the
root `package.json`, which is the authority. It also asserts the changelog has both an
`## [Unreleased]` section and a section for the declared version.

**`verify:config`** extracts every environment variable the code reads (`readEnv("X")`,
`readInt("X", …)`, `process.env["X"]`, …) and every one the documentation describes (the
table rows in `configuration.md`, the assignments in `.env.example`), then fails in **both**
directions:

- read but undocumented — a knob nobody can find, and therefore one that will be set
  wrongly;
- documented but unread — worse, because an operator sets it, restarts, and nothing
  changes, with no error to explain why.

A name that is legitimately read outside the scanned trees (the Flutter console's
`--dart-define` values, the test suite's own database URI) is listed in `READ_ELSEWHERE` in
the script **with its reason**, so the exemption is a claim rather than a silent gap. An
entry that becomes unnecessary fails the check too.

## The upgrade gate

`npm run test:migrations` takes a database as a **published release** left it and walks the
documented upgrade: dry run, migrate, validate, re-run. Against a real MongoDB, because the
things being verified are things only a real database does — an index that cannot be built
over duplicates, a field renamed in place, a ledger row.

The historical shape lives in `apps/api/test/support/release-fixture.ts`, described **once**
and derived from the published release notes rather than from the code:

| Release | Migrations applied | Focus-loss field | Duplicate assessment identity |
| --- | --- | --- | --- |
| `v0.2.0` | `0001` only | `fullscreenExitCount`, plus `focusLossCount` — the mixed state | possible; `0002` exists to remove it |
| `v0.3.0` | all three | `focusLossCount` | not possible |

Each entry names its source in the release notes, so the claim can be checked rather than
trusted. That is the whole point: `docs/development/failure-semantics.md` records that a
hand-built migration test drifts from the historical state it claims to represent, and keeps
passing against a shape no deployment ever had.

The gate asserts, for `v0.2.0`:

- the dry run reports exactly `0002` and `0003` pending and changes nothing — not the
  documents, not the field name;
- migrating removes the duplicate `riskAssessmentId` and renames the counter, **keeping the
  larger of the two values** the mixed document held;
- the ledger then records every migration as applied;
- `ensureIndexes()` succeeds afterwards — the ordering only a real database can prove, since
  the unique index cannot exist while two rows share an id;
- a second run applies nothing and removes nothing;
- the upgraded data is readable through the store under the new field name.

And for `v0.3.0`, that nothing is pending, a run applies nothing, and the documented
`connect()` path is idempotent end to end.

## `typecheck:tests`

`apps/api/tsconfig.json` excludes `test/`, which is right for emit — a test file must not
be compiled into `dist/`. The effect was that **no test file was typechecked by anything**:
`npm test` runs through `tsx`, which strips types without checking them. A test could assert
against a field that no longer exists and only fail at runtime, or pass while testing
something else.

`apps/api/tsconfig.test.json` covers the test tree, and the check found six classes of
drift the first time it ran:

| Drift | Consequence |
| --- | --- |
| A local response interface was missing `telemetryPersisted` | The test's own type disagreed with the response it was asserting against |
| `MongoServerError` was used without an import | The suite exercised a lookalike rather than the class the runner checks with `instanceof` |
| Three raw-collection filters passed a `string` where the driver inferred `ObjectId` | Untyped access to the corpus counter document |
| Two test helpers inferred a template-literal UUID type from `randomUUID()` | Any literal event id was a type error |
| The contract suite's `storeReferenceDocument` return type was stale | The interface no longer described the store it exists to describe |

## Related documents

- [release-checklist.md](release-checklist.md) — the gates verified before `v0.1.0`, and
  the evidence recorded for each.
- [v0.3.0-checklist.md](v0.3.0-checklist.md) — the gates worked through for `v0.3.0`,
  including the ones that had to be re-run rather than assumed.
- [../development/operability-model.md](../development/operability-model.md) — what the
  system can be observed doing, which is what most of these checks are about.
