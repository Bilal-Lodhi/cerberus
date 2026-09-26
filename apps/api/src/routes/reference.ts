/**
 * Route group: /api/v1/reference-documents
 *
 *   POST   /                     add or update one reference document
 *   GET    /                     list the corpus (metadata and a preview)
 *   DELETE /:referenceId         remove one document
 *
 * ── What this is ──────────────────────────────────────────────────────
 *
 * An operator-managed, local corpus of reference text. It exists so that
 * `DATA_LEAKAGE_SIMILARITY_THRESHOLD` gates something real: risk analysis
 * compares paste content against these documents using a deterministic local
 * algorithm (`services/text-similarity.ts`) and reports the pairs at or above
 * the threshold.
 *
 * ── What this is not ──────────────────────────────────────────────────
 *
 * Cerberus never populates this collection itself. There is no crawler, no
 * bundled corpus, no external service and no third-party content: every entry
 * arrives through this route, from the authenticated operator. A match is
 * evidence that two pieces of text share phrasing — it is not a finding that
 * anything was copied, and the payload says so.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { callMcpTool, MCP_TOOL_NAMES } from "../services/mcp-client.js";

const MCP_TIMEOUT_MS = 5_000;

/** Bounds on one operator-supplied reference document. */
export const MAX_REFERENCE_LABEL_CHARS = 200;
export const MAX_REFERENCE_CONTENT_CHARS = 20_000;
export const MAX_REFERENCE_TAGS = 20;
export const MAX_REFERENCE_TAG_CHARS = 50;

/** How much of a document's content the list response returns. */
export const MAX_REFERENCE_PREVIEW_CHARS = 200;

/** Upper bound on how many documents one list call returns. */
export const MAX_REFERENCE_DOCUMENTS = 200;

/**
 * The stable code the persistence layer returns when the corpus is full.
 *
 * Declared here rather than imported from the MCP package, matching how
 * `mcp-tool-names.ts` mirrors the tool names: `apps/api` does not depend on the package
 * at runtime, and `reference-corpus.test.ts` asserts the two spellings agree.
 */
export const REFERENCE_CORPUS_LIMIT_CODE = "REFERENCE_CORPUS_LIMIT_REACHED";

/** Reads a bounded, required string field. */
function readBoundedString(
  source: Record<string, unknown>,
  key: string,
  maxChars: number,
): { value?: string; error?: string } {
  const raw = source[key];
  if (raw === undefined || raw === null) return {};

  if (typeof raw !== "string") {
    return { error: `Field '${key}' must be a string` };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { error: `Field '${key}' must not be empty` };
  }
  if (trimmed.length > maxChars) {
    return {
      error: `Field '${key}' must be at most ${maxChars} characters (got ${trimmed.length}).`,
    };
  }
  return { value: trimmed };
}

/** Reads a bounded list of non-empty tag strings. */
function readTags(source: Record<string, unknown>): { value?: string[]; error?: string } {
  const raw = source["tags"];
  if (raw === undefined || raw === null) return { value: [] };

  if (!Array.isArray(raw)) {
    return { error: "Field 'tags' must be an array of strings" };
  }
  if (raw.length > MAX_REFERENCE_TAGS) {
    return { error: `Field 'tags' must contain at most ${MAX_REFERENCE_TAGS} entries` };
  }

  const tags: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return { error: "Field 'tags' must contain non-empty strings" };
    }
    const trimmed = entry.trim();
    if (trimmed.length > MAX_REFERENCE_TAG_CHARS) {
      return {
        error: `Each 'tags' entry must be at most ${MAX_REFERENCE_TAG_CHARS} characters`,
      };
    }
    tags.push(trimmed);
  }
  return { value: tags };
}

interface StoredReferenceDocument {
  referenceId?: string;
  label?: string;
  content?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export function createReferenceRouter(config: AppConfig): Hono {
  const referenceRouter = new Hono();

  // ─── POST / — add or update one document ────────────────────────
  referenceRouter.post("/", async (c) => {
    const requestId = randomUUID();

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ success: false, error: "Request body must be a JSON object" }, 400);
    }

    const source = body as Record<string, unknown>;
    const label = readBoundedString(source, "label", MAX_REFERENCE_LABEL_CHARS);
    const content = readBoundedString(source, "content", MAX_REFERENCE_CONTENT_CHARS);
    const tags = readTags(source);
    const requestedId = readBoundedString(source, "referenceId", MAX_REFERENCE_LABEL_CHARS);

    for (const field of [label, content, tags, requestedId]) {
      if (field.error) {
        return c.json(
          { success: false, error: field.error, code: "INVALID_REFERENCE_DOCUMENT" },
          400,
        );
      }
    }

    if (!label.value) {
      return c.json({ success: false, error: "Field 'label' is required" }, 400);
    }
    if (!content.value) {
      return c.json({ success: false, error: "Field 'content' is required" }, 400);
    }

    // An absent id means "new document"; supplying one means "update that one",
    // which is idempotent because the store upserts on it.
    const referenceId = requestedId.value ?? randomUUID();

    const stored = await callMcpTool(
      config,
      MCP_TOOL_NAMES.STORE_REFERENCE_DOCUMENT,
      {
        referenceId,
        label: label.value,
        content: content.value,
        tags: tags.value ?? [],
      },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );

    if (!stored.ok) {
      // A full corpus is a specific, actionable refusal. Reporting it as
      // `REFERENCE_STORE_UNAVAILABLE` — which is what happened before the adapter's code
      // was surfaced — told the operator to retry something that would never succeed.
      if (stored.code === REFERENCE_CORPUS_LIMIT_CODE) {
        console.warn(
          `[reference] [${requestId}] corpus is full — refused referenceId=${referenceId}`,
        );
        return c.json(
          {
            success: false,
            error:
              `The reference corpus is full (${MAX_REFERENCE_DOCUMENTS} documents). ` +
              "Remove a document before adding another.",
            code: REFERENCE_CORPUS_LIMIT_CODE,
            limit: MAX_REFERENCE_DOCUMENTS,
            correlationId: requestId,
          },
          409,
        );
      }

      console.error(`[reference] [${requestId}] store failed: ${stored.error}`);
      return c.json(
        {
          success: false,
          error: "The reference corpus is currently unavailable.",
          code: "REFERENCE_STORE_UNAVAILABLE",
          correlationId: requestId,
        },
        503,
      );
    }

    console.log(
      `[reference] [${requestId}] stored referenceId=${referenceId} ` +
        `chars=${content.value.length} tags=${(tags.value ?? []).length}`,
    );

    return c.json(
      {
        success: true,
        referenceId,
        label: label.value,
        charCount: content.value.length,
        tags: tags.value ?? [],
      },
      201,
    );
  });

  // ─── GET / — list the corpus ────────────────────────────────────
  referenceRouter.get("/", async (c) => {
    const requestId = randomUUID();

    const listed = await callMcpTool<{
      success: boolean;
      data?: StoredReferenceDocument[];
    }>(
      config,
      MCP_TOOL_NAMES.LIST_REFERENCE_DOCUMENTS,
      { limit: MAX_REFERENCE_DOCUMENTS },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );

    if (!listed.ok || !listed.data?.success) {
      return c.json(
        {
          success: false,
          error: "The reference corpus is currently unavailable.",
          code: "REFERENCE_STORE_UNAVAILABLE",
          correlationId: requestId,
        },
        503,
      );
    }

    const documents = Array.isArray(listed.data.data) ? listed.data.data : [];

    // A preview rather than the full content: the corpus is read in full on
    // every risk analysis, and echoing it back here would make this endpoint's
    // response grow with the corpus for no operational benefit.
    return c.json({
      success: true,
      total: documents.length,
      data: documents.map((document) => {
        const content = typeof document.content === "string" ? document.content : "";
        return {
          referenceId: document.referenceId ?? "",
          label: document.label ?? "",
          tags: Array.isArray(document.tags) ? document.tags : [],
          charCount: content.length,
          preview:
            content.length > MAX_REFERENCE_PREVIEW_CHARS
              ? content.slice(0, MAX_REFERENCE_PREVIEW_CHARS)
              : content,
          createdAt: document.createdAt ?? null,
          updatedAt: document.updatedAt ?? null,
        };
      }),
    });
  });

  // ─── DELETE /:referenceId ───────────────────────────────────────
  referenceRouter.delete("/:referenceId", async (c) => {
    const referenceId = c.req.param("referenceId");
    const requestId = randomUUID();

    const result = await callMcpTool<{ deleted?: boolean }>(
      config,
      MCP_TOOL_NAMES.DELETE_REFERENCE_DOCUMENT,
      { referenceId },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );

    if (!result.ok) {
      return c.json(
        {
          success: false,
          error: "The reference corpus is currently unavailable.",
          code: "REFERENCE_STORE_UNAVAILABLE",
          correlationId: requestId,
        },
        503,
      );
    }

    if (result.data?.deleted !== true) {
      return c.json(
        { success: false, error: `Reference document '${referenceId}' not found` },
        404,
      );
    }

    console.log(`[reference] [${requestId}] deleted referenceId=${referenceId}`);
    return c.json({ success: true, referenceId, deleted: true });
  });

  return referenceRouter;
}
