#!/usr/bin/env node
import { loadConfig } from "../src/core/config.mjs";
import { createHarness } from "../src/core/harness.mjs";
import { PHASES } from "../src/core/method.mjs";
import { TERMINAL_FIXPOINT } from "../src/core/sweep.mjs";

function parseArgs(argv) {
  const args = { task: "", contract: "", root: undefined, quiet: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") args.root = argv[(i += 1)];
    else if (arg === "--contract") args.contract = argv[(i += 1)];
    else if (arg === "--quiet") args.quiet = true;
    else rest.push(arg);
  }
  args.task = rest.join(" ").trim();
  return args;
}

function line(event) {
  const { type, ...rest } = event;
  const detail = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  process.stderr.write(`[${type}] ${detail}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task) {
    process.stderr.write('usage: lean-har "<task>" [--contract <text>] [--root <dir>] [--quiet]\n');
    process.exit(2);
  }

  const config = loadConfig({ root: args.root });
  if (!config.hasApiKey) {
    process.stderr.write(`no OPENAI_API_KEY found at ${config.envPath} or in the environment\n`);
    process.exit(1);
  }

  const harness = createHarness({
    root: config.root,
    config,
    logger: args.quiet ? () => {} : line,
  });

  const startPhase = harness.store.getPhase();
  process.stderr.write(`model: ${config.model}\nroot: ${config.root}\n`);
  process.stderr.write(`phase: ${startPhase} (${PHASES[startPhase].id})\n\n`);

  const result = await harness.run({ task: args.task });

  if (args.contract) {
    const report = await harness.verify({ contract: args.contract });
    process.stderr.write(`\nverifier: ${report.verdict} (turns=${report.turns})\n`);
  }

  const steps = await harness.walk();
  const sweep = await harness.sweep();

  const final = (result.messages ?? [])
    .filter((m) => m.role === "assistant")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .pop();

  process.stdout.write(`\n${final ?? "(no assistant output)"}\n`);
  process.stderr.write(
    `\nturns=${result.turns} blocked=${result.blocked.length} witnesses=${result.witnesses.length}\n`,
  );
  process.stderr.write(
    `spine: ${steps.map((s) => `${s.from}->${s.to}${s.ok ? "" : "!"}`).join(" ")}\n`,
  );
  process.stderr.write(
    `sweep: terminal=${sweep.terminal} sweeps=${sweep.sweeps} variant=${sweep.variantHistory.join(",")}\n`,
  );
  process.stderr.write(`reason: ${sweep.reason}\n`);

  process.exit(sweep.terminal === TERMINAL_FIXPOINT ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
