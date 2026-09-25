/**
 * Provider-boundary hardening.
 *
 * Two things were classified or parsed by guesswork: retry fatality was decided
 * by searching the error message for digits, and the auditor's pipeline was read
 * with a raw `JSON.parse` that discarded any output the model wrapped in a fence
 * or a sentence.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { APIError } from "openai";

import { getAIProvider, isFatal, resetAIProvider } from "../src/ai/provider.js";
import { installFetchStub, makeConfig, type FetchStub } from "./helpers.js";

/** Builds an SDK-shaped `APIError`, as the OpenAI client throws. */
function apiError(status: number | undefined, code?: string, message = "request failed") {
  return new APIError(
    status,
    code === undefined ? undefined : { code },
    message,
    undefined,
  );
}

describe("isFatal", () => {
  test("treats 401 and 403 as fatal", () => {
    assert.equal(isFatal(apiError(401)), true);
    assert.equal(isFatal(apiError(403)), true);
  });

  test("does not treat a retryable status as fatal", () => {
    for (const status of [400, 404, 408, 409, 422, 429, 500, 502, 503, 504, undefined]) {
      assert.equal(isFatal(apiError(status)), false, `status=${status} was treated as fatal`);
    }
  });

  test("treats the quota and key codes as fatal", () => {
    assert.equal(isFatal(apiError(400, "invalid_api_key")), true);
    assert.equal(isFatal(apiError(429, "insufficient_quota")), true);
  });

  test("does not treat an unrelated code as fatal", () => {
    assert.equal(isFatal(apiError(400, "context_length_exceeded")), false);
    assert.equal(isFatal(apiError(429, "rate_limit_exceeded")), false);
  });

  test("ignores a plain error whose message merely contains 401 or 403", () => {
    // The regression: substring matching classified all of these as
    // authentication failures and skipped the retry budget entirely.
    assert.equal(isFatal(new Error("max_tokens 4012 exceeds the model limit")), false);
    assert.equal(isFatal(new Error("request 403abc-123 failed")), false);
    assert.equal(
      isFatal(new Error("POST https://api.openai.com/v1/chat/completions returned 403")),
      false,
    );
  });

  test("ignores values that are not errors at all", () => {
    assert.equal(isFatal("401"), false);
    assert.equal(isFatal(403), false);
    assert.equal(isFatal(undefined), false);
    assert.equal(isFatal(null), false);
  });
});

describe("toMongoPipeline recovery", () => {
  let stub: FetchStub;

  beforeEach(() => {
    resetAIProvider();
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  async function pipelineFor(aiResponse: string): Promise<unknown> {
    stub = installFetchStub({ aiResponse });
    return getAIProvider(makeConfig()).toMongoPipeline("which sessions scored highest?");
  }

  test("reads a plain JSON pipeline", async () => {
    assert.deepEqual(await pipelineFor(JSON.stringify({ pipeline: [{ $limit: 5 }] })), [
      { $limit: 5 },
    ]);
  });

  test("recovers a fenced pipeline", async () => {
    assert.deepEqual(
      await pipelineFor('```json\n{"pipeline":[{"$sort":{"overallRiskScore":-1}}]}\n```'),
      [{ $sort: { overallRiskScore: -1 } }],
    );
  });

  test("recovers a pipeline wrapped in prose", async () => {
    assert.deepEqual(await pipelineFor('Here you go: {"pipeline":[{"$limit":1}]} — done'), [
      { $limit: 1 },
    ]);
  });

  test("recovers a pipeline with a trailing comma", async () => {
    assert.deepEqual(await pipelineFor('{"pipeline":[{"$limit":2},],}'), [{ $limit: 2 }]);
  });

  test("returns an empty array for unrecoverable output", async () => {
    assert.deepEqual(await pipelineFor("I cannot answer that."), []);
  });

  test("passes through an absent pipeline key rather than inventing one", async () => {
    // `applySafePipeline` ignores a non-array, so this degrades to "match
    // everything" — bounded by the auditor's own result ceiling.
    assert.equal(await pipelineFor(JSON.stringify({ stages: [] })), undefined);
  });
});
