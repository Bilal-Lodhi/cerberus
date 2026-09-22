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
| `README.md` | Done | 328 lines. States the 0.1.0 status, the security and privacy warning, configuration, roadmap and provenance. The empty `## Demo` and `## Screenshots` sections and their five `TODO` comments were removed for 0.1.0; media is deferred to a later issue. The stale note claiming `SECURITY.md` was absent is gone. |
| `LICENSE` | Done | Unmodified Apache License 2.0 text. Appendix copyright line: `Copyright 2026 Muhammad Bilal Raza Lodhi (Cerberus AI Contributors)`. |
| `NOTICE` | Done | Provenance paragraph, third-party attributions, trademark note. Copyright line: `Copyright 2026 Muhammad Bilal Raza Lodhi (Cerberus AI Contributors)` — now identical to the `LICENSE` line. Covers direct runtime dependencies only and says so. |
| `CONTRIBUTING.md` | Done | Development setup, conventions, commit style and pull-request expectations. The `git clone` URL now names the real owner (`Bilal-Lodhi/cerberus`). |
| `CODE_OF_CONDUCT.md` | Done, with a placeholder | Contributor Covenant 2.1 with enforcement guidelines. The enforcement address `conduct@cerberus.invalid` is still a placeholder, flagged in a banner at the top of the file and again in the Enforcement section. See "Placeholders that block publication" below — this one needs a human decision, not a substitution. |
| `SECURITY.md` | Done | Reporting route via private vulnerability reporting, scope, security model, known limitations, manual key rotation, deployment guidance. |
| `SUPPORT.md` | Done | Where to ask, what the project cannot help with, and a bug-report checklist. Points at GitHub Discussions. Publishes no contact address. |
| `CHANGELOG.md` | Done | Keep a Changelog format with a clean `[Unreleased]` section and a dated `[0.1.0] - 2026-09-22`. Comparison links point at the real repository and contain no `OWNER` placeholder and no zero-SHA compare target. |

### GitHub templates and workflow

| File | Status | Notes |
| --- | --- | --- |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | Done | Structured form: what happened, expected, reproduction, version, deployment method, Node and MongoDB versions, logs, redaction confirmation. Applies the `bug` label. |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | Done | Structured form: problem, proposed solution, alternatives, willingness to implement, additional context. Applies the `enhancement` label and carries an explicit scope note that enterprise-auth, billing and multi-tenancy proposals will be closed. |
| `.github/ISSUE_TEMPLATE/config.yml` | Done | `blank_issues_enabled: false` with two contact links (SUPPORT.md, security policy). Both URLs name `Bilal-Lodhi/cerberus`; the placeholder note is gone. |
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
| `.gitignore` | Done | `.env` is ignored. No `.env` exists in the working tree and none is tracked; `.env.example` is the documented starting point. |
| `docker-compose.yml`, `Dockerfile`, `scripts/entrypoint.sh` | Done | Local stack, multi-stage non-root image, and a container entrypoint with its own fail-closed check. |
| `scripts/*.ps1` | Done | Four manual HTTP runners: `smoke-api.ps1`, `smoke-telemetry.ps1`, `stress-telemetry.ps1`, `verify-all.ps1`. |

---

## Part 2 — GitHub settings that must be enabled

These live in the repository settings, not in the tree. Everything marked
**Verified** below was applied through the GitHub CLI/API during release
preparation and then re-read from the API to confirm the value took effect.
Items marked **Unverified** are still open.

### Community features

- [x] **Discussions enabled.** `SUPPORT.md` sends every open-ended question to
      Discussions; if it is off, that document points nowhere.
      Status: **Verified** (`has_discussions` reads `true`).
- [x] **Labels created.** `bug` and `enhancement` are applied automatically by
      the issue templates; `documentation`, `good first issue` and `help wanted`
      are used by the release checklist and the issue drafts.
      Status: **Verified** — all five exist.
- [x] **`good first issue` label present.** Required before opening any issue
      from `docs/release/good-first-issues.md`.
      Status: **Verified**.
- [x] **Issue templates enabled and blank issues disabled.** The templates set
      `blank_issues_enabled: false`, so the chooser must resolve both contact
      links. Both now point at `Bilal-Lodhi/cerberus` and resolve.
      Status: **Verified**.
- [x] **Repository description set** to the text in
      `docs/release/repository-metadata.md` (264 characters).
      Status: **Verified**.
- [x] **Topics set** from the list in `docs/release/repository-metadata.md` — all
      15 present.
      Status: **Verified**.
- [ ] **Social preview image uploaded** (1280x640). No image exists in the tree
      and none should be fabricated. **Manual UI step.**
      Status: **Unverified**.

### Security settings

- [x] **Security policy enabled** so `SECURITY.md` is surfaced on the Security
      tab. `SECURITY.md` is present at the repository root.
      Status: **Verified**.
- [x] **Private vulnerability reporting enabled.** `SECURITY.md` instructs
      reporters to use it as the primary route.
      Status: **Verified** (`{"enabled":true}`).
- [x] **Dependabot alerts enabled.**
      Status: **Verified** (`GET /vulnerability-alerts` returns 204).
- [x] **Secret scanning enabled.**
      Status: **Verified**.
- [x] **Secret-scanning push protection enabled.**
      Status: **Verified**.
- [ ] **Secret scanning — non-provider patterns.** A `PATCH` to enable this was
      accepted with HTTP 200 but the value did not change on re-read, so it is
      reported rather than claimed. **Manual UI step:** Settings → Code security
      and analysis → Secret Protection → "Scan for non-provider patterns".
      Status: **Unverified**.
- [ ] **Secret scanning — validity checks.** Same behaviour: accepted, not
      applied. **Manual UI step:** same screen → "Check validity of detected
      secrets".
      Status: **Unverified**.
- [ ] **Dependabot security updates.** Still `disabled`. Enabling it opens
      automated fix pull requests, which is a maintainer workflow decision rather
      than a hardening default. **Manual UI step:** Settings → Code security and
      analysis → Dependabot → "Dependabot security updates".
      Status: **Unverified**.
- [x] **Branch protection on `main`**: require a pull request before merging.
      Status: **Verified** — protection is active, with force-pushes and branch
      deletion disallowed. `required_approving_review_count` is 0 (a
      single-maintainer repository cannot satisfy a mandatory approval) and
      `enforce_admins` is false so the owner is not locked out.
- [x] **Required status checks** on `main`: `TypeScript (build, typecheck, test)`,
      `Flutter console (analyze, test)`, `Docker build`, `Secret scan`. Leave
      `Dependency audit (advisory)` non-required — it is
      `continue-on-error: true` by design.
      Status: **Verified** — all four registered with `strict: true`, and the
      advisory audit is not among them.

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

The `OWNER` placeholder has been resolved. Every repository URL in
`CHANGELOG.md`, `CONTRIBUTING.md` and `.github/ISSUE_TEMPLATE/config.yml` now
names `Bilal-Lodhi/cerberus`, and `git grep -n 'OWNER' -- .` returns no
repository-URL placeholder.

One placeholder remains, and it is a human decision rather than a substitution:

1. `conduct@cerberus.invalid` in `CODE_OF_CONDUCT.md`. The project publishes no
   contact address anywhere — `SUPPORT.md` routes questions to GitHub
   Discussions and `SECURITY.md` routes vulnerabilities to GitHub private
   vulnerability reporting. Neither is a Code of Conduct enforcement channel, and
   inventing an address would publish a mailbox nobody monitors. **A maintainer
   must either supply a monitored address or choose a non-email enforcement
   route, then edit `CODE_OF_CONDUCT.md` and remove its placeholder banner.**
   This is the only pre-release item left that cannot be completed from inside
   the repository.

The `LICENSE` / `NOTICE` copyright-line disagreement is resolved: both now read
`Copyright 2026 Muhammad Bilal Raza Lodhi (Cerberus AI Contributors)`.

### Demo media — deferred

`README.md` had five `TODO` comments covering a demo GIF, an architecture
screenshot and three console screenshots, with no media checked in. Both the
`## Demo` and `## Screenshots` sections were removed for 0.1.0 rather than left
as empty placeholders, so the repository no longer advertises media it does not
have. Adding real screenshots or a demo GIF is a post-0.1.0 task; it needs a
running stack and a real OpenAI key to capture honestly, so it is not a
release blocker.
