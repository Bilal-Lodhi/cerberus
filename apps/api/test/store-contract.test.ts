/**
 * The store contract, run against two implementations.
 *
 * ── Why this file exists ──────────────────────────────────────────────
 *
 * `docs/development/test-double-contract.md` records the pattern behind four real
 * defects in this repository: a double that did not match the real store, and a
 * suite that passed anyway. There were four independent reimplementations of the
 * store interface and nothing asserted that any of them agreed with `MongoStore`.
 *
 * This suite closes that structurally. Every assertion below is written once and
 * run twice:
 *
 *   1. against the shared in-memory double (`support/mcp-store-double.ts`), always;
 *   2. against a **real `MongoStore`**, when `CERBERUS_TEST_MONGODB_URI` is set.
 *
 * A double that cannot satisfy the contract is not a double worth trusting, and a
 * contract that is only ever checked against a fake is a contract that describes
 * the fake. Running the same code against both is the only way to know which.
 *
 * ── Running the real-store half ───────────────────────────────────────
 *
 *   CERBERUS_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm test
 *
 * Each case gets its own database, so `listSessions()` assertions are exact and no
 * case can see another's documents. The database is dropped afterwards. When the
 * variable is unset the real half is **skipped with a stated reason** rather than
 * silently passing — an unverified contract must not look verified.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { MongoClient } from "mongodb";

import {
  MongoStore,
  type SessionCountsUpdate,
} from "../../../packages/mcp-mongodb/src/mongo-client.js";
import { McpStoreDouble, type StoredDocument } from "./support/mcp-store-double.js";

/**
 * The surface every contract case is written against.
 *
 * Both `McpStoreDouble` and `MongoStore` satisfy it structurally. Declaring it
 * explicitly is what makes "the same assertions run against both" checkable by the
 * compiler rather than by reading the file.
 */
export interface ContractStore {
  createSession(session: StoredDocument): Promise<string>;
  getSession(sessionId: string): Promise<StoredDocument | null>;
  updateSession(sessionId: string, update: StoredDocument): Promise<void>;
  deleteSession(sessionId: string): Promise<boolean>;
  listSessions(): Promise<StoredDocument[]>;
  updateSessionCounts(sessionId: string, counts: SessionCountsUpdate): Promise<void>;
  setSessionStatus(sessionId: string, status: string): Promise<boolean>;
  ingestMicroEvents(
    events: StoredDocument[],
  ): Promise<{ acceptedEventIds: string[]; duplicateEventIds: string[] }>;
  getSessionEvents(
    sessionId: string,
    options?: { limit?: number; eventType?: string },
  ): Promise<StoredDocument[]>;
  countEventType(sessionId: string, eventType: string): Promise<number>;
  storeRiskAssessment(report: StoredDocument): Promise<string>;
  getRiskAssessments(sessionId: string): Promise<StoredDocument[]>;
  getEmployeeRiskHistory(employeeId: string): Promise<StoredDocument[]>;
  storeReferenceDocument(document: StoredDocument): Promise<string>;
  listReferenceDocuments(limit: number): Promise<StoredDocument[]>;
  deleteReferenceDocument(referenceId: string): Promise<boolean>;
  ping(): Promise<boolean>;
  isConnected(): boolean;
}

/** One named contract assertion. */
interface ContractCase {
  name: string;
  run(store: ContractStore, ids: CaseIds): Promise<void>;
}

/**
 * Unique identifiers for one case.
 *
 * A case must never depend on a fixed id: against a real database the cases share
 * a server, and against the double they share a process.
 */
interface CaseIds {
  sessionId: string;
  employeeId: string;
  auditId: string;
  referenceId: string;
}

function freshIds(): CaseIds {
  const tag = randomUUID();
  return {
    sessionId: `ses-${tag}`,
    employeeId: `emp-${tag}`,
    auditId: `audit-${tag}`,
    referenceId: `ref-${tag}`,
  };
}

/** A minimal valid micro-event. */
function microEvent(
  sessionId: string,
  eventId: string,
  overrides: StoredDocument = {},
): StoredDocument {
  return {
    eventId,
    sessionId,
    employeeId: "op-contract",
    auditId: "audit-contract",
    vectorId: "tv-1",
    eventType: "KEYSTROKE",
    timestamp: new Date().toISOString(),
    payload: { deltaMs: 120 },
    clientMetadata: { userAgent: "contract", platform: "web" },
    ...overrides,
  };
}

/** A minimal valid risk assessment. */
function riskReport(
  sessionId: string,
  options: { riskAssessmentId?: string; generatedAt: string; score: number; employeeId?: string },
): StoredDocument {
  return {
    riskAssessmentId: options.riskAssessmentId ?? randomUUID(),
    sessionId,
    employeeId: options.employeeId ?? "op-contract",
    auditId: "audit-contract",
    overallRiskScore: options.score,
    dimensionScores: { dataExfiltration: options.score },
    flags: [],
    exfiltrationReport: null,
    behavioralAnomalies: [],
    generatedAt: options.generatedAt,
  };
}

// ═══════════════════════════════════════════════════════════════════
// The contract
// ═══════════════════════════════════════════════════════════════════

export const CONTRACT_CASES: ContractCase[] = [
  // ── Session creation ─────────────────────────────────────────────
  {
    name: "createSession is $setOnInsert: a second call cannot overwrite the document",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: "someone-else",
        auditId: "another-audit",
        targetSystem: "OVERWRITTEN",
      });

      const session = await store.getSession(ids.sessionId);
      assert.ok(session, "the session was not created");
      assert.equal(
        session["employeeId"],
        ids.employeeId,
        "$setOnInsert let a second create overwrite the document",
      );
      assert.equal(session["targetSystem"], undefined);
    },
  },
  {
    name: "createSession defaults the status to active",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      const session = await store.getSession(ids.sessionId);
      assert.equal(session?.["status"], "active");
    },
  },
  {
    name: "createSession writes createdAt and updatedAt",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      const session = await store.getSession(ids.sessionId);
      assert.ok(session?.["createdAt"] instanceof Date, "createdAt is not a Date");
      assert.ok(session?.["updatedAt"] instanceof Date, "updatedAt is not a Date");
    },
  },

  {
    name: "createSession owns the timestamps: a caller-supplied createdAt is ignored",
    async run(store, ids) {
      // The real `$setOnInsert` spreads the caller's fields and then writes
      // `createdAt`/`updatedAt` after them, so the server clock wins. A double that
      // let the caller set them would let a test assert an ordering the database
      // cannot produce.
      const before = Date.now();
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
        createdAt: new Date("1999-01-01T00:00:00.000Z"),
      });

      const session = await store.getSession(ids.sessionId);
      assert.ok(
        (session?.["createdAt"] as Date).getTime() >= before,
        "createSession honoured a caller-supplied createdAt",
      );
    },
  },

  // ── Counter updates ──────────────────────────────────────────────
  {
    name: "updateSessionCounts applies $max and refuses a counter regression",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      await store.updateSessionCounts(ids.sessionId, { eventCount: 40, pasteCount: 20 });
      await store.updateSessionCounts(ids.sessionId, { eventCount: 1, pasteCount: 1 });

      const session = await store.getSession(ids.sessionId);
      assert.equal(
        session?.["eventCount"],
        40,
        "a lower eventCount overwrote a durable total — $max is not being applied",
      );
      assert.equal(session?.["pasteCount"], 20);
    },
  },
  {
    name: "updateSessionCounts sets a counter that is absent",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      await store.updateSessionCounts(ids.sessionId, {
        eventCount: 3,
        fullscreenExitCount: 7,
      });
      const session = await store.getSession(ids.sessionId);
      assert.equal(session?.["fullscreenExitCount"], 7);
    },
  },
  {
    name: "updateSessionCounts writes updatedAt",
    async run(store, ids) {
      const before = Date.now();
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      await store.updateSessionCounts(ids.sessionId, { eventCount: 1 });
      const session = await store.getSession(ids.sessionId);
      const updatedAt = session?.["updatedAt"];
      assert.ok(updatedAt instanceof Date, "updatedAt is not a Date");
      assert.ok(
        (updatedAt as Date).getTime() >= before,
        "updatedAt was not advanced by the counter write",
      );
    },
  },
  {
    name: "updateSessionCounts does not write status when it is omitted",
    async run(store, ids) {
      // This was a live defect: the whole counts object was spread into `$set`, and
      // the driver serialises `undefined` as BSON null, so a counter update with no
      // status clobbered the stored status to null.
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      await store.setSessionStatus(ids.sessionId, "locked");
      await store.updateSessionCounts(ids.sessionId, { eventCount: 5 });

      const session = await store.getSession(ids.sessionId);
      assert.equal(
        session?.["status"],
        "locked",
        "a counter update with no status clobbered the stored status",
      );
    },
  },
  {
    name: "updateSessionCounts writes status when it is supplied",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      await store.updateSessionCounts(ids.sessionId, {
        eventCount: 1,
        status: "locked",
      });
      const session = await store.getSession(ids.sessionId);
      assert.equal(session?.["status"], "locked");
    },
  },
  {
    name: "updateSessionCounts on an unknown session is a silent no-op, not an upsert",
    async run(store, ids) {
      await store.updateSessionCounts("does-not-exist-" + ids.sessionId, {
        eventCount: 9,
      });
      const session = await store.getSession("does-not-exist-" + ids.sessionId);
      assert.equal(session, null, "a counter update created a session document");
    },
  },

  // ── Status ───────────────────────────────────────────────────────
  {
    name: "setSessionStatus persists the status and reports whether a document matched",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });

      const matched = await store.setSessionStatus(ids.sessionId, "locked");
      assert.equal(matched, true, "setSessionStatus did not report a match");

      const session = await store.getSession(ids.sessionId);
      assert.equal(
        session?.["status"],
        "locked",
        "setSessionStatus reported success without persisting the status",
      );

      const unmatched = await store.setSessionStatus("no-such-session-" + ids.sessionId, "locked");
      assert.equal(
        unmatched,
        false,
        "setSessionStatus reported a match for a session that does not exist",
      );
    },
  },
  {
    name: "setSessionStatus advances updatedAt",
    async run(store, ids) {
      const before = Date.now();
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      await store.setSessionStatus(ids.sessionId, "terminated");
      const session = await store.getSession(ids.sessionId);
      const updatedAt = session?.["updatedAt"];
      assert.ok(updatedAt instanceof Date);
      assert.ok((updatedAt as Date).getTime() >= before);
    },
  },

  // ── Event identity ───────────────────────────────────────────────
  {
    name: "ingestMicroEvents reports which events were new and which were duplicates",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      const batch = [
        microEvent(ids.sessionId, "e1"),
        microEvent(ids.sessionId, "e2", { payload: { deltaMs: 200 } }),
      ];

      const first = await store.ingestMicroEvents(batch);
      assert.deepEqual(first.acceptedEventIds.sort(), ["e1", "e2"]);
      assert.deepEqual(first.duplicateEventIds, []);

      const second = await store.ingestMicroEvents(batch);
      assert.deepEqual(second.acceptedEventIds, []);
      assert.deepEqual(second.duplicateEventIds.sort(), ["e1", "e2"]);
    },
  },
  {
    name: "ingestMicroEvents stores exactly one document per (sessionId, eventId)",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      const batch = [microEvent(ids.sessionId, "e1"), microEvent(ids.sessionId, "e2")];
      await store.ingestMicroEvents(batch);
      await store.ingestMicroEvents(batch);

      const stored = await store.getSessionEvents(ids.sessionId);
      assert.equal(stored.length, 2, "a retried batch was stored more than once");
    },
  },
  {
    name: "ingestMicroEvents treats a duplicate inside one batch as a duplicate",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      const result = await store.ingestMicroEvents([
        microEvent(ids.sessionId, "same"),
        microEvent(ids.sessionId, "same", { payload: { deltaMs: 999 } }),
      ]);

      assert.deepEqual(result.acceptedEventIds, ["same"]);
      assert.deepEqual(result.duplicateEventIds, ["same"]);
      assert.equal((await store.getSessionEvents(ids.sessionId)).length, 1);
    },
  },
  {
    name: "event identity is scoped to the session, not global",
    async run(store, ids) {
      const other = ids.sessionId + "-other";
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      await store.createSession({
        sessionId: other,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });

      const first = await store.ingestMicroEvents([microEvent(ids.sessionId, "shared-id")]);
      const second = await store.ingestMicroEvents([microEvent(other, "shared-id")]);

      assert.deepEqual(first.acceptedEventIds, ["shared-id"]);
      assert.deepEqual(
        second.acceptedEventIds,
        ["shared-id"],
        "the same eventId in a different session was treated as a duplicate",
      );
    },
  },

  // ── Event reads ──────────────────────────────────────────────────
  {
    name: "getSessionEvents returns newest first by timestamp",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      await store.ingestMicroEvents([
        microEvent(ids.sessionId, "old", { timestamp: "2026-01-01T00:00:00.000Z" }),
        microEvent(ids.sessionId, "new", { timestamp: "2026-03-01T00:00:00.000Z" }),
        microEvent(ids.sessionId, "mid", { timestamp: "2026-02-01T00:00:00.000Z" }),
      ]);

      const stored = await store.getSessionEvents(ids.sessionId);
      assert.deepEqual(
        stored.map((event) => event["eventId"]),
        ["new", "mid", "old"],
      );
    },
  },
  {
    name: "getSessionEvents caps at 500 by default, keeping the newest",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });

      const batch = Array.from({ length: 600 }, (_unused, index) =>
        microEvent(ids.sessionId, `e-${String(index).padStart(4, "0")}`, {
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        }),
      );
      await store.ingestMicroEvents(batch);

      const stored = await store.getSessionEvents(ids.sessionId);
      assert.equal(stored.length, 500, "the default read limit is not 500");
      assert.equal(
        stored[0]["eventId"],
        "e-0599",
        "the capped read did not return the newest events",
      );
      assert.ok(
        !stored.some((event) => event["eventId"] === "e-0000"),
        "the capped read returned an event beyond the limit",
      );
    },
  },
  {
    name: "getSessionEvents honours an explicit limit and an eventType filter",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      await store.ingestMicroEvents([
        microEvent(ids.sessionId, "k1", { eventType: "KEYSTROKE" }),
        microEvent(ids.sessionId, "p1", { eventType: "PASTE" }),
        microEvent(ids.sessionId, "k2", { eventType: "KEYSTROKE" }),
      ]);

      assert.equal((await store.getSessionEvents(ids.sessionId, { limit: 2 })).length, 2);

      const pastes = await store.getSessionEvents(ids.sessionId, { eventType: "PASTE" });
      assert.equal(pastes.length, 1);
      assert.equal(pastes[0]["eventId"], "p1");

      assert.equal(await store.countEventType(ids.sessionId, "KEYSTROKE"), 2);
    },
  },
  {
    name: "getSessionEvents for an unknown session is empty, not an error",
    async run(store, ids) {
      assert.deepEqual(await store.getSessionEvents("no-such-" + ids.sessionId), []);
    },
  },

  // ── Risk assessments ─────────────────────────────────────────────
  {
    name: "getRiskAssessments returns newest first by generatedAt",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      await store.storeRiskAssessment(
        riskReport(ids.sessionId, { generatedAt: "2026-01-01T00:00:00.000Z", score: 10 }),
      );
      await store.storeRiskAssessment(
        riskReport(ids.sessionId, { generatedAt: "2026-03-01T00:00:00.000Z", score: 88 }),
      );
      await store.storeRiskAssessment(
        riskReport(ids.sessionId, { generatedAt: "2026-02-01T00:00:00.000Z", score: 40 }),
      );

      const reports = await store.getRiskAssessments(ids.sessionId);
      assert.deepEqual(
        reports.map((report) => report["overallRiskScore"]),
        [88, 40, 10],
        "risk assessments are not returned newest-first",
      );
    },
  },
  {
    name: "storeRiskAssessment is not idempotent on riskAssessmentId (known gap)",
    async run(store, ids) {
      // This characterises a defect rather than endorsing it. There is no unique
      // index on `riskAssessmentId`, so a re-analysis after a restart writes a
      // second row for one incident. Recorded in
      // `docs/development/failure-semantics.md` §3.9. When durable assessment
      // identity is implemented this assertion inverts — deliberately, so the fix
      // cannot land silently.
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      const fixedId = randomUUID();
      const report = riskReport(ids.sessionId, {
        riskAssessmentId: fixedId,
        generatedAt: "2026-01-01T00:00:00.000Z",
        score: 50,
      });

      await store.storeRiskAssessment(report);
      await store.storeRiskAssessment(report);

      const reports = await store.getRiskAssessments(ids.sessionId);
      assert.equal(
        reports.length,
        2,
        "assessment identity is now durable — update this characterisation and §3.9",
      );
    },
  },
  {
    name: "getEmployeeRiskHistory filters by employee and returns newest first",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      await store.storeRiskAssessment(
        riskReport(ids.sessionId, {
          generatedAt: "2026-01-01T00:00:00.000Z",
          score: 10,
          employeeId: ids.employeeId,
        }),
      );
      await store.storeRiskAssessment(
        riskReport(ids.sessionId, {
          generatedAt: "2026-02-01T00:00:00.000Z",
          score: 70,
          employeeId: ids.employeeId,
        }),
      );
      await store.storeRiskAssessment(
        riskReport(ids.sessionId, {
          generatedAt: "2026-03-01T00:00:00.000Z",
          score: 99,
          employeeId: "someone-else-" + ids.employeeId,
        }),
      );

      const history = await store.getEmployeeRiskHistory(ids.employeeId);
      assert.deepEqual(
        history.map((report) => report["overallRiskScore"]),
        [70, 10],
      );
    },
  },

  // ── Session listing ──────────────────────────────────────────────
  {
    name: "listSessions returns newest first by createdAt",
    async run(store, ids) {
      const older = ids.sessionId + "-old";
      const newer = ids.sessionId + "-new";
      await store.createSession({
        sessionId: older,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      await store.createSession({
        sessionId: newer,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });

      // `createSession` stamps the server clock, so `createdAt` cannot be chosen at
      // creation. It is set through `updateSession`, which both implementations
      // support, so this case stays store-agnostic.
      await store.updateSession(older, { createdAt: new Date("2026-01-01T00:00:00.000Z") });
      await store.updateSession(newer, { createdAt: new Date("2026-03-01T00:00:00.000Z") });

      // Filtered to this case's own documents: against a real database the suite
      // shares one, and a case must not depend on being the only one in it.
      const listed = (await store.listSessions()).filter((entry) =>
        String(entry["sessionId"]).startsWith(ids.sessionId),
      );
      assert.deepEqual(
        listed.map((entry) => entry["sessionId"]),
        [newer, older],
      );
    },
  },
  {
    name: "listSessions applies its projection and omits fields it does not select",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
        terminalContent: "NOT PROJECTED",
      });
      await store.updateSession(ids.sessionId, { terminalContent: "NOT PROJECTED" });

      const entry = (await store.listSessions()).find(
        (candidate) => candidate["sessionId"] === ids.sessionId,
      );
      assert.ok(entry, "the session was not listed");
      assert.equal(
        entry["terminalContent"],
        undefined,
        "listSessions returned a field outside its projection",
      );
      assert.equal(entry["_id"], undefined, "listSessions returned the storage _id");
      assert.equal(entry["sessionId"], ids.sessionId);
    },
  },

  // ── updateSession / terminal content ─────────────────────────────
  {
    name: "updateSession writes terminalContent and advances updatedAt",
    async run(store, ids) {
      const before = Date.now();
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      await store.updateSession(ids.sessionId, { terminalContent: "WORKSPACE" });

      const session = await store.getSession(ids.sessionId);
      assert.equal(session?.["terminalContent"], "WORKSPACE");
      assert.ok((session?.["updatedAt"] as Date).getTime() >= before);
    },
  },
  {
    name: "updateSession on an unknown session is silent and creates nothing",
    async run(store, ids) {
      const unknown = "no-such-" + ids.sessionId;
      await store.updateSession(unknown, { terminalContent: "GHOST" });
      assert.equal(await store.getSession(unknown), null);
    },
  },
  {
    name: "updateSession does not clear fields it was not given",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      await store.updateSession(ids.sessionId, { terminalContent: "A" });
      await store.updateSession(ids.sessionId, { terminalContent: "B" });

      const session = await store.getSession(ids.sessionId);
      assert.equal(session?.["terminalContent"], "B");
      assert.equal(session?.["employeeId"], ids.employeeId, "an update cleared a field");
    },
  },

  // ── Deletion ─────────────────────────────────────────────────────
  {
    name: "deleteSession cascades to events and assessments, and reports the session",
    async run(store, ids) {
      await store.createSession({
        sessionId: ids.sessionId,
        employeeId: ids.employeeId,
        auditId: ids.auditId,
      });
      await store.ingestMicroEvents([microEvent(ids.sessionId, "e1")]);
      await store.storeRiskAssessment(
        riskReport(ids.sessionId, { generatedAt: "2026-01-01T00:00:00.000Z", score: 50 }),
      );

      assert.equal(await store.deleteSession(ids.sessionId), true);
      assert.equal(await store.getSession(ids.sessionId), null);
      assert.deepEqual(await store.getSessionEvents(ids.sessionId), []);
      assert.deepEqual(await store.getRiskAssessments(ids.sessionId), []);
    },
  },
  {
    name: "deleteSession reports false for a session that does not exist",
    async run(store, ids) {
      assert.equal(await store.deleteSession("no-such-" + ids.sessionId), false);
    },
  },

  // ── Reference corpus ─────────────────────────────────────────────
  {
    name: "storeReferenceDocument upserts on referenceId and preserves createdAt",
    async run(store, ids) {
      await store.storeReferenceDocument({
        referenceId: ids.referenceId,
        label: "first",
        content: "ORIGINAL CONTENT",
        tags: ["a"],
      });
      const first = (await store.listReferenceDocuments(200)).find(
        (document) => document["referenceId"] === ids.referenceId,
      );
      const createdAt = first?.["createdAt"];

      await store.storeReferenceDocument({
        referenceId: ids.referenceId,
        label: "second",
        content: "UPDATED CONTENT",
        tags: ["b"],
      });

      const all = await store.listReferenceDocuments(200);
      const matching = all.filter(
        (document) => document["referenceId"] === ids.referenceId,
      );
      assert.equal(matching.length, 1, "an upsert created a duplicate document");
      assert.equal(matching[0]["content"], "UPDATED CONTENT");
      assert.equal(matching[0]["label"], "second");
      assert.ok(
        (matching[0]["createdAt"] as Date).getTime() === (createdAt as Date).getTime(),
        "an upsert reset createdAt",
      );
    },
  },
  {
    name: "listReferenceDocuments is newest first by updatedAt and honours the limit",
    async run(store, ids) {
      for (const [index, suffix] of ["a", "b", "c"].entries()) {
        await store.storeReferenceDocument({
          referenceId: `${ids.referenceId}-${suffix}`,
          label: suffix,
          content: `content ${index}`,
          tags: [],
        });
        // Distinct updatedAt values, since the writes may share a millisecond.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const all = await store.listReferenceDocuments(200);
      const mine = all.filter((document) =>
        String(document["referenceId"]).startsWith(ids.referenceId),
      );
      assert.deepEqual(
        mine.map((document) => document["referenceId"]),
        [`${ids.referenceId}-c`, `${ids.referenceId}-b`, `${ids.referenceId}-a`],
      );
      assert.equal((await store.listReferenceDocuments(1)).length, 1);
    },
  },
  {
    name: "listReferenceDocuments applies its projection",
    async run(store, ids) {
      await store.storeReferenceDocument({
        referenceId: ids.referenceId,
        label: "projected",
        content: "CONTENT",
        tags: [],
        internalNote: "NOT PROJECTED",
      });
      const document = (await store.listReferenceDocuments(200)).find(
        (entry) => entry["referenceId"] === ids.referenceId,
      );
      assert.ok(document);
      assert.equal(document["internalNote"], undefined);
      assert.equal(document["_id"], undefined);
    },
  },
  {
    name: "deleteReferenceDocument reports whether it removed a document",
    async run(store, ids) {
      await store.storeReferenceDocument({
        referenceId: ids.referenceId,
        label: "doomed",
        content: "CONTENT",
        tags: [],
      });
      assert.equal(await store.deleteReferenceDocument(ids.referenceId), true);
      assert.equal(await store.deleteReferenceDocument(ids.referenceId), false);
    },
  },

  // ── Connectivity ─────────────────────────────────────────────────
  {
    name: "ping and isConnected report the connection",
    async run(store) {
      assert.equal(store.isConnected(), true);
      assert.equal(await store.ping(), true);
    },
  },
];

// ═══════════════════════════════════════════════════════════════════
// Fidelity guard: the double must still look like the real store
// ═══════════════════════════════════════════════════════════════════

describe("store double fidelity", () => {
  /**
   * Every store method the MCP tool registry calls.
   *
   * This is the surface that matters: the registry is the only consumer of the
   * store, and `McpStoreDouble` is cast to `MongoStore` at the registry call site,
   * so a missing method would surface only when a route happened to call it. Listing
   * the surface explicitly — rather than reflecting over `MongoStore.prototype`,
   * which also carries lifecycle and private helpers the registry never touches —
   * makes an omission loud, immediate and meaningful.
   */
  const REQUIRED_STORE_METHODS = [
    "storeThreatScenario",
    "getThreatScenario",
    "createSession",
    "getSession",
    "updateSession",
    "deleteSession",
    "listSessions",
    "updateSessionCounts",
    "setSessionStatus",
    "ingestMicroEvents",
    "getSessionEvents",
    "countEventType",
    "storeRiskAssessment",
    "getRiskAssessments",
    "getEmployeeRiskHistory",
    "storeReferenceDocument",
    "listReferenceDocuments",
    "deleteReferenceDocument",
    "ping",
    "isConnected",
  ] as const;

  test("every method the tool registry calls exists on the real store", () => {
    const missing = REQUIRED_STORE_METHODS.filter(
      (name) => typeof (MongoStore.prototype as unknown as Record<string, unknown>)[name] !== "function",
    );
    assert.deepEqual(
      missing,
      [],
      `MongoStore no longer implements: ${missing.join(", ")} — update this list and the double`,
    );
  });

  test("the double implements every method the tool registry calls", () => {
    const double = new McpStoreDouble() as unknown as Record<string, unknown>;
    const missing = REQUIRED_STORE_METHODS.filter(
      (name) => typeof double[name] !== "function",
    );
    assert.deepEqual(
      missing,
      [],
      `the double does not implement: ${missing.join(", ")}`,
    );
  });

  test("the double satisfies the ContractStore surface", () => {
    // A compile-time check expressed at runtime: if a method were renamed, this
    // assignment would fail to typecheck. Kept as a test so the intent is visible.
    const store: ContractStore = new McpStoreDouble();
    assert.equal(typeof store.setSessionStatus, "function");
  });

  test("an unknown tool is rejected, not answered with a plausible success", async () => {
    // The doubles this replaces fell through to `{success: true}` for any tool they
    // did not model, which made an unmodelled call invisible. The real adapter
    // answers 404.
    const double = new McpStoreDouble();
    const response = await double.responder()("not_a_real_tool", {});
    assert.equal(response.status, 404);
    const body = (await response.json()) as { success: boolean };
    assert.equal(body.success, false);
  });

  test("an invalid tool argument is rejected with 400, as the adapter does", async () => {
    const double = new McpStoreDouble();
    // `set_session_status` validates its status against SESSION_STATUSES.
    const response = await double.responder()("set_session_status", {
      sessionId: "s",
      status: "not-a-status",
    });
    assert.equal(response.status, 400);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Run 1 — the in-memory double
// ═══════════════════════════════════════════════════════════════════

describe("store contract — in-memory double", () => {
  for (const contractCase of CONTRACT_CASES) {
    test(contractCase.name, async () => {
      await contractCase.run(new McpStoreDouble(), freshIds());
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Run 2 — a real MongoDB, when one is offered
// ═══════════════════════════════════════════════════════════════════

const REAL_MONGODB_URI = process.env["CERBERUS_TEST_MONGODB_URI"]?.trim() ?? "";

if (REAL_MONGODB_URI) {
  describe("store contract — real MongoDB", () => {
    /**
     * One disposable database for the whole run.
     *
     * Cases are isolated by unique identifiers rather than by database, so a real
     * server is connected to once. It is dropped afterwards: a contract run must
     * not accumulate databases, and the next run must not inherit state.
     */
    const databaseName = `cerberus_contract_${randomUUID().replace(/-/g, "")}`;
    let store: MongoStore;

    before(async () => {
      store = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });
      await store.connect();
    });

    after(async () => {
      await store.disconnect();
      const client = new MongoClient(REAL_MONGODB_URI);
      try {
        await client.connect();
        await client.db(databaseName).dropDatabase();
      } finally {
        await client.close();
      }
    });

    for (const contractCase of CONTRACT_CASES) {
      test(contractCase.name, async () => {
        await contractCase.run(store as unknown as ContractStore, freshIds());
      });
    }
  });
} else {
  describe("store contract — real MongoDB", () => {
    test("skipped: CERBERUS_TEST_MONGODB_URI is not set", { skip: true }, () => {
      // An unverified contract must not look verified. Run
      //   CERBERUS_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm test
      // to execute the same cases against a real store.
    });
  });
}
