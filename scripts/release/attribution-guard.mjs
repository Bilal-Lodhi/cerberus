/**
 * The attribution guard.
 *
 * ── The defect this exists to prevent ─────────────────────────────────
 *
 * Eleven commits merged after `v0.3.0` carry
 * `Co-authored-by: Cerberus Maintainer <maintainer@cerberus.invalid>` — every commit in
 * that cycle. The cause was a single one: the feature-branch commits were created with
 * `git -c user.email=maintainer@cerberus.invalid`, so the commit's **author** was a
 * synthetic identity, and GitHub's squash merge then added a `Co-authored-by` trailer for
 * an author that differed from the pull request's author.
 *
 * `.invalid` is reserved by RFC 2606 and can never be a deliverable address, so a trailer
 * naming one is provably not a contributor. It must not appear again.
 *
 * Public history is **not** rewritten to remove the eleven: rewriting a published branch is
 * a destructive operation, and the authorship on `main` is intact — every merge commit's
 * author and committer are the real GitHub identity and `GitHub <noreply@github.com>`. Only
 * the message trailers carry the synthetic name. The guard is therefore **prospective**:
 * it checks the commits being introduced, and it passes on a tree whose history already
 * contains the trailer.
 *
 * ── What it rejects ───────────────────────────────────────────────────
 *
 *   1. An author, committer or trailer address in a **reserved domain** — `.invalid`,
 *      `.test`, `.localhost`, and the RFC 2606 documentation domains. None can be a real
 *      contributor.
 *   2. A trailer naming a **synthetic maintainer identity** by name, whatever its domain,
 *      so a future `.com` variant is caught too.
 *
 * ── What it deliberately allows ───────────────────────────────────────
 *
 * Legitimate external contributors, and bot identities such as
 * `dependabot[bot]@users.noreply.github.com` or
 * `github-actions[bot]@users.noreply.github.com` — a guard that rejected real automation
 * would be turned off within a week. A name that is genuinely needed can be added to
 * `scripts/release/attribution-allowlist.json` **with a reason**, which is a claim a
 * reviewer can check rather than a silent exemption.
 *
 * ── Range ─────────────────────────────────────────────────────────────
 *
 * Only the commits being introduced are examined, which is what makes this safe to run on
 * a repository whose history already contains the trailer:
 *
 *   node scripts/release/attribution-guard.mjs                 # origin/main..HEAD
 *   node scripts/release/attribution-guard.mjs --range A..B     # an explicit range
 *   node scripts/release/attribution-guard.mjs --all            # every commit (diagnostic)
 *
 * `--all` is for auditing, not for gating: it reports the eleven historical trailers and
 * exits non-zero, which is the honest answer to "is this repository clean?" and the wrong
 * answer to "may this change be merged?".
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/**
 * Domains that cannot belong to a real person.
 *
 * `.invalid`, `.test` and `.localhost` are reserved by RFC 2606 / RFC 6761 and are
 * guaranteed never to resolve. `example.com`, `example.net` and `example.org` are reserved
 * by RFC 2606 for documentation. An address in any of them is a placeholder, and a
 * placeholder presented as a co-author is a claim that a contributor exists.
 */
const RESERVED_DOMAINS = [
  ".invalid",
  ".test",
  ".localhost",
  "example.com",
  "example.net",
  "example.org",
];

/**
 * Names that are not contributors.
 *
 * Checked by name as well as by domain, so a synthetic maintainer identity is caught even
 * if it is later given a deliverable address.
 */
const SYNTHETIC_NAMES = [
  "cerberus maintainer",
  "ai assistant",
  "codex agent",
  "claude",
  "github copilot",
  "copilot",
];

/** Trailer keys that name a person or an agent. */
const ATTRIBUTION_KEYS =
  /^(co-authored-by|signed-off-by|acked-by|reviewed-by|tested-by|reported-by|helped-by|suggested-by)\s*:\s*(.+)$/i;

/** `Name <email>`, or a bare address. */
const ADDRESS = /<?([^<>@\s]+@[^<>\s]+)>?/g;

/**
 * The lines that are actually **trailers**, which is the last paragraph and only that.
 *
 * A guard that matched `^Co-authored-by:` anywhere in the message would fail on a commit
 * that *describes* the trailer it is guarding against — which is exactly what the first
 * version of this guard did, on the very commit that introduced it: the release-prep
 * message quotes `Co-authored-by: Cerberus Maintainer <maintainer@cerberus.invalid>` in its
 * body, and the guard reported the commit that added the guard.
 *
 * A guard that cries wolf on prose is a guard that gets turned off, so this follows git's
 * own rule: the trailer block is the **final paragraph**, and only lines in it are read.
 */
function trailerBlock(message) {
  const lines = message.split(/\r?\n/);

  // Walk back to the blank line that separates the last paragraph from the rest.
  let index = lines.length - 1;
  while (index >= 0 && lines[index].trim() === "") index -= 1;

  let start = index;
  while (start >= 0 && lines[start].trim() !== "") start -= 1;

  return lines.slice(start + 1, index + 1);
}

const allowlistPath = resolve(here, "attribution-allowlist.json");
const allowlist = existsSync(allowlistPath)
  ? JSON.parse(readFileSync(allowlistPath, "utf8")).allow ?? []
  : [];
const allowedEmails = new Set(allowlist.map((entry) => String(entry.email).toLowerCase()));

function domainOf(email) {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

function isReserved(email) {
  const domain = domainOf(email);
  return RESERVED_DOMAINS.some((reserved) => domain === reserved || domain.endsWith(reserved));
}

function isAllowed(email) {
  return allowedEmails.has(email.toLowerCase());
}

const argv = process.argv.slice(2);
const rangeIndex = argv.indexOf("--range");
const all = argv.includes("--all");
const explicitRange = rangeIndex !== -1 && argv[rangeIndex + 1] ? argv[rangeIndex + 1] : null;

/**
 * The base a default range is measured against.
 *
 * ── Why this is resolved rather than assumed ──────────────────────────
 *
 * The default used to be the literal `origin/main..HEAD`. That works in a developer's
 * clone, where the remote-tracking ref exists, and it works in `ci.yml`, which passes an
 * explicit `--range` derived from the event. It **fails** in the release-verification
 * workflow, whose `actions/checkout@v4` fetches one ref and no remote-tracking branches —
 * so `git log origin/main..HEAD` exits 128 and the guard died with an unhandled
 * `execFileSync` stack trace rather than a diagnosis. The manual release drill was red for
 * a reason that had nothing to do with attribution.
 *
 * So the base is discovered, in the order a checkout is likely to have it, and the two
 * workflows are fixed on both sides: this resolves what it can, and the release workflow
 * now fetches the history so that what it resolves is the *whole* range being released.
 *
 * ── Why a missing base is fatal rather than empty ─────────────────────
 *
 * An unresolvable base is **not** "nothing to check". Returning an empty commit list would
 * print OK, which is the one answer a guard must never give for a range it could not read —
 * the same failure mode the secret scan's range resolution was written to avoid. It exits
 * non-zero with the reason instead.
 */
function resolveDefaultBase() {
  for (const candidate of ["origin/main", "main", "refs/remotes/origin/HEAD"]) {
    try {
      git(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

let range;
if (all) {
  range = null;
} else if (explicitRange) {
  range = explicitRange;
} else {
  const base = resolveDefaultBase();
  if (base === null) {
    console.error(
      "attribution guard — no base to measure the range against.\n" +
        "\n  Tried origin/main, main and refs/remotes/origin/HEAD; none resolves in this\n" +
        "  checkout. This is a configuration problem, not a clean repository: a guard that\n" +
        "  examined no commits would report OK, which is the one answer it must never give\n" +
        "  for a range it could not read.\n" +
        "\n  Fix one of:\n" +
        "    - check out with the history: `actions/checkout@v4` with `fetch-depth: 0`\n" +
        "    - pass the range explicitly: --range <base>..<head>\n" +
        "    - audit everything instead: --all   (diagnostic, and it fails on known history)\n",
    );
    process.exit(1);
  }
  range = `${base}..HEAD`;
}

function commits() {
  const args = ["log", "--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e"];
  if (range) args.push(range);

  let raw;
  try {
    raw = git(args);
  } catch (error) {
    // A range that `rev-parse` accepted can still be unreadable — an unreachable object, a
    // shallow boundary. Report it as a guard failure with the reason, not a stack trace.
    console.error(
      `attribution guard — could not read the commit range \`${range ?? "--all"}\`.\n` +
        `\n  ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n` +
        "\n  This is a configuration problem, not a clean repository.\n",
    );
    process.exit(1);
  }

  return raw
    .split("\x1e")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const [sha, authorName, authorEmail, committerName, committerEmail, ...messageParts] =
        chunk.split("\x1f");
      return {
        sha,
        authorName,
        authorEmail,
        committerName,
        committerEmail,
        message: messageParts.join("\x1f"),
      };
    });
}

const found = commits();
const violations = [];

for (const commit of found) {
  const short = commit.sha.slice(0, 8);

  // ── 1. The identities that authored and committed it ──
  for (const [role, name, email] of [
    ["author", commit.authorName, commit.authorEmail],
    ["committer", commit.committerName, commit.committerEmail],
  ]) {
    if (isAllowed(email)) continue;
    if (isReserved(email)) {
      violations.push({
        sha: short,
        what: `${role} identity is in a reserved domain`,
        detail: `${name} <${email}>`,
        fix: "use your real git identity: `git config user.email <your address>`",
      });
    }
    if (SYNTHETIC_NAMES.includes(String(name).toLowerCase())) {
      violations.push({
        sha: short,
        what: `${role} name is a synthetic identity`,
        detail: `${name} <${email}>`,
        fix: "use your real git identity, and do not present a placeholder as a contributor",
      });
    }
  }

  // ── 2. Attribution trailers in the message ──
  //
  // The last paragraph only. See `trailerBlock` for why: a message that describes the
  // trailer it is guarding against must not be reported.
  for (const line of trailerBlock(commit.message)) {
    const trailer = ATTRIBUTION_KEYS.exec(line.trim());
    if (!trailer) continue;

    const key = trailer[1];
    const value = trailer[2];
    const addresses = [...value.matchAll(ADDRESS)].map((match) => match[1]);

    if (addresses.length === 0) continue;

    for (const email of addresses) {
      if (isAllowed(email)) continue;
      const reserved = isReserved(email);
      const syntheticName = SYNTHETIC_NAMES.some((name) =>
        value.toLowerCase().includes(name),
      );

      if (reserved || syntheticName) {
        violations.push({
          sha: short,
          what: `\`${key}\` names a non-existent contributor`,
          detail: value.trim(),
          fix:
            "remove the trailer, and do not add another. If a real person contributed, " +
            "their own git identity belongs in the commit instead",
        });
      }
    }
  }
}

console.log(
  `attribution guard — ${found.length} commit(s) in ${
    range ?? "the whole history"
  }\n`,
);

if (violations.length === 0) {
  console.log(
    "  ok   no synthetic identity in an author, a committer, or an attribution trailer",
  );
  if (!all && found.length === 0) {
    console.log(
      "\nOK: nothing to check. This is the normal result on a branch with no new commits,\n" +
        "    and it is why the guard is safe to run on history that already contains one.",
    );
  } else {
    console.log("\nOK: every attribution in range names something that can exist.");
  }
  process.exit(0);
}

for (const violation of violations) {
  console.log(`  FAIL ${violation.sha} — ${violation.what}`);
  console.log(`       ${violation.detail}`);
  console.log(`       fix: ${violation.fix}`);
}

console.log(
  `\nFAILED: ${violations.length} attribution problem(s).\n` +
    "\n  `.invalid`, `.test`, `.localhost` and the RFC 2606 documentation domains can never\n" +
    "  belong to a real person, so a trailer naming one claims a contributor who does not\n" +
    "  exist. Public history is not rewritten to remove one; the commit is fixed or\n" +
    "  reverted before it is merged.\n" +
    "\n  A name that is genuinely needed goes in scripts/release/attribution-allowlist.json\n" +
    "  with a reason.",
);

process.exit(1);
