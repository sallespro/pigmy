#!/usr/bin/env node
/**
 * Adversarial verification.
 *
 * gm's VERIFY doctrine holds that verification is a live witness against real
 * code, never a suite asserting against mocks -- which is also why this is a
 * runnable program rather than a test suite (a standing test file would trip
 * the no-synthetic-test-files gate it exists to exercise).
 *
 * Every check constructs the state a guarantee must refuse, then confirms the
 * refusal. A guarantee that passes when it should refuse is a defect.
 *
 *   node bin/verify.mjs          structural checks (no network)
 *   node bin/verify.mjs --live   also run the agent against the real model
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { loadConfig, makeRedactor, redact } from "../src/core/config.mjs";
import { createAdmissionFilter } from "../src/core/admission.mjs";
import { createGates } from "../src/core/gates.mjs";
import { attemptTransition, EDGES, PHASES } from "../src/core/fsm.mjs";
import { Store } from "../src/core/store.mjs";
import { createTools } from "../src/tools/index.mjs";
import { createHarness } from "../src/core/harness.mjs";

const HARNESS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
let checks = 0;

function check(label, actual, expected, extra = "") {
  checks += 1;
  const ok = actual === expected;
  if (!ok) failures += 1;
  process.stdout.write(
    `  ${ok ? "pass" : "FAIL"}  ${label.padEnd(52)}${extra ? ` :: ${String(extra).slice(0, 58)}` : ""}\n`,
  );
  return ok;
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pi-gm-verify-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "verify@example.invalid"]);
  git(dir, ["config", "user.name", "verify"]);
  writeFileSync(join(dir, ".gitignore"), ".gm-pi/\n");
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "seed"]);
  return dir;
}

async function gateVerdict(root, store, gate, options = {}) {
  const { evaluateGate } = createGates({ root, store, options });
  return evaluateGate(gate);
}

async function verifyFsm() {
  section("Phase machine");

  check("nine phases", PHASES.length, 9);
  check("twenty-one edges", EDGES.length, 21);

  const always = async () => ({ ok: true, detail: "" });
  const skip = await attemptTransition({ from: "SPECIFY", to: "COMPLETE", evaluateGate: always });
  check("illegal transition refused", skip.ok, false, skip.reason);

  const legal = await attemptTransition({ from: "SPECIFY", to: "PROVE", evaluateGate: always });
  check("legal transition admitted", legal.ok, true);

  const thrower = async () => {
    throw new Error("probe exploded");
  };
  const failClosed = await attemptTransition({ from: "SEC", to: "RES", evaluateGate: thrower });
  check("throwing gate probe fails closed", failClosed.ok, false, failClosed.failures[0]?.detail);

  const feedback = await attemptTransition({ from: "DECIDE", to: "SPECIFY", evaluateGate: always });
  check("feedback edge DECIDE to SPECIFY exists", feedback.ok, true);
}

async function verifyGatesRefuse() {
  section("Gates refuse their violation");

  const cases = [
    ["worktree-clean refuses a dirty tree", "worktree-clean", (d) => writeFileSync(join(d, "dirty.txt"), "x\n"), {}],
    [
      "prd-all-closed refuses an open row",
      "prd-all-closed",
      (d, s) => s.addPrdRow({ id: "open", text: "unfinished" }),
      {},
    ],
    [
      "mutables-all-resolved refuses a pending mutable",
      "mutables-all-resolved",
      (d, s) => s.addMutable({ id: "m", text: "unproven" }),
      {},
    ],
    ["residual-scan-fired refuses a missing marker", "residual-scan-fired", () => {}, {}],
    [
      "ci-validated-fresh refuses a stale marker",
      "ci-validated-fresh",
      (d, s) => s.markCiValidated("0".repeat(40)),
      {},
    ],
    [
      "no-secrets-in-diff refuses a token literal",
      "no-secrets-in-diff",
      (d) => writeFileSync(join(d, "leak.js"), `const k = "sk-${"A".repeat(24)}";\n`),
      {},
    ],
    [
      "no-hedge-language-in-diff refuses a hedge phrase",
      "no-hedge-language-in-diff",
      (d) => writeFileSync(join(d, "n.md"), "This is out of scope for this change.\n"),
      {},
    ],
    [
      "no-admit-deferral-markers refuses an admit marker",
      "no-admit-deferral-markers",
      (d) => writeFileSync(join(d, "a.js"), `// TO${"DO"}: finish\nexport const x = 1;\n`),
      {},
    ],
    [
      "no-synthetic-test-files refuses a test file",
      "no-synthetic-test-files",
      (d) => {
        mkdirSync(join(d, "test"), { recursive: true });
        writeFileSync(join(d, "test", "a.test.js"), "// suite\n");
      },
      {},
    ],
    [
      "no-graphical-symbols-in-diff refuses a decorative glyph",
      "no-graphical-symbols-in-diff",
      // Built from a code point rather than written literally, so this file
      // does not itself carry the glyph it exists to detect.
      (d) => writeFileSync(join(d, "d.md"), `one ${String.fromCodePoint(0x2192)} two\n`),
      {},
    ],
    [
      "no-unchecked-panics-in-diff refuses an unpaired throw",
      "no-unchecked-panics-in-diff",
      (d) => writeFileSync(join(d, "b.js"), "export function f(){ throw new Error('x'); }\n"),
      {},
    ],
    [
      "idempotent-dispatch-replay-safe refuses conflicting replay",
      "idempotent-dispatch-replay-safe",
      (d, s) => {
        const base = { id: "dup", tool: "exec", surface: d, input: "i", output: "o" };
        s.appendWitness({ ...base, outcome: "ok" });
        s.appendWitness({ ...base, outcome: "error" });
      },
      {},
    ],
    ["claim-audit-clean refuses an unwitnessed claim", "claim-audit-clean", () => {}, { completionClaims: ["ghost"] }],
    [
      "browser-witness-coverage refuses an unwitnessed edit",
      "browser-witness-coverage",
      () => {},
      { clientEdits: ["app.js"] },
    ],
    ["app-loads-witnessed refuses an unobserved app", "app-loads-witnessed", () => {}, { appLoaded: false }],
  ];

  for (const [label, gate, mutate, options] of cases) {
    const dir = newRepo();
    const store = new Store(dir).init();
    mutate(dir, store);
    const verdict = await gateVerdict(dir, store, gate, options);
    check(label, verdict.ok, false, verdict.detail);
  }
}

async function verifyGatesAdmit() {
  section("Gates admit clean state");

  const dir = newRepo();
  const store = new Store(dir).init();
  store.fireResidualScan();
  store.markCiValidated(git(dir, ["rev-parse", "HEAD"]).trim());

  for (const gate of [
    "worktree-clean",
    "prd-all-closed",
    "mutables-all-resolved",
    "residual-scan-fired",
    "ci-validated-fresh",
    "no-secrets-in-diff",
    "no-hedge-language-in-diff",
    "no-admit-deferral-markers",
    "no-synthetic-test-files",
    "no-graphical-symbols-in-diff",
    "no-unchecked-panics-in-diff",
    "idempotent-dispatch-replay-safe",
    "claim-audit-clean",
    "browser-witness-coverage",
    "submodules-clean",
  ]) {
    const verdict = await gateVerdict(dir, store, gate, { requiresApp: false });
    check(`${gate} admits`, verdict.ok, true, verdict.detail);
  }
}

async function verifyAdmission() {
  section("Admission filter");

  const dir = newRepo();
  const store = new Store(dir).init();

  const f = createAdmissionFilter({ root: dir, store });
  check(
    "L2 admits the first writer",
    f.admit({ callId: "a", toolName: "write_file", args: { path: "s.txt" } }).admit,
    true,
  );
  const contend = f.admit({ callId: "b", toolName: "write_file", args: { path: "s.txt" } });
  check("L2 defers a contending writer", contend.admit, false, contend.reason);
  f.release({ callId: "a" });
  check(
    "L2 admits after release",
    f.admit({ callId: "c", toolName: "write_file", args: { path: "s.txt" } }).admit,
    true,
  );

  const f2 = createAdmissionFilter({ root: dir, store });
  f2.admit({ callId: "n1", toolName: "write_file", args: { path: "x.txt" } });
  check(
    "L2 normalizes equivalent paths to one surface",
    f2.admit({ callId: "n2", toolName: "write_file", args: { path: "./x.txt" } }).admit,
    false,
  );

  const f3 = createAdmissionFilter({ root: dir, store });
  const unwitnessed = f3.admit({ callId: "k", toolName: "complete", args: { id: "ghost" } });
  check("L1 refuses an unwitnessed claim", unwitnessed.admit, false, unwitnessed.reason);

  store.appendWitness({
    id: "ghost",
    tool: "exec",
    surface: dir,
    input: "i",
    output: "o",
    outcome: "ok",
  });
  const f4 = createAdmissionFilter({ root: dir, store });
  check(
    "L1 admits a witnessed claim",
    f4.admit({ callId: "k2", toolName: "complete", args: { id: "ghost" } }).admit,
    true,
  );

  const f5 = createAdmissionFilter({ root: dir, store, repeatLimit: 3 });
  let last;
  for (let i = 0; i < 4; i += 1) {
    last = f5.admit({ callId: `r${i}`, toolName: "exec", args: { cwd: ".", command: "same" } });
    f5.release({ callId: `r${i}` });
  }
  check("L3 refuses repeated identical dispatch", last.admit, false, f5.classify());

  const f6 = createAdmissionFilter({ root: dir, store, flatLimit: 3 });
  let flat;
  for (let i = 0; i < 5; i += 1) {
    flat = f6.admit({ callId: `n${i}`, toolName: "write_file", args: { path: `f${i}.txt` } });
    f6.release({ callId: `n${i}`, noop: true });
  }
  check("L3 refuses flat (no-op) motion", flat.admit, false, f6.classify());

  const broken = createAdmissionFilter({
    root: dir,
    store: {
      readWitnesses() {
        throw new Error("ledger unavailable");
      },
    },
  });
  const closed = broken.admit({ callId: "z", toolName: "complete", args: { id: "x" } });
  check("filter fails closed when the ledger throws", closed.admit, false, closed.reason);
}

async function verifyTools() {
  section("Tool surface");

  const dir = newRepo();
  const config = { ...loadConfig(), execTimeoutMs: 3000, maxOutputBytes: 200 };
  const tools = createTools({ root: dir, config, redact: makeRedactor(config) });
  const T = Object.fromEntries(tools.map((t) => [t.name, t]));

  const ran = await T.exec.execute("v1", { command: 'node -e "console.log(6*7)"' });
  check("exec returns real stdout", ran.content[0].text.includes("42"), true);
  check("exec reports the exit code", ran.details.exitCode, 0);

  const failed = await T.exec.execute("v2", { command: 'node -e "process.exit(3)"' });
  check("non-zero exit is a result, not a throw", failed.details.exitCode, 3);

  const slow = await T.exec.execute("v3", { command: 'node -e "setTimeout(()=>{},60000)"' });
  check("exec enforces its timeout", slow.details.timedOut, true);

  const long = await T.exec.execute("v4", { command: `node -e "console.log('x'.repeat(5000))"` });
  check("exec truncates unbounded output", long.details.truncated, true);

  await T.write_file.execute("v5", { path: "d/a.txt", content: "hello" });
  const readBack = await T.read_file.execute("v6", { path: "d/a.txt" });
  check("write then read round-trips", readBack.content[0].text, "hello");

  const rewrite = await T.write_file.execute("v7", { path: "d/a.txt", content: "hello" });
  check("identical rewrite is a no-op", rewrite.details.noop, true);

  let escaped = false;
  try {
    await T.read_file.execute("v8", { path: "../../../etc/passwd" });
  } catch (err) {
    escaped = /escapes workspace/.test(err.message);
  }
  check("path escape is refused", escaped, true);
}

function verifySecrets() {
  section("Secret handling");

  const config = loadConfig();
  const synthetic = `sk-${"S".repeat(28)}`;

  if (config.hasApiKey) {
    check(
      "configured key is redacted",
      redact(`token=${config.apiKey}`, config.secrets).includes(config.apiKey),
      false,
    );
  }
  check(
    "unconfigured key shape is redacted",
    redact(`token=${synthetic}`, []).includes(synthetic),
    false,
  );
  check(
    "bearer header is redacted",
    redact(`Authorization: Bearer ${"a".repeat(40)}`, []).includes("a".repeat(40)),
    false,
  );

  // git check-ignore exits 0 only when the path is actually ignored.
  let envIgnored = false;
  try {
    execFileSync("git", ["check-ignore", "-q", ".env"], {
      cwd: HARNESS_DIR,
      stdio: ["ignore", "ignore", "ignore"],
    });
    envIgnored = true;
  } catch {
    envIgnored = false;
  }
  check("har/.env is gitignored", envIgnored, true);
}

async function verifyLive() {
  section("Live agent run against the real model");

  const config = loadConfig();
  if (!config.hasApiKey) {
    process.stdout.write("  skipped: no OPENAI_API_KEY available\n");
    return;
  }

  const root = newRepo();
  const harness = createHarness({ root, config: { ...config, maxTurns: 12 }, logger: () => {} });

  const result = await harness.run({
    task:
      "Write a file called fib.js in the workspace that prints the 20th Fibonacci number " +
      "(1-indexed, F(1)=1, F(2)=1). Then execute it with node and report the exact number printed.",
  });

  const finalText = result.messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text))
    .join("\n");

  check("agent created the file", existsSync(join(root, "fib.js")), true);
  check("agent reported the correct value", finalText.includes("6765"), true);

  if (existsSync(join(root, "fib.js"))) {
    // Independent re-execution: the agent's claim is not evidence, the run is.
    const observed = execFileSync("node", ["fib.js"], { cwd: root, encoding: "utf8" }).trim();
    check("independent re-run prints the same value", observed.includes("6765"), true, observed);
  }

  check(
    "exec was witnessed",
    result.witnesses.some((w) => w.tool === "exec" && w.outcome === "ok"),
    true,
  );
  check(
    "every witness carries id, hash, and timestamp",
    result.witnesses.every((w) => Boolean(w.id && w.hash && w.ts)),
    true,
  );

  const ledger = readFileSync(join(root, ".gm-pi", "witness.jsonl"), "utf8");
  check("ledger persisted to disk", ledger.trim().split("\n").length, result.witnesses.length);
  check("no credential leaked into the ledger", ledger.includes(config.apiKey.slice(0, 20)), false);
}

async function main() {
  const live = process.argv.includes("--live");

  await verifyFsm();
  await verifyGatesRefuse();
  await verifyGatesAdmit();
  await verifyAdmission();
  await verifyTools();
  verifySecrets();
  if (live) await verifyLive();
  else process.stdout.write("\n(live model checks skipped; pass --live to include them)\n");

  process.stdout.write(`\n${checks - failures}/${checks} checks behaved correctly\n`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`verification failed to run: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
