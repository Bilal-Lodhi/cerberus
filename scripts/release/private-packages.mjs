/**
 * The private-package guard.
 *
 * ── The failure this prevents ─────────────────────────────────────────
 *
 * `npm publish` in a workspace package that is not marked `private` uploads it to the
 * public registry. That is not a hypothetical here: `packages/mcp-mongodb` shipped without
 * `"private": true` through four releases, so the only thing standing between this tree
 * and a published `@cerberus/mcp-mongodb` was nobody happening to type the command. The
 * npm registry is not reversible in the way the rest of this repository's operations are
 * — an unpublished version number stays burned — so the safe default has to be a property
 * of the manifest rather than a property of an operator's memory.
 *
 * `private: true` is not a formality. npm refuses to publish a package that carries it,
 * which makes the refusal a mechanism instead of a convention.
 *
 * ── The rule ──────────────────────────────────────────────────────────
 *
 * Every workspace package must either
 *
 *   1. set `"private": true`, or
 *   2. be named in {@link PUBLISHABLE} with a reason.
 *
 * Anything else fails. There is deliberately no "unknown package" default: a new
 * workspace package that forgets the field fails this guard until someone decides, on
 * purpose, whether it is publishable.
 *
 * The root manifest is checked too. It is not a workspace member, but it is the package
 * `npm publish` would act on from the repository root, so leaving it unpublishable is the
 * same guarantee applied one level up.
 *
 * ── Why the allowlist carries a reason ────────────────────────────────
 *
 * An allowlist entry is the one way to opt *out* of the guarantee, so it is the entry most
 * worth being able to read later. A bare package name says "somebody added this"; a reason
 * says whether the decision still holds. An entry with no reason is itself a failure, and
 * so is an entry naming a package that is no longer a workspace member — a stale entry is
 * a guarantee quietly turned off for a name nobody is watching.
 *
 * ── A note on wording ─────────────────────────────────────────────────
 *
 * `scripts/release/secret-guards.mjs` rejects publishing commands anywhere in this
 * directory, and it strips comments but deliberately keeps **string literals** — a string
 * is exactly where such a command lives. So the failure messages below describe a registry
 * upload without naming the command, and the prose above may name it freely because it is
 * inside this block comment. A message that spelled the command out was flagged the first
 * time this guard ran, which is the guard working rather than the guard being wrong.
 *
 * See `docs/release/verification-harness.md`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Packages that are intentionally publishable, with the reason.
 *
 * Empty on purpose. Cerberus publishes no npm package — see owner decision D in the
 * standing charter and `docs/release/repository-metadata.md`. The map exists so that
 * deciding otherwise is an explicit, reviewable edit rather than a missing field.
 *
 * @type {Record<string, string>}
 */
export const PUBLISHABLE = {};

/** Reads and parses a JSON file, or throws with the path in the message. */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Expands one `workspaces` entry into the directories it names.
 *
 * Supports a literal path (`packages/mcp-mongodb`) and a single trailing `*`
 * (`packages/*`), which are the two forms npm itself treats as directory lists. A glob is
 * expanded by reading the parent directory rather than by pulling in a matcher: the
 * alternative is a dependency, and the surface is one segment wide.
 *
 * Returns `[]` for a literal path that does not exist, so the caller reports it as an
 * unresolved workspace rather than as an exception.
 */
export function expandWorkspaceEntry(root, entry) {
  if (!entry.endsWith("/*")) {
    const dir = resolve(root, entry);
    try {
      return statSync(dir).isDirectory() ? [dir] : [];
    } catch {
      return [];
    }
  }

  const parent = resolve(root, entry.slice(0, -2));
  let children;
  try {
    children = readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }

  return children
    .filter((child) => child.isDirectory())
    .map((child) => join(parent, child.name));
}

/**
 * Audits every workspace package under `root`.
 *
 * Pure and exported so the rules can be asserted directly rather than by reading this
 * file's source text, and so a test can drive it over a fixture tree. `publishable` is a
 * parameter rather than the module constant so a test can exercise the allowlist rules
 * without mutating shared state.
 *
 * @returns {{
 *   ok: boolean,
 *   packages: Array<{ dir: string, name: string, private: boolean }>,
 *   problems: string[],
 * }}
 */
export function auditWorkspacePackages(root, publishable = PUBLISHABLE) {
  const problems = [];
  const packages = [];

  let rootManifest;
  try {
    rootManifest = readJson(join(root, "package.json"));
  } catch (error) {
    return {
      ok: false,
      packages,
      problems: [`the root package.json could not be read: ${error.message}`],
    };
  }

  if (rootManifest.private !== true) {
    problems.push(
      "the root package.json is not private, so a publication run at the repository root " +
        "would target it",
    );
  }

  const entries = Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : [];
  if (entries.length === 0) {
    problems.push("the root package.json declares no workspaces, so there is nothing to audit");
  }

  const seenNames = new Set();

  for (const entry of entries) {
    const dirs = expandWorkspaceEntry(root, entry);

    if (dirs.length === 0) {
      problems.push(
        `the workspace entry '${entry}' resolves to no directory, so the packages it was ` +
          "meant to cover are unaudited",
      );
      continue;
    }

    for (const dir of dirs) {
      let manifest;
      try {
        manifest = readJson(join(dir, "package.json"));
      } catch {
        problems.push(
          `the workspace directory '${entry}' contains no readable package.json, so it is ` +
            "unaudited",
        );
        continue;
      }

      const name = typeof manifest.name === "string" ? manifest.name : "";
      if (name.length === 0) {
        problems.push(`the package at '${entry}' has no name, so it cannot be identified`);
        continue;
      }

      if (seenNames.has(name)) {
        problems.push(`the package name '${name}' is declared by more than one workspace`);
      }
      seenNames.add(name);

      const isPrivate = manifest.private === true;
      packages.push({ dir, name, private: isPrivate });

      if (isPrivate) continue;

      const reason = publishable[name];
      if (typeof reason === "string" && reason.trim().length > 0) continue;

      problems.push(
        `'${name}' is not private and is not an intentional publication, so a registry ` +
          "upload would include it. Set `\"private\": true`, or add it to the " +
          "publishable allowlist with a reason.",
      );
    }
  }

  // A stale allowlist entry silently disables the guarantee for a name nobody is
  // watching any more.
  for (const name of Object.keys(publishable)) {
    if (!seenNames.has(name)) {
      problems.push(
        `the publishable allowlist names '${name}', which is not a workspace package. ` +
          "Remove the entry, or restore the package.",
      );
    }
  }

  return { ok: problems.length === 0, packages, problems };
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const { ok, packages, problems } = auditWorkspacePackages(root);

  console.log("PRIVATE-PACKAGE GUARD\n");

  for (const pkg of packages) {
    const label = pkg.private ? "private  " : "PUBLIC   ";
    console.log(`  ${label} ${pkg.name}`);
  }

  if (problems.length > 0) {
    console.error("");
    for (const problem of problems) {
      console.error(`  FAIL ${problem}`);
    }
    console.error(`\n${problems.length} package(s) would be publishable by accident.`);
    process.exit(1);
  }

  console.log(
    `\nOK: all ${packages.length} workspace package(s) are unpublishable by construction.`,
  );
  console.log("Nothing here publishes. This only asserts that it cannot happen by accident.");
}
