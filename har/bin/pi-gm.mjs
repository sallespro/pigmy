#!/usr/bin/env node
/**
 * pi-gm -- run a pi agent under gm admission discipline.
 *
 *   pi-gm "task"                  run the agent against a task
 *   pi-gm --workspace DIR "task"  run in a specific workspace
 *   pi-gm --phase                 print the current phase and gate status
 *   pi-gm --advance               walk the phase chain as far as gates permit
 *
 * Exit codes: 0 success, 1 the run or a requested transition was refused,
 * 2 configuration is unusable.
 */

import { resolve } from "node:path";
import process from "node:process";

import { loadConfig } from "../src/core/config.mjs";
import { createHarness } from "../src/core/harness.mjs";

const USAGE = `pi-gm -- a pi agent under gm admission discipline

Usage:
  pi-gm "<task>"                Run the agent against a task
  pi-gm --workspace <dir> ...   Workspace to operate in (default: cwd)
  pi-gm --phase                 Show current phase and all gate results
  pi-gm --advance               Walk the phase chain as far as gates permit
  pi-gm --quiet                 Suppress per-event logging

Environment (har/.env):
  OPENAI_API_KEY  required
  PI_GM_MODEL     model id (default gpt-5.6-luna)
  PI_GM_MAX_TURNS turn ceiling (default 40)
`;

function parseArgs(argv) {
  const opts = {
    workspace: process.cwd(),
    task: null,
    phase: false,
    advance: false,
    quiet: false,
    help: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace" || arg === "-w") {
      opts.workspace = argv[i + 1] ?? opts.workspace;
      i += 1;
    } else if (arg === "--phase") opts.phase = true;
    else if (arg === "--advance") opts.advance = true;
    else if (arg === "--quiet" || arg === "-q") opts.quiet = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else rest.push(arg);
  }
  if (rest.length) opts.task = rest.join(" ");
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const config = loadConfig();
  if (config.envReadError) {
    process.stderr.write(`cannot read ${config.envPath}: ${config.envReadError}\n`);
    return 2;
  }

  const root = resolve(opts.workspace);
  const logger = opts.quiet
    ? () => {}
    : (event) => {
        const bits = Object.entries(event)
          .filter(([k, v]) => k !== "type" && v !== undefined && v !== null && v !== "")
          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
          .join(" ");
        process.stderr.write(`[${event.type}] ${bits}\n`);
      };

  const harness = createHarness({ root, config, logger });

  if (opts.phase) {
    const results = await harness.evaluateAll();
    process.stdout.write(`phase: ${harness.store.getPhase()}\n\n`);
    let refused = 0;
    for (const [gate, r] of Object.entries(results)) {
      if (!r.ok) refused += 1;
      process.stdout.write(`  ${r.ok ? "pass" : "FAIL"}  ${gate.padEnd(34)} ${r.detail}\n`);
    }
    process.stdout.write(`\n${Object.keys(results).length - refused} passing, ${refused} failing\n`);
    return 0;
  }

  if (opts.advance) {
    const walked = await harness.advanceAsFarAsPossible();
    for (const step of walked) {
      process.stdout.write(`${step.from} -> ${step.to}: ${step.ok ? "ok" : "refused"}\n`);
      for (const f of step.failures ?? []) {
        process.stdout.write(`    ${f.gate}: ${f.detail}\n`);
      }
    }
    process.stdout.write(`\nphase: ${harness.store.getPhase()}\n`);
    return walked.every((s) => s.ok) ? 0 : 1;
  }

  if (!opts.task) {
    process.stderr.write(USAGE);
    return 2;
  }

  if (!config.hasApiKey) {
    process.stderr.write(`OPENAI_API_KEY not found in ${config.envPath} or the environment\n`);
    return 2;
  }

  const result = await harness.run({ task: opts.task });

  const finalText = result.messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text))
    .join("\n")
    .trim();

  process.stdout.write(`\n${finalText}\n`);
  process.stdout.write(
    `\n--- ${result.turns} turn(s), ${result.witnesses.length} witness(es), ` +
      `${result.blocked.length} blocked, phase ${result.phase} ---\n`,
  );
  for (const b of result.blocked) {
    process.stdout.write(`  blocked ${b.tool} at ${b.layer}: ${b.reason}\n`);
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    // Top-level boundary: nothing escapes uncaught.
    process.stderr.write(`pi-gm failed: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
