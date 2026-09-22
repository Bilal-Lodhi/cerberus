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
- [x] The Code of Conduct enforcement contact is set. **Verified** —
      `CODE_OF_CONDUCT.md` publishes `braza4715@gmail.com`, the address supplied
      by the maintainer, and the placeholder banner was removed. A repository
      grep for an invalid-TLD address returns nothing.
- [x] Real OpenAI inference succeeds against the configured provider boundary.
      **Verified** — `POST /api/v1/scenarios` with `vectorCount=1` returned HTTP
      201 in 45.3s on model `gpt-5.6`, the matrix parsed with all five top-level
      keys, token usage was reported, and the document persisted. Two blocking
      defects were found and fixed by this exercise: the provider sent a
      `temperature` the model rejects, and the default per-attempt timeout was
      too low for large matrices.
- [x] The secret scan is green on the release commit. **Verified** — the
      `Secret scan` CI job (`trufflehog --only-verified`) passes on the pushed
      release candidate, and the repository reports zero secret-scanning alerts
      and zero Dependabot alerts. The binary is not installed locally, so this
      line is confirmed through CI rather than a local run.

---

## Phase 1 — Pre-release

### 1.1 Build, typecheck, test

- [x] `npm ci` — clean install from the lockfile, exit 0.
- [x] `npm run build` — exits 0 for `@cerberus/api` and `@cerberus/mcp-mongodb`.
- [x] `npm run typecheck` — exits 0 for both workspaces.
- [x] `npm test` — **161 tests across 33 suites, 161 pass, 0 fail, 0 skipped**,
      recorded in the `## Verification` section of
      `docs/release/v0.1.0-release-notes.md`. The previous recorded run was 152
      tests across 30 suites.
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

- [x] `pwsh -File scripts/smoke-api.ps1 -ApiKey $env:CERBERUS_API_KEY` — **14/14
      passed** against a live stack with a real OpenAI key and authentication
      enabled. The AI scenario step returned a persisted 3-vector matrix.
- [x] `pwsh -File scripts/smoke-telemetry.ps1 -ApiKey $env:CERBERUS_API_KEY` —
      **18/18 passed** (all twelve event types plus the deploy/review lifecycle).
      The large-paste step scored risk 78 with 4 flags and the session
      auto-locked. Two client timeouts in this script had to be raised first:
      the scenario step (180s → 600s) and the ingest steps (30s → 120s), because
      both aborted requests the server was still working on.
- [x] `pwsh -File scripts/verify-all.ps1 -ApiKey $env:CERBERUS_API_KEY` — run
      with `-GenerateCount 1 -IngestCount 5` to keep AI spend low. Suites 1 and 3
      passed; suite 2 failed on the timeouts above and passed 18/18 on re-run.
      `verify-all.ps1` now forwards `-GenerateCount` / `-IngestCount` /
      `-IngestBatchSize`; previously it always ran the burst at its 25-request
      default, so the "lower the count" instruction in this checklist was not
      actually possible.
- [x] `pwsh -File scripts/stress-telemetry.ps1 -GenerateCount 1 -IngestCount 5` —
      **6/6 requests, 0 failures**; 43.3s scenario latency, 50ms mean ingest
      latency.
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
- [x] Secret scan: run `trufflehog --only-verified` over the release commit, or
      confirm the `Secret scan` CI job is green on it. **Verified** — the job is
      green on the pushed release candidate, and the repository reports zero
      secret-scanning alerts.
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
- [x] Replace the placeholder Code of Conduct enforcement address in
      `CODE_OF_CONDUCT.md` with a real, monitored mailbox, and remove the
      "Placeholder contact" banner at the top of that file. **Verified** — the
      file now publishes `braza4715@gmail.com` (maintainer-supplied) and carries
      no placeholder banner.
- [x] Confirm no other placeholder address remains: a repository grep for an
      invalid-TLD address returns nothing. The only remaining `placeholder`
      string in the tree is the Flutter `base href` comment in
      `apps/console/web/index.html`, which is a framework note, not a contact.

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
- [x] Confirm the repository name and its collision risk; see
      `docs/release/repository-metadata.md`. **Decided: keep `cerberus`.** The
      collision risk is documented in full (a Python validation library, a
      test-automation framework, and an unrelated malware family share the name),
      and the README's opening lines carry the disambiguation. The repository was
      **not** renamed, so no in-tree identifier changes.

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

### Classification of the remaining manual items

None of these blocks v0.1.0. Each is recorded with the reason it does not:

| Item | Class | Why |
| --- | --- | --- |
| Social preview image (1280x640) | **C — intentionally deferred** | Cosmetic link-preview only. No image exists in the tree and one must not be fabricated. |
| `CODEOWNERS` decision | **C — intentionally deferred** | Recorded as a deliberate choice for a single-maintainer repository. Branch protection plus the pull-request template already cover review, and a `CODEOWNERS` file would need owner handles nobody can supply yet. |
| Secret scanning — non-provider patterns | **B — recommended, can follow** | Broadens detection to generic secret shapes. Verified-secret scanning, push protection and the CI `Secret scan` job are already on, so this is depth, not a gap. |
| Secret scanning — validity checks | **B — recommended, can follow** | Reduces false positives on detected secrets. A signal-quality improvement, not a control. |
| Dependabot security updates | **B — recommended, can follow** | Dependabot **alerts** are already enabled, so advisories are visible. This only automates the fix pull requests, which is a maintainer workflow preference. |

### Ordering note — branch protection and the release push

Branch protection was applied **after** the release-prep commits were pushed and
CI was confirmed green on the resulting HEAD. Once "require a pull request before
merging" is on, a direct push to `main` is rejected unless the pusher is an admin
and `enforce_admins` is false. Keep that ordering in mind for any future release:
push, confirm CI, then protect. The exact release-prep commit SHA is recorded at
tag time, per step 1.9 — do not hard-code it here, because documenting it moves
it.

---

## Phase 3 — Tagging and release

- [x] Confirm the release commit is the head of `main` and CI is green on it.
      **Verified at the time of tagging** — `ef98f96` was the head of `main` with
      all five CI jobs green (run `35749583788`). `main` has since advanced to
      post-release documentation commits, as expected; the tag was not moved.
- [x] Create an annotated tag: `git tag -a v0.1.0 -m "Cerberus v0.1.0"`.
      **Verified** — tag object `55329b5e378cb890c9b9775647396ea57fd7bdc7`.
- [x] Sign the tag if a signing key is configured (`git tag -s v0.1.0`), and
      confirm `git tag -v v0.1.0` verifies. **Not applicable, and deliberately so**
      — no `user.signingkey`, `gpg.format` or `tag.gpgsign` is configured on the
      release machine, and this phase must not configure signing from scratch. The
      tag is annotated, not signed.
- [x] Confirm the tag points at the intended commit:
      `git rev-list -n 1 v0.1.0`. **Verified** —
      `ef98f962530fb62340cf213b408f1cd715755c01`.
- [x] Push the tag: `git push origin v0.1.0`. **Verified** — the remote tag
      resolves to the same commit; the push carried no force and did not move
      `main`.
- [x] Create the GitHub Release from tag `v0.1.0` with the title
      `Cerberus v0.1.0 — First Independent Open-Source Release`. **Verified** —
      title matches exactly (em dash included).
- [x] Attach `docs/release/v0.1.0-release-notes.md` as the release body and
      confirm every link renders (no literal `OWNER`). **Verified, after a
      correction** — the first publication carried seven relative links, four of
      which resolved against the release URL rather than `docs/release/` and
      404'd (`../migration.md` rendered as `/blob/migration.md`). They are now
      absolute repository URLs and all resolve on the release page. The body was
      edited in place; the tag was not moved.
- [x] Decide the release type explicitly: tick "Set as a pre-release" if the
      project still describes itself as an experimental research system in
      `README.md`, and record the decision. **Decided: pre-release**, and
      `prerelease: true` is set on the published release. `README.md` still
      describes 0.1.0 as an experimental research system, so marking it "Latest"
      would contradict the project's own status wording.
- [x] Confirm the released assets are only what is intended (no build artifacts,
      no `.env`). **Verified** — the release has **zero attached assets**; only
      GitHub's generated source archives are available.
- [x] Confirm the tag appears in the `CHANGELOG.md` comparison links, which now
      need a real `v0.1.0` compare target. **Verified** — `[Unreleased]` now
      compares `v0.1.0...HEAD` and `[0.1.0]` points at the release tag, both of
      which resolve because the tag exists.

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
      **Ongoing.**
- [x] Watch the CI runs on `main` after the tag, including the advisory
      dependency-audit job. **Verified** — `main` CI is green on both
      post-release commits, with the advisory dependency audit passing alongside
      the four required jobs.
- [ ] Confirm private vulnerability reporting is reachable and that a test report
      can be filed. **Still open** — the setting is enabled and verified, but
      filing a probe report would create a real advisory entry, so this is left
      for a deliberate manual check.
- [x] Record the released SHA, the image digest and the test counts in the
      release notes file in the repository. **Verified** — the release notes now
      carry the tag, the release commit
      `ef98f962530fb62340cf213b408f1cd715755c01`, the publish date, the image
      digest and the 161/161 + 2/2 test counts.
- [x] Update `SECURITY.md` "Supported versions" so `0.1.x` reads as supported
      rather than "Yes, once published". **Verified** — the table now reads
      `0.1.x` → Yes, with the publication date recorded.
- [x] Re-check the `docs/` set for anything that still says "unreleased".
      **Verified** — `README.md`, `SECURITY.md` and `CHANGELOG.md` were the three
      files carrying publication-state claims, and all three are updated. The
      remaining `[Unreleased]` references are the Keep a Changelog section
      heading and the pull-request template, both of which are correct.
- [ ] Schedule a dependency-audit triage pass, since the audit job is advisory
      and does not block anything. **Still open** — a scheduling decision, not a
      release gate.
