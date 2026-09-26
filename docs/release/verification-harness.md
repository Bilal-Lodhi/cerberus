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
npm run verify:packages
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
| `idempotency-guard` | The paid-operation claim's unique and retention indexes are named where a restore checks them, the shared index specification still matches that list, the two tool-name declarations agree, and the suites that prove the mechanism are still in the test glob — **all without a database** | `npm run verify:idempotency` |
| `secret-guards` | No tracked credential file, no retired deployment identity, and no publishing command in this directory | `npm run verify:secrets` |
| `private-packages` | Every workspace package is unpublishable by construction | `npm run verify:packages` |
| `attribution-guard` | No commit in range presents a non-existent contributor | `npm run verify:attribution` |
| `backup-restore-drill` | A disposable database is backed up, restored into a scratch database, and verified — counts, uniqueness guarantees, and every refusal | `npm run verify:backup` |
| `stale-image-defence` | The image is built `--no-cache` from this tree, and its recorded version and commit match the source and the running container | `npm run verify:image` |
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

## Reproducing it in CI

`npm run verify:release` was, for `v0.4.0`, a command a maintainer ran on their own machine.
That is one step better than a checklist and one step short of a gate: the evidence existed,
but nobody else could produce it, and a step that depends on a local Docker daemon and a
local MongoDB is a step whose result nobody can re-check.

[`.github/workflows/release-verification.yml`](../../.github/workflows/release-verification.yml)
runs **exactly that command** on `workflow_dispatch`, so the thing CI exercises is the thing
an operator runs. It is manual rather than per-pull-request because the real-database suite
and the container build are slow, and because a release drill is a decision someone makes.

What it guarantees:

| Property | How |
| --- | --- |
| **Never publishes** | No step can push, publish, tag or create a release; the `secret-guards` step fails the run if a publishing command appears under `scripts/release/` |
| **No paid AI** | The provider boundary is stubbed exactly as the test suite stubs it, so no provider credential is needed and nothing is spent |
| **No repository secret** | The only credential-shaped value is the disposable database's own loopback connection string |
| **MongoDB is present** | A `mongo:7` service container, plus a step that pings it and **fails** if it does not answer |
| **Nothing is skipped** | The harness's recorded output is grepped for `SKIPPED`; a skipped step fails the run |
| **Minimal permissions** | `contents: read`, and nothing else |
| **Bounded** | A 45-minute job timeout; the container and the database are service/runner resources, so nothing is left behind |
| **No secret in an artifact** | The only artifact is the harness's own log, which holds a loopback address and nothing else |

The `skip_console` input exists for a drill that is deliberately not about the Flutter
console. It is off by default, and turning it on makes the console steps *not run* rather
than *pass* — the harness still reports them as absent.

## The private-package guard

`npm run verify:packages` asserts that **no workspace package can be uploaded to a registry
by accident**. `packages/mcp-mongodb` shipped without `"private": true` through four
releases, so the only thing standing between this tree and a published
`@cerberus/mcp-mongodb` was nobody happening to type the command.

That asymmetry is why this is a guard rather than a convention. Every other mistake in this
repository is recoverable by a later commit; a registry upload is not — an unpublished
version number stays burned, and the name is claimed.

The rule, from `scripts/release/private-packages.mjs`:

- every workspace package must set `"private": true`, or be named in the guard's
  `PUBLISHABLE` allowlist **with a reason**;
- the root manifest is checked too, since it is the package a publication run from the
  repository root would act on;
- a workspace entry that resolves to no directory, a directory with no manifest, a duplicate
  package name, and a **stale allowlist entry** each fail — every one of them is a way for
  the guarantee to be silently turned off while the guard still reports OK.

`PUBLISHABLE` is empty on purpose: Cerberus publishes no npm package. The map exists so that
deciding otherwise is an explicit, reviewable edit rather than a missing field.

The guard's rules are asserted by
[`apps/api/test/release/private-packages.test.ts`](../../apps/api/test/release/private-packages.test.ts),
which drives each refusal over a disposable fixture tree. A guard verified only against a
tree that already passes proves it can say OK, not that it can say no.

## The attribution guard

`npm run verify:attribution` rejects a commit that presents a **contributor who cannot
exist**. It exists because eleven commits merged after `v0.3.0` carry
`Co-authored-by: Cerberus Maintainer <maintainer@cerberus.invalid>` — the cause was a single
one (the branch commits were authored with a synthetic `user.email`, and the squash merge
recorded a co-author for an author that differed from the pull request's), and the scope is
larger than a single commit. `.invalid` is reserved by RFC 2606 and can never be
deliverable.

It rejects, **in the commits being introduced only**:

- an author, committer or trailer address in a **reserved domain** — `.invalid`, `.test`,
  `.localhost`, and the RFC 2606 documentation domains;
- an attribution trailer naming a **synthetic maintainer identity** by name, whatever its
  domain.

It **allows** legitimate external contributors, and bot identities such as
`dependabot[bot]@users.noreply.github.com` — a guard that rejected real automation would be
turned off within a week. A name that is genuinely needed goes in
`scripts/release/attribution-allowlist.json` **with a reason**.

**It is prospective by construction**, and that is the point:

```bash
npm run verify:attribution                     # origin/main..HEAD — passes on the current tree
npm run verify:attribution -- --range A..B     # what CI passes
npm run verify:attribution -- --all            # diagnostic: reports the eleven, exits non-zero
```

Public history is **not** rewritten to remove the eleven: rewriting a published branch is
destructive, and the authorship on `main` is intact — every merge commit's author and
committer are the real GitHub identity and `GitHub <noreply@github.com>`. Only the message
trailers carry the synthetic name. The guard therefore passes on a history that already
contains one, and fails on a new one.

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

## The stale-image defence

The `v0.3.0` verification reused an **old container image**. Nothing compared what the image
was built from against the source it was supposed to be built from, so an image from an
earlier commit was verified as though it were the release — and every check passed, because
every check was about the old image.

`npm run verify:image` closes that:

1. builds the image with **`--no-cache`**, so no layer can come from an earlier source tree;
2. tags it uniquely per run, so nothing can pick up a previous tag by accident;
3. passes the working tree's version and commit in as build arguments, which the `Dockerfile`
   bakes into the image's **labels** and environment;
4. reads the labels back from the built image and compares them with the working tree;
5. starts the container and asks its `/health` what version it reports, so the **running
   process** is checked rather than only its metadata;
6. asserts the metadata carries nothing but a version and a commit.

The provenance lives in image labels rather than in the `/health` response on purpose:
`/health` is public and unauthenticated, and publishing the exact commit a deployment runs
tells an attacker which build to look up. An operator with `docker inspect`, or with
`docker exec <container> printenv CERBERUS_BUILD_COMMIT`, can still read it.

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
