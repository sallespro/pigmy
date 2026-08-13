/**
 * The gate registry.
 *
 * Sixteen predicates, semantics taken from AnEntrypoint/gm-config
 * fsm/predicates.md. Each returns `{ ok, detail }` and never throws: a probe
 * that cannot determine its answer returns `ok: false`, so a broken check
 * refuses an edge rather than waving it through.
 *
 * Diff-scoped predicates read the working diff (tracked changes plus untracked
 * files) and inspect only ADDED lines, so pre-existing repository content does
 * not permanently block every transition.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// --- git helpers ---------------------------------------------------------

function git(root, args) {
  try {
    return {
      ok: true,
      out: execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024,
      }),
    };
  } catch (err) {
    return { ok: false, out: "", error: err?.message ?? String(err) };
  }
}

function isGitRepo(root) {
  return git(root, ["rev-parse", "--git-dir"]).ok;
}

export function headSha(root) {
  const r = git(root, ["rev-parse", "HEAD"]);
  return r.ok ? r.out.trim() : null;
}

function porcelain(root) {
  const r = git(root, ["status", "--porcelain"]);
  return r.ok ? r.out : null;
}

/**
 * Added lines of the working diff, plus contents of untracked files.
 *
 * Returns `[{ file, line, text }]`. Untracked files are included because a
 * brand-new file is exactly where a secret or an admit marker tends to land,
 * and it would otherwise be invisible to `git diff`.
 */
export function addedLines(root, { includeUntracked = true } = {}) {
  const out = [];
  if (!isGitRepo(root)) return out;

  const tracked = git(root, ["diff", "HEAD", "--unified=0", "--no-color"]);
  const text = tracked.ok ? tracked.out : git(root, ["diff", "--unified=0", "--no-color"]).out;

  let file = null;
  let lineNo = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      lineNo = Number.parseInt(hunk[1], 10);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (file) out.push({ file, line: lineNo, text: raw.slice(1) });
      lineNo += 1;
    }
  }

  if (includeUntracked) {
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
    if (untracked.ok) {
      for (const rel of untracked.out.split(/\r?\n/)) {
        const name = rel.trim();
        if (!name) continue;
        const abs = join(root, name);
        try {
          const st = statSync(abs);
          if (!st.isFile() || st.size > 4 * 1024 * 1024) continue;
          const content = readFileSync(abs, "utf8");
          content.split(/\r?\n/).forEach((t, i) => out.push({ file: name, line: i + 1, text: t }));
        } catch {
          // Unreadable or binary: nothing to inspect, and not a reason to fail.
        }
      }
    }
  }
  return out;
}

// --- pattern definitions -------------------------------------------------

const SOURCE_EXT = /\.(rs|js|jsx|mjs|cjs|ts|tsx|py|go|java|c|h|cc|cpp|rb|php|swift|kt)$/i;

const ADMIT_MARKER = /(^|[^A-Za-z0-9])(TODO|FIXME|XXX|HACK):/;
const PLACEHOLDER_MACRO = /\b(todo!\(\)|unimplemented!\(\))/;
const NOT_IMPLEMENTED = /not\s+(yet\s+)?implemented/i;

const HEDGE_PHRASES = [
  "todo later",
  "in a future session",
  "for now we",
  "as a stopgap",
  "good enough for now",
  "left as an exercise",
  "out of scope for this",
];

const SECRET_PATTERNS = [
  { name: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private-key-pem", re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "provider-token", re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  {
    name: "assigned-token-literal",
    re: /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["'][A-Za-z0-9_\-./+]{16,}["']/i,
  },
  { name: "db-url-inline-password", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/i },
];

/**
 * Decorative non-ASCII: arrows, box drawing, block/geometric shapes,
 * dingbats, and emoji. Built from explicit ranges so the intent is legible
 * and the class cannot silently widen.
 */
const GRAPHICAL = new RegExp(
  "[" +
    "\\u2190-\\u21FF" + // arrows
    "\\u2500-\\u257F" + // box drawing
    "\\u2580-\\u259F" + // block elements
    "\\u25A0-\\u25FF" + // geometric shapes
    "\\u2600-\\u27BF" + // misc symbols and dingbats
    "\\u2B00-\\u2BFF" + // misc symbols and arrows
    "\\uFE0F" + // variation selector (emoji presentation)
    "]|[\\u{1F300}-\\u{1FAFF}]",
  "u",
);

const GRAPHICAL_EXEMPT =
  /(\.png|\.jpg|\.jpeg|\.gif|\.svg|\.ico|\.woff2?|\.ttf|CHANGELOG\.md|package-lock\.json)$/i;

const TEST_DIR = /(^|\/)(test|tests|__tests__)\//;
const TEST_NAME = /\.(test|spec)\.[A-Za-z0-9]+$/;

function isTestPath(file) {
  return TEST_DIR.test(file) || TEST_NAME.test(file);
}

const RUST_PANIC = /\.(unwrap|expect)\s*\(|panic!\s*\(/;

/**
 * Best-effort: a `throw` on an added JS/TS line is unchecked when the file
 * contains no `catch` at all. Mirrors gm's brace-balance heuristic without
 * pretending to be a parser.
 */
function jsThrowUnchecked(root, file, text) {
  if (!/\bthrow\b/.test(text)) return false;
  if (!/\.(js|jsx|mjs|cjs|ts|tsx)$/i.test(file)) return false;
  try {
    const content = readFileSync(join(root, file), "utf8");
    return !/\bcatch\s*[({]/.test(content);
  } catch {
    return false;
  }
}

// --- the registry --------------------------------------------------------

function pass(detail = "") {
  return { ok: true, detail };
}
function fail(detail) {
  return { ok: false, detail };
}

/**
 * Build the gate registry bound to a repository root and a store.
 *
 * `options.clientEdits`, `options.appLoaded`, `options.completionClaims`, and
 * `options.requiresApp` supply witness information the store does not itself
 * track.
 */
export function createGates({ root, store, options = {} }) {
  const diffScan = (predicate, describe) => {
    const offenders = [];
    for (const entry of addedLines(root)) {
      try {
        if (predicate(entry)) offenders.push(entry);
      } catch {
        // A single unreadable entry must not abort the whole scan.
      }
      if (offenders.length >= 20) break;
    }
    if (offenders.length === 0) return pass();
    const shown = offenders
      .slice(0, 5)
      .map((o) => `${o.file}:${o.line}`)
      .join(", ");
    return fail(`${describe} (${offenders.length}): ${shown}`);
  };

  const registry = {
    "prd-all-closed": () => {
      const open = store.openPrdRows();
      return open.length === 0
        ? pass()
        : fail(`${open.length} open PRD row(s): ${open.map((r) => r.id).join(", ")}`);
    },

    "mutables-all-resolved": () => {
      const open = store.openMutables();
      return open.length === 0
        ? pass()
        : fail(`${open.length} unresolved mutable(s): ${open.map((r) => r.id).join(", ")}`);
    },

    "worktree-clean": () => {
      const status = porcelain(root);
      if (status === null) return fail("not a git repository, or git unavailable");
      const lines = status.split(/\r?\n/).filter((l) => l.trim());
      return lines.length === 0
        ? pass()
        : fail(`${lines.length} uncommitted change(s): ${lines.slice(0, 5).join("; ")}`);
    },

    "residual-scan-fired": () =>
      store.residualScanFired() ? pass() : fail("residual-scan marker absent or empty"),

    "ci-validated-fresh": () => {
      const marker = store.readCiMarker();
      if (!marker || !marker.head_sha) return fail("ci-validated marker absent");
      const head = headSha(root);
      if (!head) return fail("cannot resolve HEAD");
      return marker.head_sha === head
        ? pass()
        : fail(`ci marker ${marker.head_sha.slice(0, 8)} does not match HEAD ${head.slice(0, 8)}`);
    },

    "browser-witness-coverage": () => {
      const edits = options.clientEdits ?? [];
      if (edits.length === 0) return pass("no client-side edits this session");
      const witnessed = new Set(
        store.readWitnesses().filter((w) => w.tool === "browser").map((w) => w.surface),
      );
      const missing = edits.filter((f) => !witnessed.has(f));
      return missing.length === 0
        ? pass()
        : fail(`unwitnessed client edit(s): ${missing.slice(0, 5).join(", ")}`);
    },

    "app-loads-witnessed": () => {
      if (options.requiresApp === false) return pass("no application surface");
      return options.appLoaded ? pass() : fail("application load not witnessed");
    },

    "submodules-clean": () => {
      if (!existsSync(join(root, ".gitmodules"))) return pass("no submodules");
      const r = git(root, ["submodule", "status", "--recursive"]);
      if (!r.ok) return fail("submodule status unavailable");
      // git marks drift with a leading '+' (checked-out commit differs) or
      // '-' (uninitialized); a clean submodule line starts with a space.
      const drifted = r.out
        .split(/\r?\n/)
        .filter((l) => l.length > 0 && (l[0] === "+" || l[0] === "-" || l[0] === "U"));
      return drifted.length === 0
        ? pass()
        : fail(`${drifted.length} drifted submodule(s): ${drifted.slice(0, 3).join("; ")}`);
    },

    "claim-audit-clean": () => {
      const claims = options.completionClaims ?? [];
      if (claims.length === 0) return pass("no completion claims");
      const witnessed = new Set(store.readWitnesses().map((w) => w.id));
      const unbacked = claims.filter((c) => !witnessed.has(c));
      return unbacked.length === 0
        ? pass()
        : fail(`unwitnessed claim(s): ${unbacked.slice(0, 5).join(", ")}`);
    },

    "no-hedge-language-in-diff": () =>
      diffScan(
        (e) => /\.md$/i.test(e.file) && HEDGE_PHRASES.some((p) => e.text.toLowerCase().includes(p)),
        "hedge language in prose",
      ),

    "no-synthetic-test-files": () => {
      const files = new Set(addedLines(root).map((e) => e.file));
      const offenders = [...files].filter((f) => isTestPath(f));
      return offenders.length === 0
        ? pass()
        : fail(`synthetic test file(s): ${offenders.slice(0, 5).join(", ")}`);
    },

    "no-graphical-symbols-in-diff": () =>
      diffScan((e) => !GRAPHICAL_EXEMPT.test(e.file) && GRAPHICAL.test(e.text), "decorative glyph"),

    "no-admit-deferral-markers": () =>
      diffScan(
        (e) =>
          SOURCE_EXT.test(e.file) &&
          (ADMIT_MARKER.test(e.text) ||
            PLACEHOLDER_MACRO.test(e.text) ||
            NOT_IMPLEMENTED.test(e.text)),
        "admit/deferral marker",
      ),

    "no-secrets-in-diff": () =>
      diffScan((e) => SECRET_PATTERNS.some((p) => p.re.test(e.text)), "secret-shaped literal"),

    "no-unchecked-panics-in-diff": () =>
      diffScan((e) => {
        if (isTestPath(e.file)) return false;
        if (/\.rs$/i.test(e.file) && RUST_PANIC.test(e.text)) return true;
        return jsThrowUnchecked(root, e.file, e.text);
      }, "unchecked panic/throw"),

    "idempotent-dispatch-replay-safe": () => {
      const seen = new Map();
      const conflicts = [];
      for (const w of store.readWitnesses()) {
        const key = `${w.id}|${w.hash}`;
        const prior = seen.get(key);
        if (prior !== undefined && prior !== w.outcome) {
          conflicts.push(`${String(w.id).slice(0, 12)} (${prior} vs ${w.outcome})`);
        } else {
          seen.set(key, w.outcome);
        }
      }
      return conflicts.length === 0
        ? pass()
        : fail(`replay conflict(s): ${conflicts.slice(0, 5).join(", ")}`);
    },
  };

  /** Evaluate one gate by name. Never throws. */
  async function evaluateGate(name) {
    const probe = registry[name];
    if (!probe) return fail(`unknown gate: ${name}`);
    try {
      return await probe();
    } catch (err) {
      return fail(`gate probe threw: ${err?.message ?? err}`);
    }
  }

  return { registry, evaluateGate, gateNames: Object.keys(registry) };
}
