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

Explicitly **not** public, and changeable without notice:

- internal module structure, file layout and function signatures inside
  `apps/api/src` and `packages/mcp-mongodb/src`;
- the session-state shape held in memory;
- log line wording (the `code` values and status codes are the contract, not the
  prose);
- the Flutter widget tree, route names inside the console, and its visual design;
- `docs/` content other than the guarantees this document makes.

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
