/**
 * MCP tool registry.
 *
 * The registry is typed as `Record<McpToolName, ...>`, so TypeScript fails the
 * build if a canonical tool name is ever added without a handler (or a handler
 * is left behind under an old name). That is the compile-time half of the
 * "every renamed tool has a matching implementation" guarantee; the runtime
 * half lives in apps/api/test/mcp-tool-mapping.test.ts.
 */

import type { MongoStore } from "./mongo-client.js";
import { ReferenceCorpusLimitError } from "./mongo-client.js";
import {
  OPERATION_FAILURE_CATEGORIES,
  PAID_ROUTE_FAMILIES,
  type OperationFailureCategory,
  type PaidOperationResult,
  type PaidRouteFamily,
} from "./operation-claims.js";
import {
  MCP_TOOL_NAMES,
  SESSION_STATUSES,
  type McpToolName,
} from "./tool-names.js";

export type ToolHandler = (body: Record<string, unknown>) => Promise<unknown>;

/**
 * How many recent micro-events `get_session_review` returns when the caller does
 * not ask for a specific number.
 *
 * Matches `MongoStore.getSessionEvents`'s own default, so a caller that omits the
 * parameter gets exactly what it got before the parameter existed.
 *
 * Declared above `TOOL_DEFINITIONS` because that object's schema description
 * interpolates it, and a `const` referenced before its declaration is in the
 * temporal dead zone at module-evaluation time.
 */
export const DEFAULT_SESSION_EVENTS_LIMIT = 500;

export interface ToolDefinition {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: Record<McpToolName, ToolDefinition> = {
  [MCP_TOOL_NAMES.STORE_THREAT_SCENARIO]: {
    name: MCP_TOOL_NAMES.STORE_THREAT_SCENARIO,
    description:
      "Persist a complete threat scenario matrix to MongoDB. Used after the CISO agent authors a scenario set.",
    inputSchema: {
      type: "object",
      properties: {
        scenario: {
          type: "object",
          description: "The threat scenario matrix JSON produced by the AI provider",
        },
      },
      required: ["scenario"],
    },
  },

  [MCP_TOOL_NAMES.GET_THREAT_SCENARIO]: {
    name: MCP_TOOL_NAMES.GET_THREAT_SCENARIO,
    description: "Retrieve a persisted threat scenario matrix by its matrixId.",
    inputSchema: {
      type: "object",
      properties: {
        matrixId: { type: "string", description: "UUID matrix identifier" },
      },
      required: ["matrixId"],
    },
  },

  [MCP_TOOL_NAMES.CREATE_SESSION]: {
    name: MCP_TOOL_NAMES.CREATE_SESSION,
    description: "Initialize a new monitored employee session in MongoDB.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        employeeId: { type: "string" },
        auditId: { type: "string" },
        matrixId: { type: "string" },
        targetSystem: { type: "string" },
        status: { type: "string" },
      },
      required: ["sessionId", "employeeId", "auditId"],
    },
  },

  [MCP_TOOL_NAMES.UPDATE_SESSION_TERMINAL_CONTENT]: {
    name: MCP_TOOL_NAMES.UPDATE_SESSION_TERMINAL_CONTENT,
    description:
      "Persist the terminal workspace content for a session. Both gates are optional: " +
      "`expectedStatuses` makes the write a compare-and-set on the session's lifecycle " +
      "status, so the process whose terminal transition actually applied owns the field, and " +
      "`onlyIfAbsent` narrows it to a repair of a terminated session that holds no content " +
      "yet. With neither, the write is unconditional, as before.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        terminalContent: { type: "string" },
        expectedStatuses: {
          type: "array",
          items: { type: "string" },
          description: "Write only while the stored status is one of these.",
        },
        onlyIfAbsent: {
          type: "boolean",
          description: "Write only when the session holds no terminal content yet.",
        },
      },
      required: ["sessionId", "terminalContent"],
    },
  },

  [MCP_TOOL_NAMES.DELETE_SESSION]: {
    name: MCP_TOOL_NAMES.DELETE_SESSION,
    description:
      "Permanently delete a session and all its associated micro-events and risk assessments. " +
      "Reports what was removed per component (session, telemetry, assessments), and names " +
      "any component whose removal failed — a partial deletion is reported as partial rather " +
      "than as complete. The session document is removed last, so a partial failure leaves " +
      "the session identifiable and the deletion retryable.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The session ID to delete" },
      },
      required: ["sessionId"],
    },
  },

  [MCP_TOOL_NAMES.APPEND_MICRO_EVENT]: {
    name: MCP_TOOL_NAMES.APPEND_MICRO_EVENT,
    description: "Append a single telemetry micro-event.",
    inputSchema: {
      type: "object",
      properties: { event: { type: "object" } },
      required: ["event"],
    },
  },

  [MCP_TOOL_NAMES.INGEST_MICRO_EVENTS]: {
    name: MCP_TOOL_NAMES.INGEST_MICRO_EVENTS,
    description:
      "Batch ingest behavioural micro-events (keystrokes, paste triggers, tab switches, copy attempts).",
    inputSchema: {
      type: "object",
      properties: {
        events: {
          type: "array",
          items: { type: "object" },
          description: "Array of MicroEvent objects",
        },
      },
      required: ["events"],
    },
  },

  [MCP_TOOL_NAMES.STORE_RISK_ASSESSMENT]: {
    name: MCP_TOOL_NAMES.STORE_RISK_ASSESSMENT,
    description:
      "Persist a risk assessment payload produced by the Guardian risk analysis.",
    inputSchema: {
      type: "object",
      properties: { report: { type: "object" } },
      required: ["report"],
    },
  },

  [MCP_TOOL_NAMES.UPDATE_SESSION_COUNTS]: {
    name: MCP_TOOL_NAMES.UPDATE_SESSION_COUNTS,
    description:
      "Update the live aggregate counters on a session document. `counts` holds absolute " +
      "totals and is applied with `$max`, so a counter never decreases. `countsDelta` holds " +
      "the newly accepted counts of one batch and is applied with `$inc`, which is what makes " +
      "two processes accepting distinct events both count — see `buildSessionCountsDeltaUpdate`.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        counts: { type: "object" },
        countsDelta: {
          type: "object",
          description: "Counts to add. Negative or non-finite values are ignored.",
        },
      },
      required: ["sessionId", "counts"],
    },
  },

  [MCP_TOOL_NAMES.SET_SESSION_STATUS]: {
    name: MCP_TOOL_NAMES.SET_SESSION_STATUS,
    description:
      "Set a session status (active, locked, terminated). Optionally only while the " +
      "stored status is one of expectedStatuses, making the write a compare-and-set.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        status: { type: "string", enum: [...SESSION_STATUSES] },
        expectedStatuses: {
          type: "array",
          items: { type: "string", enum: [...SESSION_STATUSES] },
          description:
            "When supplied, the update applies only if the stored status is one of " +
            "these. Omit for the previous unconditional behaviour.",
        },
      },
      required: ["sessionId", "status"],
    },
  },

  [MCP_TOOL_NAMES.GET_SESSION_REVIEW]: {
    name: MCP_TOOL_NAMES.GET_SESSION_REVIEW,
    description:
      "Fetch the complete review data for a session: document, events and risk assessments.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        eventsLimit: {
          type: "number",
          description:
            `How many recent events to return. Defaults to ${DEFAULT_SESSION_EVENTS_LIMIT}. ` +
            "0 returns none, for a caller that wants only the session document.",
        },
        includeAssessments: {
          type: "boolean",
          description:
            "Whether to return the risk assessments. Defaults to true. false skips the " +
            "query entirely.",
        },
      },
      required: ["sessionId"],
    },
  },

  [MCP_TOOL_NAMES.GET_EMPLOYEE_RISK_HISTORY]: {
    name: MCP_TOOL_NAMES.GET_EMPLOYEE_RISK_HISTORY,
    description:
      "Aggregate all risk assessments for a specific employee across all sessions.",
    inputSchema: {
      type: "object",
      properties: { employeeId: { type: "string" } },
      required: ["employeeId"],
    },
  },

  [MCP_TOOL_NAMES.LIST_SESSIONS]: {
    name: MCP_TOOL_NAMES.LIST_SESSIONS,
    description: "List all monitored sessions with their aggregate counters.",
    inputSchema: { type: "object", properties: {} },
  },

  [MCP_TOOL_NAMES.STORE_REFERENCE_DOCUMENT]: {
    name: MCP_TOOL_NAMES.STORE_REFERENCE_DOCUMENT,
    description:
      "Upsert one operator-managed reference document used for local data-leakage similarity comparison.",
    inputSchema: {
      type: "object",
      properties: {
        referenceId: { type: "string", description: "Stable identifier; re-submitting updates" },
        label: { type: "string", description: "Human-readable source description" },
        content: { type: "string", description: "The reference text to compare against" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["referenceId", "label", "content"],
    },
  },

  [MCP_TOOL_NAMES.LIST_REFERENCE_DOCUMENTS]: {
    name: MCP_TOOL_NAMES.LIST_REFERENCE_DOCUMENTS,
    description: "List the operator-managed reference corpus, newest first.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
  },

  [MCP_TOOL_NAMES.DELETE_REFERENCE_DOCUMENT]: {
    name: MCP_TOOL_NAMES.DELETE_REFERENCE_DOCUMENT,
    description: "Remove one reference document from the corpus.",
    inputSchema: {
      type: "object",
      properties: { referenceId: { type: "string" } },
      required: ["referenceId"],
    },
  },

  [MCP_TOOL_NAMES.CLAIM_PAID_OPERATION]: {
    name: MCP_TOOL_NAMES.CLAIM_PAID_OPERATION,
    description:
      "Claim a paid operation, or report what an existing claim says. The unique index on " +
      "(routeFamily, keyHash) is the mutual exclusion: two callers racing one key both " +
      "attempt the insert and exactly one is allowed to proceed. Answers with one of " +
      "`claimed`, `reclaimed`, `replay`, `pending` or `conflict`. A caller must not " +
      "spend money unless it was answered `claimed` or `reclaimed`.",
    inputSchema: {
      type: "object",
      properties: {
        routeFamily: { type: "string", enum: [...PAID_ROUTE_FAMILIES] },
        keyHash: { type: "string", description: "sha256 of the caller's Idempotency-Key" },
        fingerprint: { type: "string", description: "sha256 of the canonical request" },
        fingerprintVersion: { type: "number" },
        leaseMs: {
          type: "number",
          description:
            "How long a pending claim blocks a retry. Derived from the provider timeout, " +
            "not configured independently — see deriveLeaseMs.",
        },
        ttlMs: { type: "number", description: "How long the record exists at all." },
      },
      required: ["routeFamily", "keyHash", "fingerprint", "fingerprintVersion", "leaseMs", "ttlMs"],
    },
  },

  [MCP_TOOL_NAMES.COMPLETE_PAID_OPERATION]: {
    name: MCP_TOOL_NAMES.COMPLETE_PAID_OPERATION,
    description:
      "Record a completed paid operation and the response to replay. Conditional on the " +
      "claimId, so a process whose lease expired cannot overwrite a record a reclaimer now " +
      "owns. `completed: false` means the claim is no longer this caller's — which means a " +
      "second execution exists, and must be reported rather than swallowed.",
    inputSchema: {
      type: "object",
      properties: {
        routeFamily: { type: "string", enum: [...PAID_ROUTE_FAMILIES] },
        keyHash: { type: "string" },
        claimId: { type: "string" },
        result: {
          type: "object",
          description: "The response to replay: { status, body }.",
        },
        resultOmitted: {
          type: "string",
          description:
            "Present only when the real result was too large to retain; `result` then " +
            "carries a small truthful substitute.",
        },
        ttlMs: { type: "number" },
      },
      required: ["routeFamily", "keyHash", "claimId", "result", "ttlMs"],
    },
  },

  [MCP_TOOL_NAMES.FAIL_PAID_OPERATION]: {
    name: MCP_TOOL_NAMES.FAIL_PAID_OPERATION,
    description:
      "Record a failed paid operation. A retryable category (provider-unavailable, " +
      "provider-rejected) lets a same-key retry re-execute. A non-retryable category " +
      "(result-persist-failed, result-too-large) means Cerberus observed the provider " +
      "succeed, so a same-key retry replays the recorded failure instead — and therefore " +
      "requires `result`.",
    inputSchema: {
      type: "object",
      properties: {
        routeFamily: { type: "string", enum: [...PAID_ROUTE_FAMILIES] },
        keyHash: { type: "string" },
        claimId: { type: "string" },
        errorCategory: { type: "string", enum: [...OPERATION_FAILURE_CATEGORIES] },
        result: {
          type: "object",
          description:
            "The response to replay. Required when the category is not retryable.",
        },
        ttlMs: { type: "number" },
      },
      required: ["routeFamily", "keyHash", "claimId", "errorCategory", "ttlMs"],
    },
  },

  [MCP_TOOL_NAMES.HEALTH_CHECK]: {
    name: MCP_TOOL_NAMES.HEALTH_CHECK,
    description: "Verify MongoDB connectivity and report store status.",
    inputSchema: { type: "object", properties: {} },
  },
};

/**
 * Bounds on an operator-supplied reference document.
 *
 * The corpus is read in full on every risk analysis, so an unbounded entry would
 * add unbounded work to the ingest path as well as unbounded storage. These are
 * limits on what one document may contribute, not a retention policy.
 */
export const MAX_REFERENCE_CONTENT_CHARS = 20_000;
export const MAX_REFERENCE_LABEL_CHARS = 200;
export const MAX_REFERENCE_TAGS = 20;
export const MAX_REFERENCE_TAG_CHARS = 50;
/** Upper bound on how many corpus documents a single list call returns. */
export const MAX_REFERENCE_DOCUMENTS = 200;

/**
 * Reads an optional non-negative integer.
 *
 * Returns `undefined` when the field is absent, so the caller can tell "not asked"
 * from "asked for zero". A non-numeric or negative value is a `ToolArgumentError`
 * rather than a silent fallback: a caller that asked for `-1` events has a bug, and
 * quietly substituting the default would hide it.
 */
function readOptionalCount(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolArgumentError(`Parameter '${key}' must be a finite number.`);
  }
  const count = Math.floor(value);
  if (count < 0) {
    throw new ToolArgumentError(`Parameter '${key}' must not be negative.`);
  }
  return count;
}

/** Thrown for a missing/invalid tool argument. Surfaces as HTTP 400. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

/**
 * Thrown when the reference corpus is full. Surfaces as HTTP **409** with a stable code.
 *
 * A distinct type because the adapter maps `ToolArgumentError` to 400 and everything else
 * to 500, and "the corpus is full" is neither: the request was well-formed and the server
 * understood it, but it conflicts with the corpus's current state.
 */
export class ReferenceCorpusLimitToolError extends Error {
  readonly code = "REFERENCE_CORPUS_LIMIT_REACHED";

  constructor(
    readonly limit: number,
    readonly count: number,
  ) {
    super(
      `The reference corpus is full: ${count} of ${limit} documents. ` +
        `Remove a document before adding another.`,
    );
    this.name = "ReferenceCorpusLimitToolError";
  }
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolArgumentError(`Missing required parameter: ${key}`);
  }
  return value;
}

function requireObject(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolArgumentError(`Missing required parameter: ${key}`);
  }
  return value as Record<string, unknown>;
}

/**
 * Reads the optional `expectedStatuses` compare-and-set predicate.
 *
 * Shared by `set_session_status` and `update_session_terminal_content`, so the two cannot
 * disagree about what a predicate is or which statuses one may name. Every entry is checked
 * against the store's own vocabulary, so a caller cannot predicate on a status the store can
 * never hold — which would match nothing and read as "the session changed under me" for
 * every attempt.
 */
function readExpectedStatuses(
  body: Record<string, unknown>,
): readonly string[] | undefined {
  const raw = body["expectedStatuses"];
  if (raw === undefined || raw === null) return undefined;

  if (!Array.isArray(raw)) {
    throw new ToolArgumentError(
      "Parameter 'expectedStatuses' must be an array of session statuses.",
    );
  }

  return raw.map((entry) => {
    if (typeof entry !== "string") {
      throw new ToolArgumentError(
        "Parameter 'expectedStatuses' must contain only strings.",
      );
    }
    if (!(SESSION_STATUSES as readonly string[]).includes(entry)) {
      throw new ToolArgumentError(
        `Invalid expected status '${entry}'. Must be one of: ` +
          `${SESSION_STATUSES.join(", ")}`,
      );
    }
    return entry;
  });
}

/** Reads a required string and enforces a maximum length. */
function requireBoundedString(
  body: Record<string, unknown>,
  key: string,
  maxChars: number,
): string {
  const value = requireString(body, key);
  if (value.length > maxChars) {
    throw new ToolArgumentError(
      `Parameter '${key}' must be at most ${maxChars} characters (got ${value.length}).`,
    );
  }
  return value;
}

/**
 * Reads an optional string list, bounding both its length and each entry.
 *
 * A non-array, or an array containing non-strings, is rejected rather than
 * coerced: silently dropping a tag would make the stored document differ from
 * what the operator submitted.
 */
function readBoundedTags(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) {
    throw new ToolArgumentError(`Parameter '${key}' must be an array of strings.`);
  }
  if (value.length > MAX_REFERENCE_TAGS) {
    throw new ToolArgumentError(
      `Parameter '${key}' must contain at most ${MAX_REFERENCE_TAGS} entries.`,
    );
  }

  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new ToolArgumentError(`Parameter '${key}' must contain non-empty strings.`);
    }
    const trimmed = entry.trim();
    if (trimmed.length > MAX_REFERENCE_TAG_CHARS) {
      throw new ToolArgumentError(
        `Each '${key}' entry must be at most ${MAX_REFERENCE_TAG_CHARS} characters.`,
      );
    }
    return trimmed;
  });
}

/** Reads a required finite number. Surfaces as HTTP 400 rather than becoming `NaN`. */
function requireFiniteNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolArgumentError(`Parameter '${key}' must be a finite number.`);
  }
  return value;
}

/**
 * Reads the route family, checked against the vocabulary.
 *
 * Validated rather than accepted as any string: the family is half of the unique index, so
 * an unvalidated value would let a caller create a key namespace the API can never address
 * — a record that is unreachable and never expires into a conflict.
 */
function readRouteFamily(body: Record<string, unknown>): PaidRouteFamily {
  const value = body["routeFamily"];
  if (typeof value !== "string" || !(PAID_ROUTE_FAMILIES as readonly string[]).includes(value)) {
    throw new ToolArgumentError(
      `Parameter 'routeFamily' must be one of: ${PAID_ROUTE_FAMILIES.join(", ")}`,
    );
  }
  return value as PaidRouteFamily;
}

/** Reads the failure category, checked against the vocabulary. */
function readFailureCategory(body: Record<string, unknown>): OperationFailureCategory {
  const value = body["errorCategory"];
  if (
    typeof value !== "string" ||
    !(OPERATION_FAILURE_CATEGORIES as readonly string[]).includes(value)
  ) {
    throw new ToolArgumentError(
      `Parameter 'errorCategory' must be one of: ${OPERATION_FAILURE_CATEGORIES.join(", ")}`,
    );
  }
  return value as OperationFailureCategory;
}

/**
 * Reads a `{ status, body }` response to replay.
 *
 * The status is checked to be an HTTP status rather than trusted: a record whose replay
 * status was `NaN` or `0` would answer a retry with a status no client can interpret, which
 * is worse than refusing to write the record in the first place.
 */
function readReplayableResult(
  body: Record<string, unknown>,
  key: string,
): PaidOperationResult {
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolArgumentError(`Parameter '${key}' must be an object.`);
  }

  const record = value as Record<string, unknown>;
  const status = record["status"];
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new ToolArgumentError(
      `Parameter '${key}.status' must be an integer HTTP status between 100 and 599.`,
    );
  }

  return { status, body: record["body"] };
}

export function createToolRegistry(store: MongoStore): Record<McpToolName, ToolHandler> {
  return {
    [MCP_TOOL_NAMES.STORE_THREAT_SCENARIO]: async (body) => {
      const scenario = requireObject(body, "scenario");
      const mongoDocumentId = await store.storeThreatScenario(scenario);
      return { success: true, mongoDocumentId };
    },

    [MCP_TOOL_NAMES.GET_THREAT_SCENARIO]: async (body) => {
      const matrixId = requireString(body, "matrixId");
      const data = await store.getThreatScenario(matrixId);
      return { success: true, data };
    },

    [MCP_TOOL_NAMES.CREATE_SESSION]: async (body) => {
      const mongoDocumentId = await store.createSession(body);
      return { success: true, mongoDocumentId };
    },

    [MCP_TOOL_NAMES.UPDATE_SESSION_TERMINAL_CONTENT]: async (body) => {
      const sessionId = requireString(body, "sessionId");
      const terminalContent = requireString(body, "terminalContent");

      // Both gates are optional, so a direct MCP client calling this with neither keeps the
      // previous unconditional behaviour — the published capability is unchanged. The API's
      // terminate path supplies both, which is what makes the transition that applied the
      // owner of the field.
      const expectedStatuses = readExpectedStatuses(body);
      const onlyIfAbsent = body["onlyIfAbsent"] === true;

      const updated = await store.updateSessionTerminalContent(sessionId, terminalContent, {
        ...(expectedStatuses ? { expectedStatuses } : {}),
        ...(onlyIfAbsent ? { onlyIfAbsent } : {}),
      });

      // `updated` is reported rather than inferred from `success`, so a caller can tell a
      // real write from a no-op. `success` keeps its meaning — the call was handled — so a
      // caller reading only `success` is unaffected.
      return { success: true, updated };
    },

    [MCP_TOOL_NAMES.DELETE_SESSION]: async (body) => {
      const sessionId = requireString(body, "sessionId");
      const report = await store.deleteSession(sessionId);

      const complete = report.failed.length === 0;

      return {
        success: true,
        // Whether the **session document** existed and was removed. Unchanged in meaning,
        // so a caller that only reads `deleted` keeps working.
        deleted: report.session > 0,
        // ── The per-component outcome ──
        //
        // A single `Promise.all` over three collections reports nothing about which one
        // failed, so a partial deletion was indistinguishable from a complete one. The
        // counts are what actually happened, and `failedComponents` names what did not.
        complete,
        partial: !complete,
        components: {
          session: { deleted: report.session },
          telemetry: { deleted: report.telemetry },
          assessments: { deleted: report.assessments },
        },
        failedComponents: report.failed,
      };
    },

    [MCP_TOOL_NAMES.APPEND_MICRO_EVENT]: async (body) => {
      const event = requireObject(body, "event");
      const processedCount = await store.ingestMicroEvents([event]);
      return { success: true, processedCount };
    },

    [MCP_TOOL_NAMES.INGEST_MICRO_EVENTS]: async (body) => {
      const events = body["events"];
      if (!Array.isArray(events)) {
        throw new ToolArgumentError("Missing required parameter: events (array)");
      }
      const batch = events as Record<string, unknown>[];
      const { acceptedEventIds, duplicateEventIds } = await store.ingestMicroEvents(batch);
      return {
        success: true,
        // `processedCount` keeps its old meaning for existing callers: the size
        // of the batch. `acceptedEventIds` is what tells a caller which events
        // were actually new, so a retry does not inflate in-memory counters.
        processedCount: batch.length,
        acceptedEventIds,
        duplicateEventIds,
      };
    },

    [MCP_TOOL_NAMES.STORE_RISK_ASSESSMENT]: async (body) => {
      const report = requireObject(body, "report");
      const { documentId, riskAssessmentId, inserted } =
        await store.storeRiskAssessment(report);
      return {
        success: true,
        mongoDocumentId: documentId,
        riskAssessmentId,
        // Additive: `false` means this incident's assessment was already stored, so a
        // retry after an ambiguous response did not create a second row. `success`
        // stays true either way — the evidence exists, which is what the caller asked
        // for.
        inserted,
      };
    },

    [MCP_TOOL_NAMES.UPDATE_SESSION_COUNTS]: async (body) => {
      const sessionId = requireString(body, "sessionId");
      const counts = requireObject(body, "counts");

      // Optional additive mode. Absent keeps the previous behaviour exactly, so an existing
      // MCP caller is unaffected.
      const rawDelta = body["countsDelta"];
      let delta: Record<string, unknown> | undefined;
      if (rawDelta !== undefined && rawDelta !== null) {
        delta = requireObject(body, "countsDelta");
      }

      await store.updateSessionCounts(
        sessionId,
        {
          eventCount: (counts["eventCount"] as number) ?? 0,
          pasteCount: counts["pasteCount"] as number | undefined,
          tabSwitchCount: counts["tabSwitchCount"] as number | undefined,
          // Both spellings are accepted and map to one durable field. `focusLossCount` is
          // canonical; `fullscreenExitCount` is the deprecated name, kept because this tool
          // is a published interface and the counter is the same number under either name.
          // See `buildSessionCountsUpdate`.
          focusLossCount: counts["focusLossCount"] as number | undefined,
          fullscreenExitCount: counts["fullscreenExitCount"] as number | undefined,
          copyAttemptCount: counts["copyAttemptCount"] as number | undefined,
          peakRiskScore: counts["peakRiskScore"] as number | undefined,
          status: counts["status"] as string | undefined,
        },
        {
          ...(delta
            ? {
                delta: {
                  eventCount: delta["eventCount"] as number | undefined,
                  pasteCount: delta["pasteCount"] as number | undefined,
                  tabSwitchCount: delta["tabSwitchCount"] as number | undefined,
                  focusLossCount: delta["focusLossCount"] as number | undefined,
                  fullscreenExitCount: delta["fullscreenExitCount"] as number | undefined,
                  copyAttemptCount: delta["copyAttemptCount"] as number | undefined,
                },
              }
            : {}),
        },
      );
      return { success: true };
    },

    [MCP_TOOL_NAMES.SET_SESSION_STATUS]: async (body) => {
      const sessionId = requireString(body, "sessionId");
      const status = requireString(body, "status");
      if (!(SESSION_STATUSES as readonly string[]).includes(status)) {
        throw new ToolArgumentError(
          `Invalid status. Must be one of: ${SESSION_STATUSES.join(", ")}`,
        );
      }

      // Optional compare-and-set predicate. An absent value keeps the previous
      // unconditional behaviour; a supplied one is validated against the same
      // vocabulary as `status`, so a caller cannot predicate on a status that could
      // never have been stored. Shared with `update_session_terminal_content`, so the
      // two cannot disagree about what a predicate is.
      const expectedStatuses = readExpectedStatuses(body);

      const updated = await store.setSessionStatus(sessionId, status, {
        ...(expectedStatuses ? { expectedStatuses } : {}),
      });
      return { success: true, status, updated };
    },

    [MCP_TOOL_NAMES.GET_SESSION_REVIEW]: async (body) => {
      const sessionId = requireString(body, "sessionId");
      const eventsLimit =
        readOptionalCount(body, "eventsLimit") ?? DEFAULT_SESSION_EVENTS_LIMIT;
      const includeAssessments = body["includeAssessments"] !== false;
      // Assessments are already sorted newest-first, so a limit of 1 is "the latest
      // assessment" — which is what a caller that needs one field from it wants, rather
      // than the whole history.
      const assessmentsLimit = readOptionalCount(body, "assessmentsLimit");

      // A limit of 0 skips the query rather than passing 0 to the driver, where
      // `.limit(0)` means "no limit" and would return the entire collection.
      const [session, events, riskAssessments] = await Promise.all([
        store.getSession(sessionId),
        eventsLimit === 0
          ? Promise.resolve([])
          : store.getSessionEvents(sessionId, { limit: eventsLimit }),
        includeAssessments
          ? store.getRiskAssessments(sessionId, { limit: assessmentsLimit })
          : Promise.resolve([]),
      ]);
      return { success: true, session, events, riskAssessments };
    },

    [MCP_TOOL_NAMES.GET_EMPLOYEE_RISK_HISTORY]: async (body) => {
      const employeeId = requireString(body, "employeeId");
      const reports = await store.getEmployeeRiskHistory(employeeId);
      return { success: true, reports };
    },

    [MCP_TOOL_NAMES.LIST_SESSIONS]: async () => {
      const data = await store.listSessions();
      return { success: true, data };
    },

    [MCP_TOOL_NAMES.STORE_REFERENCE_DOCUMENT]: async (body) => {
      const referenceId = requireBoundedString(body, "referenceId", MAX_REFERENCE_LABEL_CHARS);
      const label = requireBoundedString(body, "label", MAX_REFERENCE_LABEL_CHARS);
      const content = requireBoundedString(body, "content", MAX_REFERENCE_CONTENT_CHARS);
      const tags = readBoundedTags(body, "tags");

      try {
        const result = await store.storeReferenceDocument(
          { referenceId, label, content, tags },
          { limit: MAX_REFERENCE_DOCUMENTS },
        );
        return {
          success: true,
          referenceId: result.referenceId,
          // Additive: `false` means this updated an existing document, which is always
          // allowed because it does not grow the corpus.
          created: result.created,
          count: result.count,
          limit: MAX_REFERENCE_DOCUMENTS,
        };
      } catch (error) {
        if (error instanceof ReferenceCorpusLimitError) {
          // A specific, actionable refusal rather than an unavailability. The adapter
          // maps a `ToolArgumentError` to 400 and anything else to 500, so the ceiling
          // needs its own type for the route to answer 409 with a stable code instead of
          // 503 "the corpus is unavailable".
          throw new ReferenceCorpusLimitToolError(error.limit, error.count);
        }
        throw error;
      }
    },

    [MCP_TOOL_NAMES.LIST_REFERENCE_DOCUMENTS]: async (body) => {
      const rawLimit = body["limit"];
      const requested =
        typeof rawLimit === "number" && Number.isFinite(rawLimit)
          ? Math.floor(rawLimit)
          : MAX_REFERENCE_DOCUMENTS;
      // Clamped rather than rejected: a caller asking for more than the ceiling
      // gets the ceiling, which is a bound on work rather than an error.
      const limit = Math.min(Math.max(requested, 1), MAX_REFERENCE_DOCUMENTS);

      const data = await store.listReferenceDocuments(limit);
      return { success: true, data };
    },

    [MCP_TOOL_NAMES.DELETE_REFERENCE_DOCUMENT]: async (body) => {
      const referenceId = requireBoundedString(body, "referenceId", MAX_REFERENCE_LABEL_CHARS);
      const deleted = await store.deleteReferenceDocument(referenceId);
      return { success: true, deleted };
    },

    [MCP_TOOL_NAMES.CLAIM_PAID_OPERATION]: async (body) => {
      const routeFamily = readRouteFamily(body);
      const keyHash = requireString(body, "keyHash");
      const fingerprint = requireString(body, "fingerprint");
      const fingerprintVersion = requireFiniteNumber(body, "fingerprintVersion");
      const leaseMs = requireFiniteNumber(body, "leaseMs");
      const ttlMs = requireFiniteNumber(body, "ttlMs");

      const outcome = await store.claimPaidOperation({
        routeFamily,
        keyHash,
        fingerprint,
        fingerprintVersion,
        leaseMs,
        ttlMs,
      });

      // Reported verbatim rather than flattened into `success`. The caller's decision —
      // spend or do not spend — turns entirely on which outcome this was, so a shape that
      // lost the distinction would be a shape that could be misread into a second charge.
      return { success: true, ...outcome };
    },

    [MCP_TOOL_NAMES.COMPLETE_PAID_OPERATION]: async (body) => {
      const routeFamily = readRouteFamily(body);
      const keyHash = requireString(body, "keyHash");
      const claimId = requireString(body, "claimId");
      const result = readReplayableResult(body, "result");
      const ttlMs = requireFiniteNumber(body, "ttlMs");

      const completed = await store.completePaidOperation({
        routeFamily,
        keyHash,
        claimId,
        result,
        ttlMs,
        ...(typeof body["resultOmitted"] === "string"
          ? { resultOmitted: body["resultOmitted"] }
          : {}),
      });

      // `completed: false` is not an error, and it is not "already done": it means this
      // claim is no longer ours, which means a second execution exists. Reporting it as a
      // plain `success` would hide the one state the mechanism cannot rule out.
      return { success: true, completed };
    },

    [MCP_TOOL_NAMES.FAIL_PAID_OPERATION]: async (body) => {
      const routeFamily = readRouteFamily(body);
      const keyHash = requireString(body, "keyHash");
      const claimId = requireString(body, "claimId");
      const errorCategory = readFailureCategory(body);
      const ttlMs = requireFiniteNumber(body, "ttlMs");
      const result =
        body["result"] === undefined || body["result"] === null
          ? undefined
          : readReplayableResult(body, "result");

      const recorded = await store.failPaidOperation({
        routeFamily,
        keyHash,
        claimId,
        errorCategory,
        ttlMs,
        ...(result ? { result } : {}),
      });

      return { success: true, recorded };
    },

    [MCP_TOOL_NAMES.HEALTH_CHECK]: async () => {
      const healthy = await store.ping();
      return {
        connected: store.isConnected(),
        healthy,
        timestamp: new Date().toISOString(),
      };
    },
  };
}
