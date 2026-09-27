/**
 * The in-process MCP stand-ins `npm run bench` drives the application through.
 *
 * ── Why these are a module ────────────────────────────────────────────
 *
 * They were closures inside `run-bench.mjs`, which made them untestable: the only way to
 * check a double against the thing it doubles was to read it. That is how this file's
 * predecessor shipped for four releases with `get_session_review` ignoring the
 * `eventsLimit` and `includeAssessments` arguments the API sends — so every ingest and
 * every live-detail read carried up to 500 micro-events the real store does not return,
 * and the benchmark's live-detail figure measured the double rather than the route.
 *
 * `performance-baseline.md` already names this failure mode three times under *"The stubs
 * must match the real store's bounds"*. Moving the doubles here is what lets
 * `apps/api/test/bench-double.test.ts` drive the same call through this double **and**
 * through the real tool registry and assert the two agree, so the next divergence fails a
 * test instead of quietly re-inflating a baseline.
 *
 * ── What a double here is allowed to be ───────────────────────────────
 *
 * A stand-in for the **store's responses**, not for the tool registry's argument
 * validation. The registry's 400s are its own contract and are covered by
 * `store-contract.test.ts`; duplicating them here would give the benchmark two places to
 * be wrong. What must match is the *shape and the bounds* of a successful answer.
 */

/**
 * The store's own default cap on a review's events.
 *
 * `DEFAULT_SESSION_EVENTS_LIMIT` in `packages/mcp-mongodb/src/tools.ts`, and
 * `MongoStore.getSessionEvents`'s `limit ?? 500`. Duplicated as a literal because this is
 * a plain `.mjs` script and the registry is TypeScript; the fidelity test asserts the two
 * agree by exercising both, so the duplication cannot drift unnoticed.
 */
export const DEFAULT_SESSION_EVENTS_LIMIT = 500;

/** A risk payload the stubbed provider returns. Below AUTO_LOCK_THRESHOLD: no lock, no alert. */
export function benchRiskPayload(score = 40) {
  return {
    riskAssessmentId: "11111111-1111-4111-8111-111111111111",
    overallRiskScore: score,
    dimensionScores: { dataExfiltration: score },
    flags: [],
    exfiltrationReport: null,
    behavioralAnomalies: [],
    generatedAt: new Date().toISOString(),
  };
}

/** The canned Chat Completions answer the stubbed provider returns. */
function chatCompletion(score) {
  return Response.json({
    id: "cmpl-bench",
    object: "chat.completion",
    created: 0,
    model: "bench",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(benchRiskPayload(score)) },
        finish_reason: "stop",
      },
    ],
  });
}

/**
 * A stateful MCP stand-in, matching the real store's observable contract.
 *
 * Returns `{ restore, counts }`; `counts` is how many times each tool was called, which is
 * what makes "does this case make one durable read or twenty" a measured fact.
 */
export function installMcpStub({ score = 40 } = {}) {
  const sessions = new Map();
  const events = new Map();
  const assessments = new Map();
  const storedEventKeys = new Set();
  const counts = new Map();
  const original = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    const target = typeof url === "string" ? url : url.url;

    // The AI provider.
    if (target.includes("/chat/completions")) return chatCompletion(score);

    // The MCP adapter.
    const tool = target.split("/tools/")[1];
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    counts.set(tool, (counts.get(tool) ?? 0) + 1);

    switch (tool) {
      case "create_session": {
        const id = String(body.sessionId);
        if (!sessions.has(id)) sessions.set(id, { ...body, createdAt: new Date().toISOString() });
        return Response.json({ success: true, mongoDocumentId: `doc-${id}` });
      }

      case "get_session_review": {
        const id = String(body.sessionId);

        // ── The bounds the API actually sends ────────────────────────────
        //
        // `readOptionalCount(body, "eventsLimit") ?? DEFAULT_SESSION_EVENTS_LIMIT`, and
        // `body.includeAssessments !== false`. Both are honoured here, and the reason is
        // the one this file's header states: the real store skips the events query
        // outright at `eventsLimit: 0`, so a double that returns 500 events instead makes
        // every ingest and every live-detail read carry a history the real store never
        // sends. The count is what a reader of the results table is comparing.
        const requested = body.eventsLimit;
        const eventsLimit =
          requested === undefined || requested === null
            ? DEFAULT_SESSION_EVENTS_LIMIT
            : Number(requested);
        const includeAssessments = body.includeAssessments !== false;

        const all = events.get(id) ?? [];

        // `MongoStore.getSessionEvents` sorts `timestamp: -1` and takes the newest
        // `limit`, so the window is the *newest* N in descending order. The insertion
        // order here is oldest-first, so the slice is reversed to match.
        const window = eventsLimit === 0 ? [] : all.slice(-eventsLimit).reverse();

        const reports = includeAssessments ? (assessments.get(id) ?? []) : [];

        return Response.json({
          success: true,
          session: sessions.get(id) ?? null,
          events: window,
          // `getRiskAssessments` sorts newest-first, and the registry's `assessmentsLimit`
          // exists so that a caller needing one field asks for one.
          riskAssessments:
            body.assessmentsLimit === undefined
              ? reports
              : reports.slice(0, Number(body.assessmentsLimit)),
        });
      }

      case "ingest_micro_events": {
        const batch = body.events ?? [];
        const acceptedEventIds = [];
        const duplicateEventIds = [];
        for (const event of batch) {
          const key = `${event.sessionId}::${event.eventId}`;
          if (storedEventKeys.has(key)) {
            duplicateEventIds.push(event.eventId);
            continue;
          }
          storedEventKeys.add(key);
          acceptedEventIds.push(event.eventId);
          const list = events.get(event.sessionId) ?? [];
          list.push(event);
          events.set(event.sessionId, list);
        }
        return Response.json({
          success: true,
          processedCount: batch.length,
          acceptedEventIds,
          duplicateEventIds,
        });
      }

      case "update_session_counts": {
        const id = String(body.sessionId);
        sessions.set(id, { ...(sessions.get(id) ?? {}), ...(body.counts ?? {}) });
        return Response.json({ success: true });
      }

      case "store_risk_assessment": {
        // Retained, because `includeAssessments` is a bound worth being able to observe:
        // a double that stores nothing makes `true` and `false` indistinguishable.
        const report = body.report ?? {};
        const id = String(report.sessionId ?? "");
        if (id) {
          const list = assessments.get(id) ?? [];
          list.unshift(report);
          assessments.set(id, list);
        }
        return Response.json({ success: true, mongoDocumentId: "risk-doc" });
      }

      case "set_session_status": {
        const id = String(body.sessionId);
        const existing = sessions.get(id);
        if (existing) sessions.set(id, { ...existing, status: body.status });
        return Response.json({ success: true, updated: true });
      }

      case "list_sessions":
        return Response.json({ success: true, data: [...sessions.values()] });

      case "list_reference_documents":
        return Response.json({ success: true, data: [] });

      case "health_check":
        return Response.json({ connected: true, healthy: true });

      default:
        return Response.json({ success: true });
    }
  };

  return {
    counts,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/**
 * A stub that accepts telemetry and retains nothing.
 *
 * Used for the memory case only. With the ordinary stub the double's own event log lives in
 * the same heap as the API, so a heap delta measures both and attributes the double's
 * growth to the application — the same class of mistake as the event-cap fidelity bug.
 * A store that keeps nothing isolates what Cerberus itself holds.
 */
export function installSinkStub() {
  const original = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    const target = typeof url === "string" ? url : url.url;
    if (target.includes("/chat/completions")) {
      return Response.json({});
    }

    const tool = target.split("/tools/")[1];
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (tool === "ingest_micro_events") {
      const batch = body.events ?? [];
      return Response.json({
        success: true,
        processedCount: batch.length,
        acceptedEventIds: batch.map((event) => event.eventId),
        duplicateEventIds: [],
      });
    }
    if (tool === "get_session_review") {
      return Response.json({ success: true, session: null, events: [], riskAssessments: [] });
    }
    return Response.json({ success: true });
  };

  return {
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
