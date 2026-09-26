# Running Cerberus behind a reverse proxy

Cerberus has no TLS of its own and no per-caller identity. Both facts shape what a
proxy in front of it has to do.

## What the proxy must own

| Concern | Why it cannot be Cerberus |
| --- | --- |
| **TLS termination** | The API and the MCP adapter speak plain HTTP. The MCP adapter is bound to loopback by default and is not designed to face a network. |
| **Per-caller rate limiting** | Cerberus authenticates with **one shared key**, so there is no caller to key a limit on. Its own limiter bounds the total rate per route category. Only the proxy sees an address per client. |
| **Throttling unauthenticated requests** | Cerberus deliberately rate limits *after* authentication. A limiter before auth would let an anonymous caller exhaust a category's bucket and deny service to the operator — a backstop turned into a denial-of-service amplifier. |
| **Request size, connection limits, timeouts** | `CERBERUS_MAX_BODY_BYTES` bounds one body; it says nothing about how many connections arrive or how long they linger. |

## `X-Forwarded-For` is not trusted, on purpose

Cerberus never reads `X-Forwarded-For`, `X-Real-IP` or `Forwarded`. Behind a proxy
those headers are **caller-controlled** unless the proxy is configured to overwrite
them, and behind no proxy they are meaningless. Trusting them would let any caller
mint a fresh rate-limit bucket per request, which is worse than not limiting at all.

If you need per-caller limits, do them **at the proxy**, where the client address is
a fact rather than a claim.

## Minimal configuration

The API listens on `PORT` (default `8080`). Proxy everything to it, except the MCP
adapter, which should stay on loopback:

```nginx
# nginx — TLS termination, per-caller limiting, then Cerberus.
limit_req_zone $binary_remote_addr zone=cerberus_per_client:10m rate=10r/s;

server {
    listen 443 ssl;
    server_name cerberus.example.internal;

    ssl_certificate     /etc/ssl/cerberus.crt;
    ssl_certificate_key /etc/ssl/cerberus.key;

    # Bound request bodies here too, and keep the two ceilings consistent with
    # CERBERUS_MAX_BODY_BYTES (default 8 MiB).
    client_max_body_size 8m;

    location / {
        limit_req zone=cerberus_per_client burst=20 nodelay;

        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $remote_addr;   # overwrite, never append
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

Two things about that snippet matter:

- **`client_max_body_size` must not exceed `CERBERUS_MAX_BODY_BYTES`.** The API
  validates its own value fail-closed at startup, and the MCP adapter reads the same
  variable so the two cannot drift. A proxy that admits more than the API does just
  moves the 413.
- **`X-Forwarded-For` is set, not appended.** Cerberus ignores it either way, but
  setting it means anything else in your stack that *does* trust it gets a value
  your proxy controls rather than one the client supplied.

## Two limits, one deployment

Cerberus's own limiter and the proxy's are not redundant; they answer different
questions.

| Limit | Answers |
| --- | --- |
| Proxy, per client address | "Is one client behaving badly?" |
| Cerberus, per route category | "Is the deployment as a whole spending more than it should?" |

The second is the one that matters for cost: the AI endpoints spend money per
request, and the shared key means a single compromised console can spend the whole
budget. `CERBERUS_AI_REQUESTS_PER_MINUTE` is the ceiling on that, and it applies
however many clients are behind the proxy.

## Scaling out

Cerberus's limiter is **per process**. Running three replicas behind a load balancer
enforces up to three times the configured limit, and each replica's buckets refill
independently. That is stated rather than implied.

If the deployment needs a single global ceiling, terminate at one process, or move
the limit to a shared store at the proxy. Cerberus does not ship a distributed
limiter: doing so means adding Redis, which the OSS baseline deliberately does not
require.

**This is a decision, not an omission.** A Mongo-backed limiter was considered and rejected: it
would put a write on the hot path of every request — including ingestion, which the console drives
one event at a time — to enforce a bound that is explicitly a backstop. The full reasoning, and
everything else that changes when you run more than one replica, is in
[multi-replica.md](multi-replica.md) §2.1.

The practical consequence is worth repeating here, because the proxy is where the fix goes: **the
`ai` bucket bounds spend, and its ceiling multiplies by the replica count.** An operator running
more than one replica should set the spend limit at the proxy rather than relying on
`CERBERUS_AI_REQUESTS_PER_MINUTE`.
