/**
 * The private-package guard, checked against fixture trees.
 *
 * ── Why this is a test and not a shell invocation ─────────────────────
 *
 * `scripts/release/private-packages.mjs` is a guard whose whole value is that it fails.
 * A guard verified only by running it against a tree that already passes proves that it
 * can say "OK" — not that it can say "no". The four ways it is supposed to refuse are
 * therefore each driven over a fixture workspace here, because a rule that has never been
 * observed failing is a rule nobody knows is wired up.
 *
 * The real tree is asserted too: `packages/mcp-mongodb` shipped without `"private": true`
 * through four releases, and this is what would have caught it.
 *
 * Pure filesystem work — no database, no Docker, no network — so it runs in the fast unit
 * job as well as the release harness.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditWorkspacePackages,
  expandWorkspaceEntry,
} from "../../../../scripts/release/private-packages.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "..", "..", "..", "..");

/** Writes a manifest, creating its directory. */
function writeManifest(root: string, relativeDir: string, manifest: unknown): void {
  const dir = join(root, relativeDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
}

interface FixtureSpec {
  workspaces: string[];
  packages: Record<string, unknown>;
  rootPrivate?: boolean;
}

/**
 * Builds a disposable workspace tree.
 *
 * `packages` maps a directory to a manifest; the root manifest is written for the caller
 * with the given `workspaces` entries.
 */
function fixture({ workspaces, packages, rootPrivate = true }: FixtureSpec): string {
  const root = mkdtempSync(join(tmpdir(), "cerberus-private-packages-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      { name: "fixture-root", version: "0.0.0", private: rootPrivate, workspaces },
      null,
      2,
    ),
  );
  for (const [relativeDir, manifest] of Object.entries(packages)) {
    writeManifest(root, relativeDir, manifest);
  }
  return root;
}

describe("private-package guard", () => {
  test("the real repository declares every workspace package unpublishable", () => {
    const { ok, packages, problems } = auditWorkspacePackages(repositoryRoot);

    assert.equal(problems.length, 0, `unexpected problems: ${problems.join("; ")}`);
    assert.equal(ok, true);
    assert.ok(
      packages.length >= 2,
      `expected at least two workspace packages, saw ${packages.length}`,
    );

    for (const pkg of packages) {
      assert.equal(pkg.private, true, `${pkg.name} is not marked private`);
    }

    // The specific regression: this package shipped unpublishable-by-accident for four
    // releases because nothing asserted the field.
    const mcp = packages.find((pkg) => pkg.name === "@cerberus/mcp-mongodb");
    assert.ok(mcp, "@cerberus/mcp-mongodb was not found among the workspace packages");
    assert.equal(mcp.private, true);
  });

  test("a workspace package that is neither private nor allowlisted fails", () => {
    const root = fixture({
      workspaces: ["packages/thing"],
      packages: { "packages/thing": { name: "@cerberus/thing", version: "0.0.0" } },
    });

    try {
      const { ok, problems } = auditWorkspacePackages(root);
      assert.equal(ok, false);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /@cerberus\/thing/);
      assert.match(problems[0], /registry/);
      assert.match(problems[0], /private/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an allowlist entry with a reason permits publication", () => {
    const root = fixture({
      workspaces: ["packages/thing"],
      packages: { "packages/thing": { name: "@cerberus/thing", version: "0.0.0" } },
    });

    try {
      const { ok, problems } = auditWorkspacePackages(root, {
        "@cerberus/thing": "publishable on purpose for this fixture",
      });
      assert.equal(problems.length, 0, problems.join("; "));
      assert.equal(ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an allowlist entry with a blank reason is not a reason", () => {
    const root = fixture({
      workspaces: ["packages/thing"],
      packages: { "packages/thing": { name: "@cerberus/thing", version: "0.0.0" } },
    });

    try {
      const { ok, problems } = auditWorkspacePackages(root, { "@cerberus/thing": "   " });
      assert.equal(ok, false);
      assert.match(problems.join(" "), /@cerberus\/thing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a stale allowlist entry fails, so a guarantee cannot be silently retired", () => {
    const root = fixture({
      workspaces: ["packages/thing"],
      packages: {
        "packages/thing": { name: "@cerberus/thing", version: "0.0.0", private: true },
      },
    });

    try {
      const { ok, problems } = auditWorkspacePackages(root, {
        "@cerberus/gone": "was publishable once",
      });
      assert.equal(ok, false);
      assert.match(problems.join(" "), /@cerberus\/gone/);
      assert.match(problems.join(" "), /not a workspace package/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a workspace entry that resolves to nothing fails rather than passing vacuously", () => {
    const root = fixture({ workspaces: ["packages/absent"], packages: {} });

    try {
      const { ok, problems } = auditWorkspacePackages(root);
      assert.equal(ok, false);
      assert.match(problems.join(" "), /resolves to no directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a workspace directory with no package.json fails rather than passing vacuously", () => {
    const root = fixture({ workspaces: ["packages/empty"], packages: {} });
    mkdirSync(join(root, "packages", "empty"), { recursive: true });

    try {
      const { ok, problems } = auditWorkspacePackages(root);
      assert.equal(ok, false);
      assert.match(problems.join(" "), /no readable package\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unpublishable root manifest fails", () => {
    const root = fixture({
      workspaces: ["packages/thing"],
      packages: {
        "packages/thing": { name: "@cerberus/thing", version: "0.0.0", private: true },
      },
      rootPrivate: false,
    });

    try {
      const { ok, problems } = auditWorkspacePackages(root);
      assert.equal(ok, false);
      assert.match(problems.join(" "), /root package\.json is not private/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a glob workspace entry is expanded and each member audited", () => {
    const root = fixture({
      workspaces: ["packages/*"],
      packages: {
        "packages/one": { name: "@cerberus/one", version: "0.0.0", private: true },
        "packages/two": { name: "@cerberus/two", version: "0.0.0" },
      },
    });

    try {
      const { ok, packages, problems } = auditWorkspacePackages(root);
      assert.equal(packages.length, 2);
      assert.equal(ok, false, "the unmarked member of the glob must fail the audit");
      assert.match(problems.join(" "), /@cerberus\/two/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a duplicate package name across workspaces fails", () => {
    const root = fixture({
      workspaces: ["packages/one", "packages/two"],
      packages: {
        "packages/one": { name: "@cerberus/same", version: "0.0.0", private: true },
        "packages/two": { name: "@cerberus/same", version: "0.0.0", private: true },
      },
    });

    try {
      const { ok, problems } = auditWorkspacePackages(root);
      assert.equal(ok, false);
      assert.match(problems.join(" "), /declared by more than one workspace/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("expandWorkspaceEntry returns nothing for a missing literal path", () => {
    assert.deepEqual(expandWorkspaceEntry(repositoryRoot, "packages/definitely-absent"), []);
  });

  test("expandWorkspaceEntry resolves a literal path that exists", () => {
    const resolved = expandWorkspaceEntry(repositoryRoot, "packages/mcp-mongodb");
    assert.equal(resolved.length, 1);
    assert.ok(resolved[0].endsWith(join("packages", "mcp-mongodb")));
  });
});
