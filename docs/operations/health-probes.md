# Health and readiness probes

Cerberus exposes two probes, and they answer different questions. Using the wrong
one for a given job causes a specific, predictable failure.

| Endpoint | Question | Checks dependencies | Response |
| --- | --- | --- | --- |
| `GET /health` | Is this process running and able to answer HTTP? | **No** | Always `200` while the process is responsive |
| `GET /ready` | Can this instance serve requests that need persistence? | **Yes** | `200` ready, `503` not ready |

Both are unauthenticated: an orchestrator or load balancer probing them does not
hold the operator API key. Neither exposes telemetry or configuration values.

The MCP adapter exposes the same pair on its own port (`GET /health`, `GET /ready`),
where `/ready` pings MongoDB.

## Which one to use where

| Job | Use | Why |
| --- | --- | --- |
| Container restart policy, Kubernetes `livenessProbe` | `/health` | A liveness probe that fails when MongoDB is down makes the orchestrator restart a **perfectly healthy process**, in a loop, while the actual outage continues. That converts a dependency failure into a worse one. |
| Load balancer, Kubernetes `readinessProbe` | `/ready` | Traffic must stop reaching an instance that cannot store anything, without killing it. |
| `docker ps` / `docker compose ps` health column | `/ready` | It is the more informative answer, and Docker does not restart a container merely for being unhealthy. |
| Deploy verification | `/ready` | "The process started" is not "the deployment works". |

The Cerberus `Dockerfile` and `docker-compose.yml` both probe `/ready`, because the
container serves the API and the MCP adapter together — `/health` there would report
healthy while MongoDB was unreachable.

## What readiness reports

```json
{
  "status": "ready",
  "ready": true,
  "service": "cerberus-api",
  "version": "0.1.0",
  "checkedAt": "2026-01-01T00:00:00.000Z",
  "cached": false,
  "dependencies": [
    { "name": "mcp-persistence", "state": "up", "latencyMs": 20 }
  ]
}
```

When it is not ready, the status is `503` and the dependency carries a reason:

```json
{
  "status": "not_ready",
  "ready": false,
  "dependencies": [
    { "name": "mcp-persistence", "state": "down", "detail": "fetch failed", "latencyMs": 2001 }
  ]
}
```

`503`, not `500`. The instance is healthy but cannot serve, which is exactly what a
load balancer needs to know; `500` stays reserved for a request that was mishandled.

The body deliberately contains **no** configuration values — no endpoint, no
database name, no key. It is unauthenticated, so anything in it is public.

## Two properties of the probe worth knowing

**It is cached for two seconds, and concurrent probes share one check.** A readiness
endpoint is polled continuously by every orchestrator and load balancer; without a
cache, each probe becomes a round trip to the persistence layer, so monitoring would
add load in proportion to how closely it is watched. A burst of probes produces one
check, not one per caller.

The consequence is that readiness is eventually consistent within that window: a
dependency that fails is reported as down within about two seconds, not instantly.
That is the intended trade-off, not a defect.

**It always answers.** A dependency check that throws, hangs, or returns nonsense is
reported as a `down` dependency, never as a `500` — because a probe that returns
`500` is not a readiness answer. Each check has its own 2-second deadline, so a
readiness request cannot hang indefinitely on a wedged dependency.

## Why the two endpoints exist at all

Before this split the API had only `/health`, which returned `healthy`
unconditionally. A deployment whose MCP sidecar was down reported itself healthy and
continued accepting telemetry it could not persist. The probe was answering a
question nobody was asking, and the question everybody was asking had no answer.

## Checking a deployment by hand

```bash
# Liveness: expect 200 whenever the process is running.
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/health

# Readiness: expect 200, or 503 with a reason when persistence is unreachable.
curl -s http://localhost:8080/ready | jq .

# The adapter, from inside the container or the host if its port is published.
curl -s http://127.0.0.1:3001/ready | jq .
```

A useful pair to run during an incident:

```bash
curl -s -o /dev/null -w 'health=%{http_code}\n' http://localhost:8080/health
curl -s -o /dev/null -w 'ready=%{http_code}\n'  http://localhost:8080/ready
```

`health=200 ready=503` means: **do not restart anything, fix the dependency.** That
is the state this split exists to make legible.
