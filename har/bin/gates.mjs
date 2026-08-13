#!/usr/bin/env node
/**
 * Report every gate's verdict against a workspace's real state.
 *
 *   node bin/gates.mjs [workspace]
 *
 * Exit code 0 when all gates pass, 1 when any refuses. Useful as a standalone
 * closure check independent of an agent run.
 */

import { resolve } from "node:path";
import process from "node:process";

import { loadConfig } from "../src/core/config.mjs";
import { createHarness } from "../src/core/harness.mjs";
import { CLOSURE_GATES } from "../src/core/fsm.mjs";

async function main() {
  const target = resolve(process.argv[2] ?? process.cwd());
  const config = loadConfig();
  const harness = createHarness({ root: target, config, logger: () => {} });

  const results = await harness.evaluateAll();
  process.stdout.write(`workspace: ${target}\nphase:     ${harness.store.getPhase()}\n\n`);

  let refused = 0;
  for (const [gate, verdict] of Object.entries(results)) {
    if (!verdict.ok) refused += 1;
    const closure = CLOSURE_GATES.includes(gate) ? " [closure]" : "";
    process.stdout.write(
      `  ${verdict.ok ? "pass" : "FAIL"}  ${gate.padEnd(34)} ${verdict.detail}${closure}\n`,
    );
  }

  const total = Object.keys(results).length;
  process.stdout.write(`\n${total - refused}/${total} gates passing\n`);
  return refused === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`gate report failed: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
