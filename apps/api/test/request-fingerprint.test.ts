/**
 * The canonical request fingerprint.
 *
 * ── The two directions that matter ────────────────────────────────────
 *
 * A fingerprint is only useful if it is stable in one direction and discriminating in the
 * other:
 *
 *   - **Same logical request → same digest.** Otherwise a legitimate retry is reported as a
 *     conflict, and the mechanism refuses the very case it exists for.
 *   - **Different request → different digest.** Otherwise a key reused for another request
 *     silently replays the first one's result, which is a lie about which request ran.
 *
 * Both are asserted here, plus the properties that make the first one true: stable key
 * ordering, exclusion of transport metadata, and the use of the values the route actually
 * sends rather than the raw body.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  FINGERPRINT_VERSION,
  canonicalize,
  fingerprintAuditorRequest,
  fingerprintCanonical,
  fingerprintScenariosRequest,
  type CanonicalValue,
} from "../src/services/request-fingerprint.js";
import type { SeverityMix } from "../src/types.js";

const MIX: SeverityMix = { low: 0.25, medium: 0.35, high: 0.25, critical: 0.15 };

function scenarios(overrides: Partial<Parameters<typeof fingerprintScenariosRequest>[0]> = {}) {
  return fingerprintScenariosRequest({
    prompt: "author exfiltration scenarios for the trading desk",
    roleContext: "CISO",
    vectorCount: 5,
    severityMix: MIX,
    ...overrides,
  });
}

describe("canonicalize", () => {
  test("object key order does not change the output", () => {
    // The single most important property: a caller that reorders its JSON keys has sent the
    // same request, and must get the same digest.
    const one = canonicalize({ b: 2, a: 1, c: 3 } as CanonicalValue);
    const two = canonicalize({ c: 3, a: 1, b: 2 } as CanonicalValue);
    const three = canonicalize({ a: 1, b: 2, c: 3 } as CanonicalValue);

    assert.equal(one, two);
    assert.equal(one, three);
    assert.equal(one, '{"a":1,"b":2,"c":3}');
  });

  test("nested object key order does not change the output", () => {
    const one = canonicalize({ outer: { z: 1, a: 2 } } as CanonicalValue);
    const two = canonicalize({ outer: { a: 2, z: 1 } } as CanonicalValue);
    assert.equal(one, two);
  });

  test("array order IS significant", () => {
    // A canonicaliser cannot know which arrays are sets. Preserving order is the safe
    // default: it can never make two different inputs collide.
    assert.notEqual(
      canonicalize([1, 2, 3] as CanonicalValue),
      canonicalize([3, 2, 1] as CanonicalValue),
    );
  });

  test("undefined fields are omitted, so absent and explicitly undefined agree", () => {
    // Neither reaches the provider, so they are the same request.
    assert.equal(
      canonicalize({ a: 1, b: undefined } as CanonicalValue),
      canonicalize({ a: 1 } as CanonicalValue),
    );
    assert.equal(canonicalize({ a: 1, b: undefined } as CanonicalValue), '{"a":1}');
  });

  test("null is preserved, and is not the same as absent", () => {
    // `null` is a value the caller sent; absent is a value they did not.
    assert.notEqual(
      canonicalize({ a: 1, b: null } as CanonicalValue),
      canonicalize({ a: 1 } as CanonicalValue),
    );
  });

  test("strings are escaped, so a quote cannot merge two inputs", () => {
    assert.notEqual(
      canonicalize({ a: 'x","b":"y' } as CanonicalValue),
      canonicalize({ a: "x", b: "y" } as CanonicalValue),
    );
    assert.equal(canonicalize("a\"b" as CanonicalValue), '"a\\"b"');
  });

  test("a non-finite number is refused rather than serialised as null", () => {
    // Serialising it would make every unusable number fingerprint identically, which is a
    // silent collision rather than an error.
    assert.throws(() => canonicalize(Number.NaN as CanonicalValue), TypeError);
    assert.throws(() => canonicalize(Number.POSITIVE_INFINITY as CanonicalValue), TypeError);
  });

  test("number spellings that are the same value agree", () => {
    assert.equal(canonicalize(0 as CanonicalValue), canonicalize(-0 as CanonicalValue));
    assert.equal(canonicalize(5 as CanonicalValue), canonicalize(5.0 as CanonicalValue));
  });

  test("key ordering is by code unit, not by locale", () => {
    // `localeCompare` would order `"Z"` before `"a"` in some locales and after it in
    // others, so two replicas could disagree about the digest of one request.
    const upper = canonicalize({ Z: 1, a: 2 } as CanonicalValue);
    const lower = canonicalize({ a: 2, Z: 1 } as CanonicalValue);
    assert.equal(upper, lower);
    assert.equal(upper, '{"Z":1,"a":2}', "uppercase must sort before lowercase by code unit");
  });
});

describe("fingerprintScenariosRequest — same logical request", () => {
  test("reordered body fields produce the same fingerprint", () => {
    const one = scenarios();
    const two = scenarios({ severityMix: { critical: 0.15, high: 0.25, medium: 0.35, low: 0.25 } });
    assert.equal(one, two);
  });

  test("the builder is a pure function of the values it is given", () => {
    assert.equal(scenarios(), scenarios());
  });

  test("whitespace in the prompt value IS significant, in the fail-closed direction", () => {
    // The builder fingerprints the value it is handed, and the route hands it the *trimmed*
    // prompt — the same value it sends to the provider. So the equivalence between an
    // untrimmed and a trimmed body is a property of the route, and it is asserted through
    // the real route rather than here, because here it would be asserted against a
    // normalisation this function deliberately does not perform.
    //
    // Not performing it is the safe direction. If the builder trimmed and the route did
    // not, two genuinely different provider inputs would collide and the conflict case
    // would be missed — silently. If the builder does not trim and the route does, the
    // worst outcome is a false conflict: a legitimate retry is refused with a `409` rather
    // than replaying, which is loud and recoverable.
    assert.notEqual(
      scenarios({ prompt: "  author scenarios  " }),
      scenarios({ prompt: "author scenarios" }),
    );
  });

  test("a differently-scaled severity mix is different unless the route normalised it", () => {
    // Same reasoning: the route normalises to sum 1 before it builds the prompt, and hands
    // the normalised object to both the provider and this function. Given raw weights, the
    // builder reports them as different — again the fail-closed direction.
    const asPercent = { low: 25, medium: 35, high: 25, critical: 15 };
    const normalised: SeverityMix = { low: 0.25, medium: 0.35, high: 0.25, critical: 0.15 };

    assert.notEqual(scenarios({ severityMix: asPercent }), scenarios({ severityMix: normalised }));
    // And the normalised form is stable, which is what the route relies on.
    assert.equal(scenarios({ severityMix: normalised }), scenarios());
  });

  test("the fingerprint is a sha256 hex digest", () => {
    assert.match(scenarios(), /^[0-9a-f]{64}$/);
  });

  test("the fingerprint does not contain the prompt", () => {
    // A digest is what makes it safe to store; a digest that leaked its input would not be.
    const prompt = "author exfiltration scenarios for the trading desk";
    assert.ok(!scenarios().includes(prompt));
    assert.ok(!scenarios().includes("trading"));
  });
});

describe("fingerprintScenariosRequest — different request", () => {
  test("every semantic field changes the fingerprint", () => {
    const base = scenarios();
    const variations: Array<[string, Parameters<typeof fingerprintScenariosRequest>[0]]> = [
      ["prompt", { prompt: "a different prompt", roleContext: "CISO", vectorCount: 5, severityMix: MIX }],
      ["roleContext", { prompt: "author exfiltration scenarios for the trading desk", roleContext: "SOC", vectorCount: 5, severityMix: MIX }],
      ["vectorCount", { prompt: "author exfiltration scenarios for the trading desk", roleContext: "CISO", vectorCount: 6, severityMix: MIX }],
      ["severityMix", { prompt: "author exfiltration scenarios for the trading desk", roleContext: "CISO", vectorCount: 5, severityMix: { ...MIX, critical: 0.2, high: 0.2 } }],
    ];

    for (const [field, input] of variations) {
      assert.notEqual(
        fingerprintScenariosRequest(input),
        base,
        `changing '${field}' did not change the fingerprint, so a key reused with a ` +
          `different '${field}' would replay the first request's result`,
      );
    }
  });

  test("whitespace inside the prompt is significant", () => {
    // The route trims the ends, not the middle. `"a b"` and `"a  b"` are different provider
    // inputs and must be different requests.
    assert.notEqual(scenarios({ prompt: "a b" }), scenarios({ prompt: "a  b" }));
  });

  test("an empty roleContext is a different request from a non-empty one", () => {
    assert.notEqual(scenarios({ roleContext: "" }), scenarios({ roleContext: "CISO" }));
  });

  test("a shifted severity distribution differs", () => {
    assert.notEqual(
      scenarios({ severityMix: { low: 0.4, medium: 0.3, high: 0.2, critical: 0.1 } }),
      scenarios({ severityMix: { low: 0.1, medium: 0.2, high: 0.3, critical: 0.4 } }),
    );
  });
});

describe("fingerprintAuditorRequest", () => {
  test("is a sha256 hex digest", () => {
    assert.match(fingerprintAuditorRequest({ question: "who pasted the most?" }), /^[0-9a-f]{64}$/);
  });

  test("the same question is the same fingerprint", () => {
    assert.equal(
      fingerprintAuditorRequest({ question: "who pasted the most?" }),
      fingerprintAuditorRequest({ question: "who pasted the most?" }),
    );
  });

  test("a different question is a different fingerprint", () => {
    assert.notEqual(
      fingerprintAuditorRequest({ question: "who pasted the most?" }),
      fingerprintAuditorRequest({ question: "who pasted the least?" }),
    );
  });

  test("leading whitespace is significant, because the route does not trim it", () => {
    // The route validates `question.trim()` is non-empty but passes `body.question`
    // untrimmed to both paid calls, so these are two different provider inputs.
    assert.notEqual(
      fingerprintAuditorRequest({ question: " who pasted the most?" }),
      fingerprintAuditorRequest({ question: "who pasted the most?" }),
    );
  });

  test("a scenarios fingerprint and an auditor fingerprint cannot be confused", () => {
    // The two routes have separate key namespaces, so this is defence in depth rather than
    // the mechanism — but a digest that could be identical across routes would mean a
    // mis-scoped record lookup was undetectable.
    assert.notEqual(
      fingerprintAuditorRequest({ question: "x" }),
      scenarios({ prompt: "x", roleContext: "", vectorCount: 1, severityMix: MIX }),
    );
  });
});

describe("the fingerprint is versioned", () => {
  test("the version is hashed into the digest", () => {
    // A future canonicalisation change must be a new version, not a silent reinterpretation
    // of records written under the old one. Hashing the version in makes the two digests
    // unequal by construction.
    const withoutVersion = fingerprintCanonical(
      canonicalize({ question: "same question" }),
    );
    const withVersion = fingerprintCanonical(
      canonicalize({ v: FINGERPRINT_VERSION, question: "same question" }),
    );

    assert.notEqual(withoutVersion, withVersion);
    assert.equal(fingerprintAuditorRequest({ question: "same question" }), withVersion);
  });

  test("the current version is 1", () => {
    assert.equal(FINGERPRINT_VERSION, 1);
  });
});

describe("canonical form is deterministic across processes", () => {
  test("the same input produces a byte-identical canonical string", () => {
    // The digest is a function of these bytes, so this is the property a second replica
    // depends on. Asserted on the serialisation rather than the digest, so a failure names
    // the serialiser instead of merely reporting two unequal hex strings.
    const input = {
      v: FINGERPRINT_VERSION,
      prompt: "p",
      roleContext: "r",
      vectorCount: 5,
      severityMix: { low: 0.25, medium: 0.35, high: 0.25, critical: 0.15 },
    } as CanonicalValue;

    assert.equal(canonicalize(input), canonicalize(input));
    assert.equal(
      canonicalize(input),
      '{"prompt":"p","roleContext":"r","severityMix":{"critical":0.15,"high":0.25,"low":0.25,"medium":0.35},"v":1,"vectorCount":5}',
    );
  });
});
