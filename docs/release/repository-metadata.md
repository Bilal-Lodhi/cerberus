# Repository metadata — v0.1.0

Proposed GitHub metadata for the public repository. Nothing here is applied
automatically; each section is a value to paste into the repository settings, and
the release checklist references this file.

---

## Proposed repository description

GitHub truncates the description at 350 characters. The text below is 264
characters, so it fits with room to spare.

```text
Self-hosted telemetry guardian: ingests browser-console activity, scores it with a language model for insider-threat and data-exfiltration signals, and persists sessions, events and risk assessments in MongoDB via an MCP server. Experimental, not production ready.
```

Notes on the wording:

- It states what the software does, not what it is worth.
- "Experimental, not production ready" is deliberate and matches `README.md`,
  `SUPPORT.md`, `CONTRIBUTING.md` and the release notes. Do not drop it to make
  the description read better.
- It does not claim detection or prevention, compliance, or enterprise
  readiness.
- If a shorter description is preferred for display, use the first sentence only
  (228 characters).

---

## Recommended GitHub topics

GitHub topics are lowercase and hyphenated. Fifteen are proposed; all of them
describe something the repository actually contains.

| Topic | Why it applies |
| --- | --- |
| `insider-threat` | The domain the risk scoring targets. |
| `data-exfiltration` | The second detection goal, and the name of a risk dimension in `RiskAssessmentPayload`. |
| `telemetry` | The service ingests micro-event telemetry over `POST /api/v1/guardian/ingest`. |
| `security-monitoring` | The operational category a reader would search for. |
| `self-hosted` | The deployment model; there is no hosted offering. |
| `hono` | The HTTP framework the API is built on (`apps/api/src/index.ts`). |
| `typescript` | The language of `apps/api` and `packages/mcp-mongodb`. |
| `flutter` | The toolkit used by the operator console in `apps/console`. |
| `dart` | The console's language. |
| `mongodb` | The persistence layer, reached through the MCP server. |
| `model-context-protocol` | `packages/mcp-mongodb` is an MCP server, with stdio and HTTP transports. |
| `openai` | The single AI provider boundary (`OpenAIProvider`). |
| `llm` | The scoring approach, without naming a vendor in the topic set. |
| `monorepo` | npm workspaces across `apps/api` and `packages/mcp-mongodb`, plus the Flutter app. |
| `docker` | `docker-compose.yml` and the multi-stage `Dockerfile` are the documented local stack. |

Do not add `security`, `compliance`, `enterprise` or `production-ready`: the
first two overstate what the software is, and the last two are false.

---

## Proposed release name and tag

- **Tag:** `v0.1.0` — annotated, and signed if a signing key is configured.
- **Release title:** `Cerberus v0.1.0 — First Independent Open-Source Release`
- **Release body:** `docs/release/v0.1.0-release-notes.md`
- **Release type:** decide explicitly. The README describes 0.1.0 as an
  experimental research system, so "Set as a pre-release" is the consistent
  choice; ticking it also stops GitHub labelling it "Latest".

The version `0.1.0` appears in `package.json`, `apps/api/package.json`,
`packages/mcp-mongodb/package.json`, `apps/console/pubspec.yaml` and
`MCP_SERVER_VERSION` in `packages/mcp-mongodb/src/tool-names.ts`. Confirm all
five still agree before tagging.

---

## Repository name

**Recommendation: `cerberus`.**

The name is short, matches the service name reported by `GET /health`, and
matches the MongoDB database name (`cerberus`), the MCP server name
(`cerberus-mcp-mongodb`) and the npm workspace scope (`@cerberus/*`). No
in-repository identifier has to change if the repository is called `cerberus`.

### Collision risk

The name is not distinctive, and this is a real problem for discovery:

- **Cerberus** is a well-established Python data-validation library with its own
  documentation site at [docs.python-cerberus.org](https://docs.python-cerberus.org/).
  A search for "cerberus" plus "validation" or "schema" will surface it first.
- **Cerberus Testing** is a separate open-source test-automation framework
  published under the [cerberustesting](https://github.com/cerberustesting) GitHub
  organization, which holds eleven repositories.
- Other unrelated projects use the name on GitHub, including a malware-analysis
  framework, and "Cerberus" is also a well-known malware family name — which is
  an unfortunate association for a security tool.

Practical consequences: the repository will not be the first result for its own
name, and the README's first line has to carry the disambiguation. The
`NOTICE` file already states that the project is not affiliated with, endorsed by
or sponsored by Google, OpenAI or MongoDB; it does not address same-name
projects, and it does not need to, but the README should be clear about what this
project is.

### Fallback names

If the maintainers want a searchable name, these two keep the identity and add
the domain:

| Name | Rationale |
| --- | --- |
| `cerberus-telemetry` | States the category in the name. Low collision risk, and it matches how the README describes the service ("telemetry service"). |
| `cerberus-guardian` | Uses the project's own vocabulary: the telemetry route group is `/api/v1/guardian`, and the README calls the component the "insider threat guardian". |

Both are lowercase and hyphenated, so they are valid GitHub repository names and
valid as a future npm scope. Renaming the repository does not require renaming
anything in the tree: the root `package.json` is `private`, the workspaces are
scoped `@cerberus/*`, and no published package depends on the repository URL.
The only files that embed the URL are the `OWNER/cerberus` placeholders listed in
`release-checklist.md`, which have to be updated anyway.
