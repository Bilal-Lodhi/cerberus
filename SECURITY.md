# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report vulnerabilities privately through GitHub's private vulnerability reporting:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected version or commit, and the steps to reproduce.

If private reporting is unavailable to you, contact the maintainers through the
address listed in `SUPPORT.md` and ask for a private channel before sharing any
detail. Please do not include exploit details in a public channel.

### What to include

- The affected component (`apps/api`, `packages/mcp-mongodb`, `apps/console`, or
  the container image) and the exact commit SHA or version.
- A description of the impact: what an attacker gains, and what they must already
  control to gain it.
- Reproduction steps or a proof of concept.
- Any suggested remediation.

### What to expect

This is a volunteer-maintained open-source project. We aim to:

- acknowledge a report within **5 working days**;
- provide an initial assessment within **10 working days**;
- agree a disclosure timeline with you before publishing anything.

We will credit reporters in the release notes unless you ask us not to.

## Supported versions

`v0.1.0` was published as a pre-release on 2026-09-22. Only the latest minor
release line receives security fixes. Older versions are not supported.

| Version | Supported |
| ------- | --------- |
| `0.1.x` | Yes |
| anything older | No |

## Scope

### In scope

- Authentication and authorization bypasses in `apps/api/src/middleware/auth.ts`
  and `packages/mcp-mongodb/src/http-adapter.ts`.
- CORS misconfiguration that lets an unlisted origin read authenticated responses.
- Injection into MongoDB queries, or any path where model-generated aggregation
  stages escape the whitelist in `apps/api/src/routes/auditor.ts`.
- Secret disclosure: credentials written to logs, error responses, or the console.
- Denial of service reachable without a valid credential.
- Container misconfiguration in `Dockerfile`, `docker-compose.yml`, or
  `scripts/entrypoint.sh` that weakens the boundary described below.

### Out of scope

- Vulnerabilities in MongoDB, the OpenAI API, Flutter, or any other third-party
  dependency. Report those upstream; tell us only if Cerberus uses them unsafely.
- Findings that require an already-compromised host, an already-valid API key, or
  local root/administrator access.
- The absence of features this project deliberately does not have: user accounts,
  roles, OAuth, SSO, multi-tenancy, audit log signing, or per-user attribution.
- Missing HTTP security headers on a service you chose to expose directly to the
  internet without a reverse proxy.
- Reports produced solely by an automated scanner with no demonstrated impact.

## Security model, in brief

Cerberus is a **self-hosted, single-tenant** service. The full threat model is in
[`docs/security/threat-model.md`](docs/security/threat-model.md). The essentials:

- **One shared operator API key** (`CERBERUS_API_KEY`), presented as
  `Authorization: Bearer <key>` or `X-API-Key: <key>` and compared with
  `crypto.timingSafeEqual`. Every endpoint except `GET /health` requires it.
- **One shared internal token** (`CERBERUS_MCP_TOKEN`) between the API and the
  MongoDB persistence adapter.
- **No default credential.** If a mandatory secret is missing outside explicit
  development mode, the process exits at startup rather than starting insecure.
- **Fail closed.** `CERBERUS_DEV_MODE=true` is the only unauthenticated path, and
  it is refused outright when `NODE_ENV=production`.
- **CORS is an allow-list.** With no `CERBERUS_CORS_ORIGINS` and no dev mode, no
  cross-origin access is granted.
- **The MCP adapter binds to loopback by default** and emits no CORS headers
  unless explicitly configured.

### Known limitations you must plan for

- The API key is a shared secret, not a user identity. Cerberus cannot tell two
  operators apart, and revoking one operator's access means rotating the key for
  everyone.
- There is no rate limiting and no replay protection beyond TLS.
- Session state lives in process memory and is lost on restart.
- Deploy behind TLS. Cerberus does not terminate TLS itself.
- Telemetry can contain sensitive content — pasted text, source code, and typed
  characters. Treat the MongoDB volume as sensitive data at rest.

## Operator key rotation

Rotation is manual. There is no automated rotation mechanism.

1. Generate a new key:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Update `CERBERUS_API_KEY` in your secret store and redeploy or restart the API.
3. Generate and set a new `CERBERUS_MCP_TOKEN` at the same time, since the API and
   the adapter must agree on it.
4. Update every client, including the console's build-time
   `--dart-define=CERBERUS_API_KEY=...` value.
5. Revoke the old value everywhere it was stored.

There is no overlap window: the API accepts exactly one key at a time, so rotation
is a brief outage for clients that have not yet been updated. If you need an
overlap, run a second instance behind a proxy.

## Deployment guidance

- Run with `CERBERUS_DEV_MODE=false` and `NODE_ENV=production`.
- Terminate TLS in front of the API. Do not expose `:3001`.
- Set `CERBERUS_CORS_ORIGINS` to the exact origins of your console. Do not use `*`.
- Keep `.env` out of version control and out of container images. It is gitignored.
- Give the MongoDB volume the same protection as any other store of employee data.
- **Get legal advice before monitoring anyone.** Deploying Cerberus against people
  may require notice, consent, or consultation with a works council depending on
  your jurisdiction. That is your responsibility, not the software's.
