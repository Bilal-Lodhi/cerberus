/**
 * Request body parsing for the MCP HTTP adapter.
 *
 * Extracted from `http-adapter.ts` so it can be tested without starting the
 * adapter: that module connects to MongoDB and exits the process on failure at
 * import time, which makes it untestable in-process.
 *
 * The parser always settles. The previous implementation called `req.destroy()`
 * when a body exceeded the limit and left its promise pending, so the handler
 * hung and the client saw a connection reset instead of a status code — and an
 * oversized body was otherwise indistinguishable from a missing one, surfacing as
 * a confusing "Missing required parameter" 400 rather than a 413.
 */

import type { IncomingMessage } from "node:http";

/**
 * Default maximum accepted request body size, in bytes (8 MiB).
 *
 * Deliberately the same ceiling the API applies, so a body the API admits cannot
 * be rejected here for size. The adapter reads `CERBERUS_MAX_BODY_BYTES` to stay
 * in step with whatever the operator configured.
 */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** The outcome of reading a request body. */
export type ParsedBody =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string };

function reject(status: number, code: string, message: string): ParsedBody {
  return { ok: false, status, code, message };
}

/**
 * Reads and decodes a JSON request body.
 *
 * Resolves exactly once, whatever happens to the stream: an oversized body, a
 * malformed body, a non-object body, a stream error and a client abort all
 * produce an explicit result rather than a pending promise.
 */
export function parseBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<ParsedBody> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const finish = (result: ParsedBody): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on("data", (chunk: Buffer) => {
      if (settled) return;

      size += chunk.length;
      if (size > maxBytes) {
        // Stop reading rather than buffering the rest. The response carries
        // `Connection: close`, so the client is not left waiting on a socket we
        // have stopped draining.
        req.pause();
        finish(
          reject(
            413,
            "PAYLOAD_TOO_LARGE",
            `Request body exceeds the ${maxBytes} byte limit.`,
          ),
        );
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw.trim().length === 0) {
        // An absent body is legitimate: several tools take no arguments.
        finish({ ok: true, body: {} });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        finish(reject(400, "INVALID_JSON", "Request body is not valid JSON."));
        return;
      }

      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        finish(reject(400, "INVALID_BODY", "Request body must be a JSON object."));
        return;
      }

      finish({ ok: true, body: parsed as Record<string, unknown> });
    });

    req.on("error", () =>
      finish(reject(400, "INVALID_BODY", "Request stream failed.")),
    );
    req.on("aborted", () =>
      finish(reject(400, "INVALID_BODY", "Request was aborted.")),
    );
  });
}
