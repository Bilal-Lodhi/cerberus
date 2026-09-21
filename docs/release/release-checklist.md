# Release checklist — v0.1.0

Ordered, checkable steps for publishing the first independent open-source
release of Cerberus. Every item is an action with a verifiable outcome. Nothing
here is a formality: if an item cannot be checked, the release does not ship.

Run every command from the repository root unless the step says otherwise.

---

## Phase 0 — Do not publish until

Hard blockers. If any line below is still open, stop and fix it first.

- [ ] `flutter analyze` exits 0 in `apps/console` (it exited 1 with 18 findings
      when this checklist was written).
- [ ] `flutter test` passes in `apps/console` (it fails to compile because
      `lib/widgets/code_workspace_panel.dart` imports `dart:html`).
- [ ] `npm run build`, `npm run typecheck` and `npm test` all exit 0.
- [ ] The Docker image builds and the container answers `GET /health`.
- [ ] The container exits non-zero, with a `CERBERUS_API_KEY` message, when run
      with `NODE_ENV=production` and no operator key.
- [ ] Every `OWNER` placeholder is gone from the repository.
- [ ] `conduct@cerberus.invalid` is replaced with a monitored mailbox.
- [ ] The `LICENSE` and `NOTICE` copyright lines agree.
- [ ] The version is `0.1.0` in every manifest, including
      `apps/console/pubspec.yaml`.
- [ ] `CHANGELOG.md` dates the `0.1.0` section instead of saying `unreleased`.
- [ ] The secret scan is clean on the release commit.

---

## Phase 1 — Pre-release

### 1.1 Build, typecheck, test

- [ ] `npm ci` — clean install from the lockfile.
- [ ] `npm run build` — exits 0 for `@cerberus/api` and `@cerberus/mcp-mongodb`.
- [ ] `npm run typecheck` — exits 0 for both workspaces.
- [ ] `npm test` — record the exact pass/fail/suite counts and paste them into
      the `## Verification` section of `docs/release/v0.1.0-release-notes.md`.
      The last recorded run was 152 tests across 30 suites, 152 pass, 0 fail.
- [ ] `cd apps/console && flutter pub get` — exits 0.
- [ ] `cd apps/console && flutter analyze` — exits 0 with no findings.
- [ ] `cd apps/console && flutter test` — exits 0.
- [ ] `cd apps/console && dart format --output=none --set-exit-if-changed .` —
      exits 0 (the command `CONTRIBUTING.md` documents).

### 1.2 Container

- [ ] `docker build -t cerberus:v0.1.0 .` — succeeds, and both
      `apps/api/dist/index.js` and `packages/mcp-mongodb/dist/http-adapter.js`
      exist in the image (the Dockerfile asserts this).
- [ ] `docker compose up --build` with a `.env` containing
      `CERBERUS_DEV_MODE=true` and a placeholder `OPENAI_API_KEY` — both services
      start.
- [ ] `curl -sf http://localhost:8080/health` — returns `status: healthy`.
- [ ] `docker compose down -v` — the stack and its volume are removed.
- [ ] `docker run --rm -e NODE_ENV=production -e OPENAI_API_KEY=placeholder
      cerberus:v0.1.0` — exits non-zero and the log names `CERBERUS_API_KEY`.
- [ ] Record the image digest and the exact commands in the release notes.

### 1.3 Manual HTTP verification (needs a live server)

These are manual aids, not the automated suite. Run them with
`CERBERUS_API_KEY` set and `CERBERUS_DEV_MODE=false`:

- [ ] `pwsh -File scripts/smoke-api.ps1 -ApiKey $env:CERBERUS_API_KEY` — all 14
      checks pass.
- [ ] `pwsh -File scripts/smoke-telemetry.ps1 -ApiKey $env:CERBERUS_API_KEY` —
      all 18 checks pass.
- [ ] `pwsh -File scripts/verify-all.ps1 -ApiKey $env:CERBERUS_API_KEY` — all
      three suites pass. Skip or lower `-GenerateCount` on
      `scripts/stress-telemetry.ps1` to limit AI-provider spend.
- [ ] Confirm an unauthenticated call to `GET /api/v1/sessions` returns 401.

### 1.4 Census and scans

- [ ] Legacy-identifier census: run the CI command and confirm no output:
      `git grep -n -I -E 'webscraping-464710|gorilla_agents|gorilla-mcp-mongodb' -- .`
- [ ] Extend the census to the old product and provider names and fix what it
      finds outside deliberate provenance text:
      `git grep -n -I -E 'FinSec|Gemini' -- .`
- [ ] Credential-file check: confirm no tracked file matches `.env`,
      `application_default_credentials.json`, `*.pem` or `*.key` (excluding
      `.env.example`).
- [ ] Secret scan: run `trufflehog --only-verified` over the release commit, or
      confirm the `Secret scan` CI job is green on it.
- [ ] Confirm no `.env` file is staged or committed (`git ls-files .env` is
      empty).
- [ ] Confirm no build output is tracked: `apps/*/dist`, `apps/console/build`,
      `apps/console/.dart_tool`, `*.tsbuildinfo`.

### 1.5 License audit

- [ ] Confirm `LICENSE` contains the unmodified Apache License 2.0 text.
- [ ] Align the copyright line: `LICENSE` says "Copyright 2026 Muhammad Bilal
      Raza Lodhi (Cerberus AI Contributors)"; `NOTICE` says "Copyright 2026 The
      Cerberus Authors". Pick one wording and apply it to both files.
- [ ] Generate a full transitive dependency inventory with a license-scanning
      tool and add the resulting notices to `NOTICE`. `NOTICE` currently lists
      direct runtime dependencies only and says so.
- [ ] Confirm every dependency's license is compatible with Apache-2.0
      distribution.
- [ ] Confirm the `NOTICE` provenance paragraph still states that the project is
      not affiliated with, endorsed by or sponsored by Google, OpenAI or MongoDB.

### 1.6 Changelog and versions

- [ ] `CHANGELOG.md`: replace `## [0.1.0] - unreleased` with the release date in
      `YYYY-MM-DD` form.
- [ ] `CHANGELOG.md`: confirm `[Unreleased]` contains either "Nothing yet." or the
      changes that are genuinely not in this release.
- [ ] `CHANGELOG.md`: fix the comparison links, which currently point at
      `.../compare/0000000000000000000000000000000000000000...v0.1.0`.
- [ ] Version bump — all of the following must read `0.1.0`:
      - [ ] `package.json` (`version`)
      - [ ] `apps/api/package.json` (`version`)
      - [ ] `packages/mcp-mongodb/package.json` (`version`)
      - [ ] `packages/mcp-mongodb/src/tool-names.ts` (`MCP_SERVER_VERSION`)
      - [ ] `apps/console/pubspec.yaml` (`version` — currently `1.0.0+1`, which
            does not match the rest of the repository)
- [ ] Confirm the service version reported by `GET /health` matches `0.1.0`.

### 1.7 Placeholders

- [ ] Remove `OWNER` from `CHANGELOG.md` (the comment and both comparison links).
- [ ] Remove `OWNER` from `CONTRIBUTING.md` (the `git clone` URL).
- [ ] Remove `OWNER` from `.github/ISSUE_TEMPLATE/config.yml` (both contact
      links) and delete the note that documents the placeholder.
- [ ] Confirm no other `OWNER` placeholder remains:
      `git grep -n 'OWNER' -- .`
- [ ] Replace `conduct@cerberus.invalid` in `CODE_OF_CONDUCT.md` with a real,
      monitored mailbox, and remove the "Placeholder contact" banner at the top of
      that file.
- [ ] Confirm no other placeholder address remains:
      `git grep -n 'invalid' -- .`

### 1.8 Documentation accuracy

- [ ] `README.md`: the note claiming `SECURITY.md` "is not yet present in the
      tree" is wrong — the file exists. Remove or correct the note.
- [ ] `docs/architecture.md`: the claim that the API test directory "is not
      present in this release" is wrong — `apps/api/test/` holds eight test files
      and `npm test` runs 152 tests. Remove or correct it.
- [ ] Add real media to `README.md`: resolve the `TODO` comments for the demo GIF,
      the architecture screenshot and the three console screenshots, or delete the
      `## Screenshots` section.
- [ ] Confirm every relative link in `README.md`, `docs/` and the new
      `docs/release/` files resolves.

### 1.9 Freeze

- [ ] `git status --porcelain` shows only files that belong to this release.
- [ ] Confirm the branch is up to date with the intended release commit.
- [ ] Confirm the working tree contains no editor, OS or build residue.
- [ ] Record the release commit SHA; it goes in the tag annotation and the
      release notes.

---

## Phase 2 — Repository setup

Settings, not files. Do these before the tag is pushed so the first visitors find
a configured repository.

- [ ] Set the repository description to the text in
      `docs/release/repository-metadata.md` (<= 350 characters).
- [ ] Add the topics listed in `docs/release/repository-metadata.md`.
- [ ] Protect `main`: require a pull request before merging, and require the
      status checks below.
- [ ] Mark these CI jobs as required status checks:
      - [ ] `TypeScript (build, typecheck, test)` (job id `typescript`)
      - [ ] `Flutter console (analyze, test)` (job id `console`)
      - [ ] `Docker build` (job id `docker`)
      - [ ] `Secret scan` (job id `secrets`)
- [ ] Leave `Dependency audit (advisory)` (job id `dependencies`) as a
      non-required check — it is `continue-on-error: true` by design.
- [ ] Confirm the CI workflow actually runs on a pull request to `main`, not only
      on push.
- [ ] Enable GitHub's security policy so `SECURITY.md` is surfaced under the
      Security tab.
- [ ] Enable private vulnerability reporting, which `SECURITY.md` instructs
      reporters to use.
- [ ] Enable GitHub Discussions, which `SUPPORT.md` points people to.
- [ ] Create the labels used by the repository: `bug`, `enhancement`,
      `documentation`, `good first issue`, `help wanted`, plus any triage labels
      the maintainers want.
- [ ] Confirm the `good first issue` label exists before opening any issue from
      `docs/release/good-first-issues.md`.
- [ ] Confirm the issue-template chooser works: `blank_issues_enabled: false` in
      `.github/ISSUE_TEMPLATE/config.yml` means both contact links must resolve.
- [ ] Upload a social preview image (1280x640).
- [ ] Decide whether `CODEOWNERS` is needed and either add
      `.github/CODEOWNERS` or record the decision not to.
- [ ] Confirm the repository name and its collision risk; see
      `docs/release/repository-metadata.md`.

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
- [ ] Open the issues drafted in `docs/release/good-first-issues.md`, apply the
      `good first issue` label, and confirm each one still reproduces against the
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
