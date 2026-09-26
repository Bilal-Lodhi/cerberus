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

`v0.4.0` was published as a pre-release on 2026-09-26. Only the latest minor
release line receives security fixes. Older versions are not supported.

| Version | Supported |
| ------- | --------- |
| `0.4.x` | Yes |
| `0.3.x`, `0.2.x`, `0.1.x` | No |
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
- Rate limiting is an in-process backstop, not DDoS defence. It is per process, it
  does not key on the caller, and it deliberately does **not** limit unauthenticated
  requests — a limiter before authentication would let an anonymous caller exhaust a
  bucket and deny service to the operator. Per-caller and unauthenticated throttling
  belong at your reverse proxy; see
  [docs/operations/reverse-proxy.md](docs/operations/reverse-proxy.md).
- Telemetry ingestion has **retry idempotency, not replay protection**. A retried
  batch is stored and counted once, including across a restart, but the monitored
  client supplies the `eventId` that makes that work — a client that wants to re-send
  content sends a fresh one. There is no request signing, nonce or timestamp window
  on the API surface.
- Session state is not durable authority. Counters and lifecycle are written to
  MongoDB and survive a restart; the in-memory event window, the reconstructed
  workspace and the dedup fingerprint ring do not, and are rebuilt on read. See
  [docs/development/session-state-model.md](docs/development/session-state-model.md).
- Deploy behind TLS. Cerberus does not terminate TLS itself.
- Telemetry can contain sensitive content — pasted text, source code, and typed
  characters. Treat the MongoDB volume as sensitive data at rest.

## Operator key rotation

Rotation is manual, but it supports an **overlap** so it does not have to be a hard
cutover.

1. Generate a new key:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Set `CERBERUS_API_KEY` to the new value and `CERBERUS_API_KEY_PREVIOUS` to the old
   one, then restart. Both are now accepted.
3. Update every client, including the console's build-time
   `--dart-define=CERBERUS_API_KEY=...` value.
4. Remove `CERBERUS_API_KEY_PREVIOUS` and restart. That unset **is** the revocation.

Do the same for `CERBERUS_MCP_TOKEN` with `CERBERUS_MCP_TOKEN_PREVIOUS`, on both the
API and the adapter.

Setting a previous key **without** a current key is a startup error: an overlap is not
a replacement. Both comparisons always run, so response time does not reveal which key
matched, and neither key is ever logged.

There is still no key identity and no revocation list — you cannot revoke one key
without revoking the others. The full procedure is in
[docs/operations/key-rotation.md](docs/operations/key-rotation.md).

## Deployment guidance

- Run with `CERBERUS_DEV_MODE=false` and `NODE_ENV=production`.
- Terminate TLS in front of the API. Do not expose `:3001`.
- Set `CERBERUS_CORS_ORIGINS` to the exact origins of your console. Do not use `*`.
- Keep `.env` out of version control and out of container images. It is gitignored.
- Give the MongoDB volume the same protection as any other store of employee data.
- **Get legal advice before monitoring anyone.** Deploying Cerberus against people
  may require notice, consent, or consultation with a works council depending on
  your jurisdiction. That is your responsibility, not the software's.
