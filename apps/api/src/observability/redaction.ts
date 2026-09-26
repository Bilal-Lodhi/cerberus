/**
 * Secret and sensitive-content redaction for log output.
 *
 * ── Why this is its own module ────────────────────────────────────────
 *
 * Redaction is the one part of logging whose failure is silent and permanent: a
 * secret written to a log is a secret disclosed, and no later fix un-discloses it.
 * Keeping it pure, dependency-free and separately tested is what makes it
 * assertable — the tests drive it directly rather than inferring it from a log line.
 *
 * ── Two layers, because neither is sufficient ─────────────────────────
 *
 * 1. **A known-secret registry.** Every configured secret is registered at startup
 *    and every occurrence of it is replaced. This does not depend on recognising the
 *    shape of the surrounding text, so it catches a secret quoted inside a driver
 *    error or embedded in a URL.
 * 2. **Pattern scrubbing.** Credential-shaped content the registry does not know
 *    about — a `mongodb://user:pass@host` URI, a `Bearer` token, a provider key — is
 *    replaced by shape.
 *
 * Layer 1 only knows what configuration told it. Layer 2 only recognises shapes it
 * has been taught. The test suite asserts both, and
 * `docs/security/threat-model.md` §9.3 states the honest limits.
 *
 * ── What is deliberately withheld rather than scrubbed ────────────────
 *
 * Content is not scrubbed, it is **not logged**. `currentCode`, `terminalContent`,
 * `pasteContent` and a telemetry batch have no redacted form that is worth anything:
 * a partially-masked workspace is still the workspace. Those keys are replaced
 * wholesale, and the replacement says so (`[redacted:content]`) rather than silently
 * dropping the field — an operator should be able to see that a field existed and
 * was withheld.
 */

/** Replaces a value that is a credential or a secret. */
export const REDACTED = "[redacted]";

/** Replaces a value that is monitored content, which is never logged at all. */
export const REDACTED_CONTENT = "[redacted:content]";

/** Replaces a value whose type cannot be serialised safely. */
export const UNLOGGABLE = "[unloggable]";

/**
 * Shortest value that is registered as a secret.
 *
 * A short configured value — a four-character dev token — would otherwise be
 * replaced everywhere it appears as a substring, turning every log line into
 * confetti. Eight characters is the shortest thing that is plausibly a credential
 * and implausibly an English word.
 */
const MIN_SECRET_LENGTH = 8;

/** Longest string emitted before truncation. */
export const MAX_LOGGED_STRING_CHARS = 512;

/**
 * How much of a long string the pattern phase inspects.
 *
 * Well above {@link MAX_LOGGED_STRING_CHARS}, which is the point: the emitted window
 * is always inside the inspected window, so **every character that can be emitted has
 * been pattern-scrubbed**. The bound removes work, not the guarantee.
 *
 * A caller can hand the logger a 200 KB string. Without a bound, the scrub cost would
 * be proportional to whatever it was handed — which is the observability regression
 * `docs/development/operability-model.md` §24 exists to prevent, and which this module
 * was measured to have: a 200 KB field took 32 seconds to log because one pattern
 * scanned it quadratically.
 */
export const MAX_PATTERN_SCRUB_CHARS = 4_096;

/** Deepest object walked before the rest is replaced. */
export const MAX_LOGGED_DEPTH = 4;

/** Most array entries emitted before the rest is replaced. */
export const MAX_LOGGED_ARRAY_ENTRIES = 20;

/** Most object keys emitted before the rest is replaced. */
export const MAX_LOGGED_OBJECT_KEYS = 50;

const registeredSecrets = new Set<string>();

/**
 * Registers a configured secret so every occurrence of it is replaced.
 *
 * Idempotent, and a no-op for a value that is absent, empty or too short to be a
 * credential. Returns `true` when the value is now registered, so a caller can
 * assert that configuration actually reached the redactor.
 */
export function registerSecret(value: string | undefined | null): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return false;
  registeredSecrets.add(trimmed);
  return true;
}

/** How many secrets are registered. Exposed so a test can assert the count. */
export function registeredSecretCount(): number {
  return registeredSecrets.size;
}

/** Drops every registered secret. For tests only. */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

/**
 * Replaces every registered secret in `text`.
 *
 * Longest first, so a secret that contains another registered secret cannot leave a
 * suffix of itself behind.
 */
function replaceRegisteredSecrets(text: string): string {
  if (registeredSecrets.size === 0) return text;
  let out = text;
  for (const secret of [...registeredSecrets].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

// ── Credential-shaped patterns ────────────────────────────────────────

/**
 * A URL with a userinfo section. `mongodb://user:pass@host` is the case that
 * matters, but the pattern is scheme-agnostic on purpose: any `scheme://…@host`
 * carries a credential in its userinfo.
 *
 * The userinfo run is bounded. An unbounded `[^\s/@]+` backtracks over the rest of a
 * long string at every start position that matches a scheme, which is quadratic on
 * input a caller controls.
 */
const URI_WITH_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]{1,256}@/gi;

/** `Authorization: Bearer <token>`, and any other bearer token. */
const BEARER_TOKEN = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{4,}/gi;

/** OpenAI-style keys. */
const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{8,}/g;

/** SendGrid API keys. */
const SENDGRID_KEY = /\bSG\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** Slack bot/user/app/refresh tokens. */
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{6,}/g;

/** Google API keys. */
const GOOGLE_API_KEY = /\bAIza[A-Za-z0-9_-]{10,}/g;

/**
 * A Slack incoming-webhook URL.
 *
 * A webhook URL **is** a credential: anyone holding it can post into the channel.
 * The whole URL is replaced, not just its path, because the host alone identifies
 * the tenant.
 */
const SLACK_WEBHOOK = /https:\/\/hooks\.slack\.com\/[^\s"']+/gi;

const PEM_BEGIN = "-----BEGIN ";
const PEM_MARKER = " PRIVATE KEY-----";

/**
 * Removes a PEM private-key block, in one linear pass.
 *
 * Written as a scan rather than a regular expression on purpose. The obvious pattern
 * — `-----BEGIN …-----[\s\S]*?-----END …-----` — is quadratic: with no match, the
 * engine retries the lazy middle at every start position, scanning to the end of the
 * string each time. That is what made a 200 KB field take 32 seconds. `indexOf` cannot
 * backtrack, so the cost is linear in the input.
 */
function stripPemBlocks(text: string): string {
  let out = text;
  let from = 0;

  for (;;) {
    const begin = out.indexOf(PEM_BEGIN, from);
    if (begin === -1) return out;

    const headerEnd = out.indexOf(PEM_MARKER, begin + PEM_BEGIN.length);
    if (headerEnd === -1) return out;

    const label = out.slice(begin + PEM_BEGIN.length, headerEnd);
    const endMarker = `-----END ${label}${PEM_MARKER}`;
    const end = out.indexOf(endMarker, headerEnd + PEM_MARKER.length);
    if (end === -1) return out;

    out = out.slice(0, begin) + REDACTED + out.slice(end + endMarker.length);
    from = begin + REDACTED.length;
  }
}

/**
 * Keys whose value is a credential. Matched case-insensitively against the whole
 * key, so `apiKey`, `api_key` and `API-KEY` all match.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "auth",
  "apikey",
  "api_key",
  "api-key",
  "x-api-key",
  "xapikey",
  "token",
  "mcptoken",
  "mcp_token",
  "sessiontoken",
  "session_token",
  "x-session-token",
  "previousapikey",
  "previousapikeyvalue",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "pwd",
  "credential",
  "credentials",
  "cookie",
  "set-cookie",
  "privatekey",
  "private_key",
  "accesstoken",
  "refreshtoken",
  "webhook",
  "webhookurl",
  "webhook_url",
  "slackwebhookurl",
  "uri",
  "mongodburi",
  "mongo_uri",
  "connectionstring",
  "connection_string",
  "dsn",
  "sendgridapikey",
]);

/**
 * Keys whose value is monitored content, which is withheld rather than scrubbed.
 *
 * The list is the set of fields the threat model calls assets
 * (`docs/security/threat-model.md` §1). `content` and `report` are included
 * deliberately: the first is operator-supplied reference text, the second is a whole
 * risk assessment.
 */
const CONTENT_KEYS: ReadonlySet<string> = new Set([
  "events",
  "event",
  "payload",
  "pastecontent",
  "paste_content",
  "pastessnippets",
  "newtext",
  "new_text",
  "diffpatch",
  "diff_patch",
  "copycontent",
  "copy_content",
  "selectedtext",
  "selected_text",
  "currentcode",
  "current_code",
  "terminalcontent",
  "terminal_content",
  "codesnapshot",
  "code_snapshot",
  "prompt",
  "rolecontext",
  "role_context",
  "question",
  "content",
  "report",
  "scenario",
  "matrix",
  "response",
  "completion",
]);

/** True when a key names a credential. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

/** True when a key names monitored content that is never logged. */
export function isContentKey(key: string): boolean {
  return CONTENT_KEYS.has(key.toLowerCase());
}

/** Applies every credential-shaped pattern. Linear in the length of `text`. */
function applyCredentialPatterns(text: string): string {
  return text
    .replace(URI_WITH_USERINFO, `$1${REDACTED}@`)
    .replace(BEARER_TOKEN, `$1 ${REDACTED}`)
    .replace(OPENAI_STYLE_KEY, REDACTED)
    .replace(SENDGRID_KEY, REDACTED)
    .replace(SLACK_TOKEN, REDACTED)
    .replace(GOOGLE_API_KEY, REDACTED)
    .replace(SLACK_WEBHOOK, REDACTED);
}

/**
 * Scrubs credential-shaped content and control characters from a string, and bounds
 * its length.
 *
 * ── The order is load-bearing ─────────────────────────────────────────
 *
 * 1. **Registered secrets are replaced across the whole string.** These are exact
 *    configured values that must never be disclosed, so they are never subject to a
 *    length bound: a secret straddling the emitted window is still removed.
 * 2. **Credential patterns are applied to a bounded prefix.** {@link
 *    MAX_PATTERN_SCRUB_CHARS} is several times {@link MAX_LOGGED_STRING_CHARS}, so
 *    the emitted window is entirely inside the inspected window and nothing that can
 *    be emitted escapes the patterns. This is what keeps the cost bounded when a
 *    caller hands the logger a megabyte.
 * 3. **The result is truncated to the emitted cap**, with one marker stating how many
 *    of the original characters were withheld.
 *
 * Control characters are escaped rather than removed, so a value that contained a
 * newline is still legible instead of silently losing a line break — and cannot forge
 * a second log line.
 */
export function redactString(text: string): string {
  const withSecretsRemoved = replaceRegisteredSecrets(text);

  if (withSecretsRemoved.length <= MAX_LOGGED_STRING_CHARS) {
    return escapeControlCharacters(
      applyCredentialPatterns(stripPemBlocks(withSecretsRemoved)),
    );
  }

  const inspected = stripPemBlocks(
    withSecretsRemoved.slice(0, MAX_PATTERN_SCRUB_CHARS),
  );
  const scrubbed = escapeControlCharacters(applyCredentialPatterns(inspected));

  return `${scrubbed.slice(0, MAX_LOGGED_STRING_CHARS)}…[+${
    withSecretsRemoved.length - MAX_LOGGED_STRING_CHARS
  } chars]`;
}

/** Renders control characters visible so a value cannot forge a log line. */
export function escapeControlCharacters(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

/** Truncates a string, stating how much was withheld. */
export function truncateString(
  text: string,
  maxChars: number = MAX_LOGGED_STRING_CHARS,
): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[+${text.length - maxChars} chars]`;
}

/**
 * Converts an `Error` into a safe, bounded record.
 *
 * Never the error itself: a provider or driver error can carry a request object, a
 * connection string or an authorization header. Only `name`, a scrubbed `message`
 * and a string `code` survive.
 */
export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const described: Record<string, unknown> = {
      name: error.name,
      // `redactString` bounds the length itself, so there is no second truncation to
      // lose the withheld-count marker.
      message: redactString(error.message),
    };
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0 && code.length <= 64) {
      described["code"] = code;
    }
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) {
      described["status"] = status;
    }
    return described;
  }

  if (typeof error === "string") {
    return { name: "Error", message: redactString(error) };
  }

  return { name: "Error", message: UNLOGGABLE };
}

/**
 * Redacts a value for logging: bounded in depth, breadth and length.
 *
 * A logger that can be handed a 5 MB telemetry body and emit it is a logger that
 * will eventually emit one. Every bound here is enforced structurally, so the
 * guarantee does not depend on a caller passing a small object.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case "string":
      // Already bounded by `redactString`; a second truncation here would truncate the
      // withheld-count marker itself.
      return redactString(value);
    case "number":
      return Number.isFinite(value) ? value : UNLOGGABLE;
    case "boolean":
      return value;
    case "bigint":
      return truncateString(String(value));
    case "function":
    case "symbol":
      return UNLOGGABLE;
    default:
      break;
  }

  if (value instanceof Error) return describeError(value);

  if (depth >= MAX_LOGGED_DEPTH) return "[depth-limit]";

  if (Array.isArray(value)) {
    const entries = value
      .slice(0, MAX_LOGGED_ARRAY_ENTRIES)
      .map((entry) => redactValue(entry, depth + 1));
    if (value.length > MAX_LOGGED_ARRAY_ENTRIES) {
      entries.push(`[+${value.length - MAX_LOGGED_ARRAY_ENTRIES} more]`);
    }
    return entries;
  }

  if (value instanceof Date) return value.toISOString();

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(source);

  for (const key of keys.slice(0, MAX_LOGGED_OBJECT_KEYS)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
    } else if (isContentKey(key)) {
      out[key] = REDACTED_CONTENT;
    } else {
      out[key] = redactValue(source[key], depth + 1);
    }
  }

  if (keys.length > MAX_LOGGED_OBJECT_KEYS) {
    out["…"] = `[+${keys.length - MAX_LOGGED_OBJECT_KEYS} more keys]`;
  }

  return out;
}

/**
 * Registers every configured secret.
 *
 * Called once when the app is built, so a test that constructs a config directly
 * gets the same redaction guarantee as a real deployment — the registry is fed from
 * the config the app was actually given, not from the environment it happened to
 * read.
 */
export function registerConfiguredSecrets(config: {
  auth?: { apiKey?: string; previousApiKey?: string };
  mcp?: { apiKey?: string };
  openai?: { apiKey?: string };
}): number {
  let registered = 0;
  for (const value of [
    config.auth?.apiKey,
    config.auth?.previousApiKey,
    config.mcp?.apiKey,
    config.openai?.apiKey,
  ]) {
    if (registerSecret(value)) registered += 1;
  }
  return registered;
}

/**
 * Notification credentials.
 *
 * Read from the environment here rather than through `loadConfig`, because the
 * notification channels are optional and unset in every test: registering them is
 * about making sure a value that *is* configured can never be logged, and that must
 * not depend on the notification path being reached.
 */
export const NOTIFICATION_SECRET_ENV_VARS = [
  "SLACK_WEBHOOK_URL",
  "SENDGRID_API_KEY",
] as const;
