# Release checklist — v0.1.0

Ordered, checkable steps for publishing the first independent open-source
release of Cerberus. Every item is an action with a verifiable outcome. Nothing
here is a formality: if an item cannot be checked, the release does not ship.

Run every command from the repository root unless the step says otherwise.

---

## Phase 0 — Do not publish until

Hard blockers. If any line below is still open, stop and fix it first.

Re-run every ticked line against the actual release commit rather than trusting
this list. The state below is the release-prep verification, not the extraction
verification it replaced.

- [x] `npm ci`, `npm run build`, `npm run typecheck` and `npm test` all exit 0 —
      verified: **161 tests across 33 suites, 161 pass, 0 fail, 0 skipped**.
- [x] `flutter pub get`, `flutter analyze` and `flutter test` exit 0 in
      `apps/console` — verified: "No issues found!", **2/2 tests pass**.
- [x] `dart format --output=none --set-exit-if-changed .` exits 0 in
      `apps/console` — verified after formatting the four files that were
      unformatted (`scenario_model.dart`, `api_service.dart`, `scenario_panel.dart`,
      `widget_test.dart`). CI does not run this command, so it is a local-only
      gate.
- [x] The Docker image builds from a clean cache and the container answers
      `GET /health` — verified with `docker build -t cerberus:v0.1.0 .` **and** a
      `--no-cache` rebuild, plus `docker compose up -d --build` against `mongo:7`.
- [x] The container exits non-zero, with a `CERBERUS_API_KEY` message, when run
      with `NODE_ENV=production` and no operator key — verified.
- [x] `CERBERUS_DEV_MODE=true` is refused under `NODE_ENV=production` — verified,
      exits 1 with "refused while NODE_ENV=production".
- [x] Startup without `OPENAI_API_KEY` exits 1 — verified.
- [x] Every `OWNER` placeholder is gone from the repository —
      `git grep -n 'OWNER' -- .` returns no repository-URL placeholder.
- [x] The `LICENSE` and `NOTICE` copyright lines agree — both read
      `Copyright 2026 Muhammad Bilal Raza Lodhi (Cerberus AI Contributors)`.
- [x] The version is `0.1.0` in every manifest — `package.json`,
      `apps/api/package.json`, `packages/mcp-mongodb/package.json`,
      `packages/mcp-mongodb/src/tool-names.ts` (`MCP_SERVER_VERSION`) and
      `apps/console/pubspec.yaml` all read `0.1.0`, and `GET /health` reports
      `"version":"0.1.0"`.
- [x] `CHANGELOG.md` dates the `0.1.0` section instead of saying `unreleased`,
      and its comparison links contain no zero-SHA compare target.
- [x] The dependency-license inventory is complete and compatible: 106 runtime
      packages, all permissively licensed, no copyleft and no unknown license.
- [ ] `conduct@cerberus.invalid` is replaced. **Still open.** No contact address
      is established anywhere in the project, so this needs a maintainer decision
      (see `community-health-checklist.md`). Do not invent an address.
- [ ] The secret scan is green on the **final** release commit. The
      `trufflehog --only-verified` job is CI-only and the binary is not installed
      locally; confirm the `Secret scan` job passes on the pushed release commit.

---

## Phase 1 — Pre-release

### 1.1 Build, typecheck, test

- [ ] `npm ci` — clean install from the lockfile.
- [ ] `npm run build` — exits 0 for `@cerberus/api` and `@cerberus/mcp-mongodb`.
- [ ] `npm run typecheck` — exits 0 for both workspaces.
- [ ] `npm test` — record the exact pass/fail/suite counts and paste them into
      the `## Verification` section of `docs/release/v0.1.0-release-notes.md`.
      The release-prep run was **161 tests across 33 suites, 161 pass, 0 fail,
      0 skipped** (the previous recorded run was 152 tests across 30 suites).
- [x] `cd apps/console && flutter pub get` — exits 0.
- [x] `cd apps/console && flutter analyze` — exits 0 with "No issues found!".
- [x] `cd apps/console && flutter test` — exits 0, 2/2 pass.
- [x] `cd apps/console && dart format --output=none --set-exit-if-changed .` —
      exits 0 (the command `CONTRIBUTING.md` documents). This failed at release
      prep with four unformatted files and was fixed; note that CI does **not**
      run this command, so it only guards a local run.

### 1.2 Container

- [x] `docker build -t cerberus:v0.1.0 .` — succeeds, and both
      `apps/api/dist/index.js` and `packages/mcp-mongodb/dist/http-adapter.js`
      exist in the image (the Dockerfile asserts this). Verified twice: once with
      the local layer cache and once with `--no-cache`; both exited 0.
- [x] `docker compose up --build` with `CERBERUS_DEV_MODE=true` and a placeholder
      `OPENAI_API_KEY` — `mongo:7` reports healthy and the Cerberus container
      starts.
- [x] `curl -sf http://localhost:8080/health` — returns HTTP 200 with
      `{"status":"healthy","service":"cerberus-api","version":"0.1.0",...}`.
- [x] `docker compose down -v` — the stack, network and volume are removed.
- [x] `docker run --rm -e NODE_ENV=production -e OPENAI_API_KEY=placeholder
      cerberus:v0.1.0` — exits 1 and the log names `CERBERUS_API_KEY`
      (`[entrypoint] FATAL: CERBERUS_API_KEY is not set.`).
- [x] Record the image digest and the exact commands in the release notes.

### 1.3 Manual HTTP verification (needs a live server)

These are manual aids, not the automated suite. Run them with
`CERBERUS_API_KEY` set and `CERBERUS_DEV_MODE=false`:

- [ ] `pwsh -File scripts/smoke-api.ps1 -ApiKey $env:CERBERUS_API_KEY` — all 14
      checks pass. **Not re-run at release prep.** One check drives the AI
      scenario path, so a clean 14/14 needs a real OpenAI key; without one that
      step fails closed with `CLASSIFIER_UNAVAILABLE` and the run scores 13/14.
- [ ] `pwsh -File scripts/smoke-telemetry.ps1 -ApiKey $env:CERBERUS_API_KEY` —
      all 18 checks pass. **Not re-run at release prep.**
- [ ] `pwsh -File scripts/verify-all.ps1 -ApiKey $env:CERBERUS_API_KEY` — all
      three suites pass. Skip or lower `-GenerateCount` on
      `scripts/stress-telemetry.ps1` to limit AI-provider spend. **Not re-run at
      release prep.**
- [x] Confirm an unauthenticated call to `GET /api/v1/sessions` returns 401 —
      verified live against a production-shaped compose stack, together with the
      full boundary: no credential 401, wrong `Bearer` 401, wrong `X-API-Key` 401,
      correct `Bearer` 200, correct `X-API-Key` 200. The MCP adapter answered 401
      without a token, 401 with a wrong token, and 200 with the correct one.

### 1.4 Census and scans

- [x] Legacy-identifier census: run the CI command and confirm no output:
      `git grep -n -I -E 'webscraping-464710|gorilla_agents|gorilla-mcp-mongodb' -- .`
- [x] Extend the census to the old product and provider names and fix what it
      finds outside deliberate provenance text:
      `git grep -n -I -E 'FinSec|Gemini' -- .` — remaining hits are deliberate
      provenance text in `README.md`, `CHANGELOG.md`, `NOTICE`, `docs/migration.md`
      and the release notes.
- [x] Credential-file check: confirm no tracked file matches `.env`,
      `application_default_credentials.json`, `*.pem` or `*.key` (excluding
      `.env.example`).
- [ ] Secret scan: run `trufflehog --only-verified` over the release commit, or
      confirm the `Secret scan` CI job is green on it. The job is green on the
      pre-release HEAD (`d9fc2b6`); confirm it again on the final release commit.
- [x] Confirm no `.env` file is staged or committed (`git ls-files .env` is
      empty).
- [x] Confirm no build output is tracked: `apps/*/dist`, `apps/console/build`,
      `apps/console/.dart_tool`, `*.tsbuildinfo`.

### 1.5 License audit

- [x] Confirm `LICENSE` contains the unmodified Apache License 2.0 text
      (169 lines, including the unmodified appendix).
- [x] Align the copyright line. `NOTICE` carries the same line as `LICENSE`:
      "Copyright 2026 Muhammad Bilal Raza Lodhi (Cerberus AI Contributors)".
- [x] Generate a full transitive dependency inventory and reconcile it against
      `NOTICE`. The release-prep inventory found **106 runtime packages**, all
      permissively licensed — MIT 90, ISC 7, Apache-2.0 4, BSD-2-Clause 3,
      BSD-3-Clause 2 — with no copyleft, no unknown and no missing license. Every
      package carried an explicit SPDX `license` field, so no text inference was
      needed. All seven direct-dependency claims in `NOTICE` were verified
      correct against the installed versions. Cross-checked with
      `npm-license-crawler` (108/108 agreement) and an independent
      `package-lock.json` walk. `NOTICE` lists direct runtime dependencies only
      and says so.
- [x] Confirm every dependency's license is compatible with Apache-2.0
      distribution — no copyleft or unknown-license package was found.
- [x] Confirm the `NOTICE` provenance paragraph still states that the project is
      not affiliated with, endorsed by or sponsored by Google, OpenAI or MongoDB.

### 1.6 Changelog and versions

- [x] `CHANGELOG.md`: `## [0.1.0] - 2026-09-22` carries the release-prep date
      instead of `unreleased`.
- [x] `CHANGELOG.md`: `[Unreleased]` contains a clean "Nothing yet." entry.
- [x] `CHANGELOG.md`: the comparison links point at
      `https://github.com/Bilal-Lodhi/cerberus`, with no `OWNER` placeholder and
      no zero-SHA compare target. There is deliberately no `compare/...` link:
      0.1.0 is the first release, so there is no earlier tag, and a
      `v0.1.0...HEAD` link would 404 until the tag is pushed.
- [x] Version bump — all of the following read `0.1.0`:
      - [x] `package.json` (`version`)
      - [x] `apps/api/package.json` (`version`)
      - [x] `packages/mcp-mongodb/package.json` (`version`)
      - [x] `packages/mcp-mongodb/src/tool-names.ts` (`MCP_SERVER_VERSION`)
      - [x] `apps/console/pubspec.yaml` (`version` — now `0.1.0+1`)
- [x] Confirm the service version reported by `GET /health` matches `0.1.0` —
      verified live in the container: `"version":"0.1.0"`.

### 1.7 Placeholders

- [x] Remove `OWNER` from `CHANGELOG.md` (the comment and both comparison links).
- [x] Remove `OWNER` from `CONTRIBUTING.md` (the `git clone` URL).
- [x] Remove `OWNER` from `.github/ISSUE_TEMPLATE/config.yml` (both contact
      links) and delete the note that documents the placeholder.
- [x] Confirm no other `OWNER` placeholder remains:
      `git grep -n 'OWNER' -- .` — remaining hits are the word `CODEOWNERS` and
      historical notes in `docs/release/`, not repository-URL placeholders.
- [ ] Replace `conduct@cerberus.invalid` in `CODE_OF_CONDUCT.md` with a real,
      monitored mailbox, and remove the "Placeholder contact" banner at the top of
      that file. **Still open, and blocked on a maintainer decision**: the project
      publishes no contact address, so this must not be invented. The only
      `*.invalid` string left in the tree is this one, and it is deliberate.
- [ ] Confirm no other placeholder address remains:
      `git grep -n 'invalid' -- .` — returns only the `CODE_OF_CONDUCT.md`
      placeholder and the release documents that describe it.

### 1.8 Documentation accuracy

- [x] `README.md`: the note claiming `SECURITY.md` "is not yet present in the
      tree" was wrong — the file exists. Removed.
- [x] `docs/architecture.md`: the claim that the API test directory "is not
      present in this release" was wrong. Corrected; it now names
      `apps/api/test/mcp-tool-mapping.test.ts`.
- [x] README media: the `## Demo` and `## Screenshots` sections and their five
      `TODO` comments were removed rather than left as empty placeholders. Real
      media is deferred to a post-0.1.0 issue.
- [x] Confirm every relative link in `README.md`, `docs/` and the
      `docs/release/` files resolves — audited: 36 relative path links, all
      resolve, with exact case. One broken in-page anchor in `docs/migration.md`
      was found and fixed.

### 1.9 Freeze

- [x] `git status --porcelain` shows only files that belong to this release.
- [x] Confirm the branch is up to date with the intended release commit.
- [x] Confirm the working tree contains no editor, OS or build residue.
- [x] Record the release commit SHA; it goes in the tag annotation and the
      release notes. The local-only `AGENTS.md` is excluded through
      `.git/info/exclude`, so it never appears in `git status`.

---

## Phase 2 — Repository setup

Settings, not files. Do these before the tag is pushed so the first visitors find
a configured repository. Everything marked verified below was applied through the
GitHub CLI/API and then re-read to confirm the value took effect.

- [x] Set the repository description to the text in
      `docs/release/repository-metadata.md` (264 characters, under the 350
      limit). **Verified** by re-reading the repository.
- [x] Add the topics listed in `docs/release/repository-metadata.md` — all 15
      present. **Verified** by re-reading the repository.
- [x] Enable GitHub's security policy so `SECURITY.md` is surfaced under the
      Security tab. **Verified** — the file is present at the repository root.
- [x] Enable private vulnerability reporting, which `SECURITY.md` instructs
      reporters to use. **Verified**: `private-vulnerability-reporting` reads
      `{"enabled":true}`.
- [x] Enable Dependabot alerts. **Verified**: `GET /vulnerability-alerts`
      returns 204 instead of 404.
- [x] Confirm secret scanning is on. **Verified**:
      `secret_scanning` is `enabled`.
- [x] Confirm secret-scanning push protection is on. **Verified**:
      `secret_scanning_push_protection` is `enabled`.
- [x] Enable GitHub Discussions, which `SUPPORT.md` points people to.
      **Verified**: `has_discussions` reads `true`.
- [x] Create the labels used by the repository: `bug`, `enhancement`,
      `documentation`, `good first issue`, `help wanted`, plus any triage labels
      the maintainers want. **Verified** — all five already existed, alongside
      `accessibility`, `duplicate`, `invalid`, `question` and `wontfix`.
- [x] Confirm the `good first issue` label exists before opening any issue from
      `docs/release/good-first-issues.md`. **Verified.**
- [x] Confirm the issue-template chooser works: `blank_issues_enabled: false` in
      `.github/ISSUE_TEMPLATE/config.yml` means both contact links must resolve.
      Both now point at `Bilal-Lodhi/cerberus` and resolve.
- [x] Protect `main`: require a pull request before merging, and require the
      status checks below. **Verified** — protection is active on `main` with
      `required_pull_request_reviews` set, `allow_force_pushes: false` and
      `allow_deletions: false`.
- [x] Mark these CI jobs as required status checks. **Verified** — all four are
      registered as required contexts, with `strict: true` (the branch must be up
      to date before merging):
      - [x] `TypeScript (build, typecheck, test)` (job id `typescript`)
      - [x] `Flutter console (analyze, test)` (job id `console`)
      - [x] `Docker build` (job id `docker`)
      - [x] `Secret scan` (job id `secrets`)
- [x] Leave `Dependency audit (advisory)` (job id `dependencies`) as a
      non-required check — it is `continue-on-error: true` by design.
      **Verified** — it is not in the required-contexts list.

Two deliberate choices in that configuration, recorded so they are not mistaken
for omissions:

- `required_approving_review_count` is **0**. Requiring one approval on a
  single-maintainer repository would make every pull request unmergeable, because
  nobody but the author is available to approve. The rule still forces all
  changes through a pull request.
- `enforce_admins` is **false**, so the repository owner is not locked out of
  their own branch. Turn it on once a second maintainer exists.
- [x] Confirm the CI workflow actually runs on a pull request to `main`, not only
      on push — `.github/workflows/ci.yml` triggers on `pull_request` targeting
      `main` as well as `push`.
- [ ] Upload a social preview image (1280x640). **Manual UI step.** No image
      exists in the tree, and the repository deliberately ships no fabricated
      media; this needs a real screenshot.
- [ ] Decide whether `CODEOWNERS` is needed and either add
      `.github/CODEOWNERS` or record the decision not to. **Still open** — see
      `community-health-checklist.md`.
- [ ] Confirm the repository name and its collision risk; see
      `docs/release/repository-metadata.md`. **Still open** — the collision risk
      is documented but the naming decision has not been made. The repository was
      **not** renamed.

### Settings that could not be applied through the API — do these in the UI

Two secret-scanning options accepted a `PATCH` with HTTP 200 but did not change
value when re-read, so they are reported rather than claimed:

- **Secret scanning → Non-provider patterns.** Settings → Code security and
  analysis → Secret Protection → enable "Scan for non-provider patterns".
- **Secret scanning → Validity checks.** Same screen → enable "Check validity of
  detected secrets".

Dependabot **security updates** (distinct from the alerts enabled above) are also
still `disabled`. Enabling them opens automated fix pull requests, which is a
maintainer workflow decision, not a hardening default: Settings → Code security
and analysis → Dependabot → "Dependabot security updates".

### Ordering note — branch protection and the release push

Branch protection was applied **after** the release-prep commits were pushed and
CI was confirmed green on the resulting HEAD (`b6a6141`). Once "require a pull
request before merging" is on, a direct push to `main` is rejected unless the
pusher is an admin and `enforce_admins` is false. Keep that ordering in mind for
any future release: push, confirm CI, then protect.

---

## Phase 3 — Tagging and release

- [ ] Confirm the release commit is the head of `main` and CI is green on it.
- [ ] Create an annotated tag: `git tag -a v0.1.0 -m "Cerberus v0.1.0"`.
- [ ] Sign the tag if a signing key is configured (`git tag -s v0.1.0`), and
      confirm `git tag -v v0.1.0` verifies.
- [ ] Confirm the tag points at the intended commit:
      `git rev-list -n 1 v0.1.0`.
- [ ] Push the tag: `git push origin v0.1.0`.
- [ ] Create the GitHub Release from tag `v0.1.0` with the title
      `Cerberus v0.1.0 — First Independent Open-Source Release`.
- [ ] Attach `docs/release/v0.1.0-release-notes.md` as the release body and
      confirm every link renders (no literal `OWNER`).
- [ ] Decide the release type explicitly: tick "Set as a pre-release" if the
      project still describes itself as an experimental research system in
      `README.md`, and record the decision. Do not leave the default unexamined.
- [ ] Confirm the released assets are only what is intended (no build artifacts,
      no `.env`).
- [ ] Confirm the tag appears in the `CHANGELOG.md` comparison links, which now
      need a real `v0.1.0` compare target.

---

## Phase 4 — Post-release

- [ ] Post an announcement in GitHub Discussions describing what 0.1.0 is and,
      explicitly, what it is not.
- [x] Open the issues drafted in `docs/release/good-first-issues.md`, apply the
      labels recorded there, and confirm each one still reproduces against the
      current commit. Four were filed at release prep:
      [#1](https://github.com/Bilal-Lodhi/cerberus/issues/1) docs index,
      [#2](https://github.com/Bilal-Lodhi/cerberus/issues/2) console web build
      output directory,
      [#3](https://github.com/Bilal-Lodhi/cerberus/issues/3)
      `SESSION_TTL_SECONDS`,
      [#4](https://github.com/Bilal-Lodhi/cerberus/issues/4) `severityMix`.
      Candidates 2 and 9 were deferred as maintainer decisions, and candidates
      3, 5 and 7 were dropped as already fixed. Re-confirm each against the
      released commit.
- [ ] Watch the issue tracker for the first two weeks and triage every report.
- [ ] Watch the CI runs on `main` after the tag, including the advisory
      dependency-audit job.
- [ ] Confirm private vulnerability reporting is reachable and that a test report
      can be filed.
- [ ] Record the released SHA, the image digest and the test counts in the
      release notes file in the repository.
- [ ] Update `SECURITY.md` "Supported versions" so `0.1.x` reads as supported
      rather than "Yes, once published".
- [ ] Re-check the `docs/` set for anything that still says "unreleased".
- [ ] Schedule a dependency-audit triage pass, since the audit job is advisory
      and does not block anything.
