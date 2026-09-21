# Community health checklist — v0.1.0

Two parts: files that must exist in the tree, and repository settings that must
be enabled on GitHub. The file inventory below was read from the tree, not
assumed. Settings cannot be verified from the tree — every item in part 2 is
therefore marked "Unverified" until someone with repository admin access confirms
it.

Status values: **Done** (present and usable), **Done, with a placeholder**
(present but not publishable as-is), **Missing** (absent), **Unverified** (a
GitHub setting, not visible in the tree).

---

## Part 1 — Files in the tree

### Core health files

| File | Status | Notes |
| --- | --- | --- |
| `README.md` | Done | 315 lines. States the 0.1.0 status, the security and privacy warning, configuration, roadmap and provenance. No demo media: five `TODO` comments stand in for screenshots. The note at the end claiming `SECURITY.md` is absent is wrong — the file exists. |
| `LICENSE` | Done | Unmodified Apache License 2.0 text. Appendix copyright line: `Copyright 2026 Muhammad Bilal Raza Lodhi (Cerberus AI Contributors)`. |
| `NOTICE` | Done | Provenance paragraph, third-party attributions, trademark note. Copyright line: `Copyright 2026 The Cerberus Authors` — disagrees with `LICENSE`. Covers direct runtime dependencies only and says so. |
| `CONTRIBUTING.md` | Done, with a placeholder | Development setup, conventions, commit style and pull-request expectations. `git clone https://github.com/OWNER/cerberus.git` still contains the `OWNER` placeholder. |
| `CODE_OF_CONDUCT.md` | Done, with a placeholder | Contributor Covenant 2.1 with enforcement guidelines. The enforcement address `conduct@cerberus.invalid` is a placeholder, flagged in a banner at the top of the file and again in the Enforcement section. |
| `SECURITY.md` | Done | Reporting route via private vulnerability reporting, scope, security model, known limitations, manual key rotation, deployment guidance. |
| `SUPPORT.md` | Done | Where to ask, what the project cannot help with, and a bug-report checklist. Points at GitHub Discussions. |
| `CHANGELOG.md` | Done, with a placeholder | Keep a Changelog format with an `[Unreleased]` and a `[0.1.0] - unreleased` section. Both comparison links and the `RELEASE BLOCKER` comment use the `OWNER` placeholder. |

### GitHub templates and workflow

| File | Status | Notes |
| --- | --- | --- |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | Done | Structured form: what happened, expected, reproduction, version, deployment method, Node and MongoDB versions, logs, redaction confirmation. Applies the `bug` label. |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | Done | Structured form: problem, proposed solution, alternatives, willingness to implement, additional context. Applies the `enhancement` label and carries an explicit scope note that enterprise-auth, billing and multi-tenancy proposals will be closed. |
| `.github/ISSUE_TEMPLATE/config.yml` | Done, with a placeholder | `blank_issues_enabled: false` with two contact links (SUPPORT.md, security policy). Both URLs use the `OWNER` placeholder, and a trailing comment documents it. |
| `.github/pull_request_template.md` | Done | Summary, motivation, type of change, scope boundaries, exact test commands, and a checklist that mirrors `CONTRIBUTING.md`. |
| `.github/workflows/ci.yml` | Done | Five jobs: TypeScript build/typecheck/test, Flutter console analyze/test, Docker build with a `/health` smoke test and a fail-closed assertion, a secret scan, and an advisory dependency audit. |
| `CODEOWNERS` | **Missing** | Neither `.github/CODEOWNERS`, `CODEOWNERS` nor `docs/CODEOWNERS` exists. See the decision note below. |

### Documentation set

| Path | Status | Notes |
| --- | --- | --- |
| `docs/architecture.md` | Done | Component map, data flows, state and persistence model, trust boundaries, roadmap gaps. |
| `docs/configuration.md` | Done | Every environment variable with type, default and required flag, plus worked examples. |
| `docs/migration.md` | Done | Historical → current collection, database, tool and field mapping, plus rename guidance. |
| `docs/security/threat-model.md` | Done | Assets, actors, trust boundaries and limits. |
| `docs/index.md` or `docs/README.md` | **Missing** | `docs/` has no index or table of contents. `README.md` links each document individually, but there is no entry point inside `docs/` itself. |
| `docs/release/` | Done | Added with this release: `v0.1.0-release-notes.md`, `release-checklist.md`, `community-health-checklist.md`, `good-first-issues.md`, `repository-metadata.md`. |

### Non-health files worth confirming

| Item | Status | Notes |
| --- | --- | --- |
| `.env.example` | Done | Annotated, no real credentials, dev mode on by default. |
| `.gitignore` | Done | `.env` is ignored; a local `.env` exists in the working tree and is not tracked. |
| `docker-compose.yml`, `Dockerfile`, `scripts/entrypoint.sh` | Done | Local stack, multi-stage non-root image, and a container entrypoint with its own fail-closed check. |
| `scripts/*.ps1` | Done | Four manual HTTP runners: `smoke-api.ps1`, `smoke-telemetry.ps1`, `stress-telemetry.ps1`, `verify-all.ps1`. |

---

## Part 2 — GitHub settings that must be enabled

These live in the repository settings, not in the tree. Confirm each one on the
repository after the first push and before announcing the release.

### Community features

- [ ] **Discussions enabled.** `SUPPORT.md` sends every open-ended question to
      Discussions; if it is off, that document points nowhere.
      Status: **Unverified**.
- [ ] **Labels created.** `bug` and `enhancement` are applied automatically by
      the issue templates; `documentation`, `good first issue` and `help wanted`
      are used by the release checklist and the issue drafts.
      Status: **Unverified**.
- [ ] **`good first issue` label present.** Required before opening any issue
      from `docs/release/good-first-issues.md`.
      Status: **Unverified**.
- [ ] **Issue templates enabled and blank issues disabled.** The templates set
      `blank_issues_enabled: false`, so the chooser must resolve both contact
      links.
      Status: **Unverified**.
- [ ] **Repository description set** to the text in
      `docs/release/repository-metadata.md`.
      Status: **Unverified**.
- [ ] **Topics set** from the list in `docs/release/repository-metadata.md`.
      Status: **Unverified**.
- [ ] **Social preview image uploaded** (1280x640). `README.md` has no media at
      all, so the link preview is currently the default.
      Status: **Unverified**.

### Security settings

- [ ] **Security policy enabled** so `SECURITY.md` is surfaced on the Security
      tab.
      Status: **Unverified**.
- [ ] **Private vulnerability reporting enabled.** `SECURITY.md` instructs
      reporters to use it as the primary route.
      Status: **Unverified**.
- [ ] **Branch protection on `main`**: require a pull request before merging.
      Status: **Unverified**.
- [ ] **Required status checks** on `main`: `TypeScript (build, typecheck, test)`,
      `Flutter console (analyze, test)`, `Docker build`, `Secret scan`. Leave
      `Dependency audit (advisory)` non-required — it is
      `continue-on-error: true` by design.
      Status: **Unverified**.

---

## Decisions to record

### `CODEOWNERS` — missing

There is no `CODEOWNERS` file. It is optional, and for a single-maintainer
repository it adds a review requirement that nobody else can satisfy. Decide one
of the following and record the choice:

- **Add `.github/CODEOWNERS`** mapping `apps/api/`, `packages/mcp-mongodb/` and
  `apps/console/` to their maintainers, if more than one person will review
  changes. GitHub will then request review automatically on every pull request
  that touches those paths.
- **Do not add it**, and rely on the required status checks plus the pull-request
  template's scope-boundaries section. This is the simpler option while the
  project has one maintainer.

Either way, the absence is deliberate rather than an oversight — write the
decision down so the next contributor does not re-litigate it.

### Placeholders that block publication

Three placeholder values are still in the tree. They are documented in the files
themselves, and every one of them must be resolved before the repository is
announced:

1. `OWNER` in `CHANGELOG.md`, `CONTRIBUTING.md` and
   `.github/ISSUE_TEMPLATE/config.yml`.
2. `conduct@cerberus.invalid` in `CODE_OF_CONDUCT.md`.
3. The `LICENSE` / `NOTICE` copyright-line disagreement, which is a placeholder
   decision rather than a placeholder string.

### Demo media — missing

`README.md` has five `TODO` comments covering a demo GIF, an architecture
screenshot and three console screenshots. Until they are replaced or the
`## Screenshots` section is deleted, the repository's first impression is a
placeholder comment.
