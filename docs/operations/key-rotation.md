# Rotating the shared secrets

Cerberus authenticates with two pre-shared secrets and no identity system:

| Secret | Protects | Variable |
| --- | --- | --- |
| Operator API key | Every API endpoint except `GET /health` | `CERBERUS_API_KEY` |
| MCP shared token | The persistence sidecar | `CERBERUS_MCP_TOKEN` |

Both support an **overlap**: a second, previous value that is accepted alongside
the current one so a rotation does not require a hard cutover.

This is deliberately the minimum that makes rotation possible. There is no key
identity, no revocation list, no per-key audit trail and no rotation tooling.
Adding any of those means adding an identity system, which the OSS baseline
explicitly does not have.

## Why an overlap, and not just a new key

Changing a shared secret without an overlap means every client holding the old
value fails the moment the server restarts, and there is no window in which both
work. For the API key that is a brief outage for every operator console; for the
MCP token it is a period where the API cannot persist anything at all. An overlap
turns a cutover into a sequence.

## Rotating the operator API key

Generate a new key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then, in four steps:

1. **Move the current key to the previous slot, and set the new one.** In your
   environment (a secret manager, or `.env` for a local stack):

   ```
   CERBERUS_API_KEY=<new key>
   CERBERUS_API_KEY_PREVIOUS=<old key>
   ```

2. **Restart the API.** The startup banner reports `apiKey=set
   previousApiKey=set`. Both keys are now accepted, and the two comparisons always
   run, so the response time does not reveal which one matched.

3. **Move every client to the new key** — the operator console's build-time
   `--dart-define`, any scripts, any proxy that injects the credential. Confirm
   each one works.

4. **End the overlap.** Remove `CERBERUS_API_KEY_PREVIOUS` and restart. The banner
   reports `previousApiKey=unset`, and the old key is now rejected. That unset *is*
   the revocation: there is no other.

Verify at any point:

```bash
# Should be 200 during the overlap, 401 after it ends.
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer <old key>" \
  http://localhost:8080/api/v1/sessions
```

### What Cerberus refuses to do

- **A previous key with no current key is a startup error.** An overlap is not a
  replacement; a deployment authenticating only against the credential it is
  retiring is not a state worth supporting. The process exits with a `ConfigError`
  that says so.
- **A previous key equal to the current key is accepted, and warned about.** It is
  a no-op rather than a misconfiguration, and the warning is what tells an operator
  the rotation is already finished.
- **Neither key is ever logged.** The banner reports `set` or `unset` and nothing
  else. Failure responses are identical whether the credential was missing, wrong,
  or a retired key.

## Rotating the MCP shared token

The same procedure, on the sidecar and the API together:

1. Set `CERBERUS_MCP_TOKEN=<new token>` and
   `CERBERUS_MCP_TOKEN_PREVIOUS=<old token>`. **Both the API and the MCP adapter
   read these**, and both must be restarted — the adapter validates the token it
   receives, and the API presents it.
2. Confirm the adapter logs `previousToken=accepted` and that the API can still
   persist (ingest one event and check it is stored).
3. Remove `CERBERUS_MCP_TOKEN_PREVIOUS` from both services and restart. The adapter
   logs `previousToken=none`.

The MCP adapter is server-to-server and normally bound to loopback. If it is
reachable by anything else, rotate it with the same care as the API key — it grants
full read and delete access to the persistence layer.

## Rotating both at once

Rotate them **separately**, API key first. Rotating both in one restart means one
window in which a failure has two possible causes, and the API key is the credential
you need in order to diagnose the MCP token.

## What an overlap does not do

- It does not invalidate sessions, tokens or handles. The API is stateless with
  respect to the key; there is nothing to invalidate.
- It does not rotate the OpenAI key or the notification credentials. Those are
  provider-side and are changed by updating the variable and restarting; see
  [configuration.md](../configuration.md).
- It does not protect a key that has already leaked. Ending the overlap removes
  access for anyone holding the old value, but anything that value already
  authorised has already happened.

## More than one replica

The procedure above is written for one process. With N, the ordering matters more, because a
replica still holding the retired key rejects every request that lands on it — and it is
indistinguishable from a correct replica until that happens.

**The rule: the new key is everywhere before the old key is anywhere retired.** The per-replica
check that makes that verifiable, and the MCP adapter's extra ordering constraint, are in
[multi-replica.md](multi-replica.md) §3. The short version: roll every replica with both values
set, confirm **each replica directly** — not through the load balancer — still accepts the old
key, move the clients, then remove the previous value everywhere and roll again.

There is no key generation id and no revocation list, and this does not add one: a replica cannot
report which generation it is running without publishing information about the secret. The
per-replica loop is the detection.
