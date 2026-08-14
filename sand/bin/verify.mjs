#!/usr/bin/env node
/**
 * Structural verification for the sandbox engine.
 *
 * Everything here is offline: the parser, the line splitter, the bus
 * replay cursor, the agent registry's argv mapping, and the dotenv reader.
 * A run that spends API budget is not a test, so nothing here spawns an
 * agent -- it checks the machinery that decides what an agent is told and
 * how its output is understood.
 */

import { strict as assert } from "node:assert";

import { AGENTS, agentById } from "../src/engine/agents.mjs";
import { classify, readArtifact } from "../src/engine/artifacts.mjs";
import { EventBus, createLineSplitter, parseAgentLine } from "../src/engine/events.mjs";
import { parseEnvFile } from "../src/engine/server.mjs";

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  pass  ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

process.stdout.write("\nsandbox verification\n\n");

check("parses a plain event line", () => {
  const parsed = parseAgentLine("[tool_call] tool=read path=README.md");
  assert.equal(parsed.type, "tool_call");
  assert.deepEqual(parsed.fields, { tool: "read", path: "README.md" });
});

check("keeps spaces inside a JSON value", () => {
  // A naive split(" ") shreds this; the lookahead split must not.
  const parsed = parseAgentLine('[gate] name=contract detail={"a": 1, "b": 2} ok=false');
  assert.equal(parsed.fields.name, "contract");
  assert.deepEqual(parsed.fields.detail, { a: 1, b: 2 });
  assert.equal(parsed.fields.ok, "false");
});

check("returns null for a non-event line", () => {
  assert.equal(parseAgentLine("model: gpt-5.6-luna"), null);
  assert.equal(parseAgentLine("    at main (file.mjs:1:1)"), null);
});

check("splits lines across chunk boundaries", () => {
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.push("[a] x=1\n[b] y=");
  splitter.push("2\n[c] z=3");
  assert.deepEqual(lines, ["[a] x=1", "[b] y=2"]);
  splitter.flush();
  assert.deepEqual(lines, ["[a] x=1", "[b] y=2", "[c] z=3"]);
});

check("assigns monotonic sequence numbers", () => {
  const bus = new EventBus();
  const a = bus.emitEvent({ kind: "lifecycle", message: "one" });
  const b = bus.emitEvent({ kind: "lifecycle", message: "two" });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
});

check("replays only what a client missed", () => {
  const bus = new EventBus();
  for (let i = 0; i < 5; i += 1) bus.emitEvent({ kind: "lifecycle", message: String(i) });
  assert.equal(bus.since(0).length, 5);
  assert.equal(bus.since(3).length, 2);
  assert.deepEqual(
    bus.since(3).map((e) => e.seq),
    [4, 5],
  );
});

check("bounds history so a long run cannot grow forever", () => {
  const bus = new EventBus({ historyLimit: 10 });
  for (let i = 0; i < 50; i += 1) bus.emitEvent({ kind: "lifecycle", message: String(i) });
  assert.equal(bus.history.length, 10);
  // The newest events survive, not the oldest.
  assert.equal(bus.history.at(-1).seq, 50);
});

check("registry covers exactly the two requested agents", () => {
  assert.deepEqual(
    AGENTS.map((a) => a.id).sort(),
    ["pigmy", "pilean"],
  );
  assert.match(agentById("pilean").repo, /sallespro\/pilean\.git$/);
  assert.match(agentById("pigmy").repo, /sallespro\/pigmy\.git$/);
});

check("maps the workspace onto each agent's own flag", () => {
  // The two harnesses name the same concept differently; the registry is
  // the only place that may know it.
  const lean = agentById("pilean").argv({ task: "T", workspace: "/w" });
  assert.deepEqual(lean, ["T", "--root", "/w"]);

  const gm = agentById("pigmy").argv({ task: "T", workspace: "/w" });
  assert.deepEqual(gm, ["T", "--workspace", "/w"]);
});

check("passes a contract to pilean only when one is given", () => {
  const without = agentById("pilean").argv({ task: "T", workspace: "/w" });
  assert.ok(!without.includes("--contract"));
  const withContract = agentById("pilean").argv({ task: "T", workspace: "/w", contract: "C" });
  assert.deepEqual(withContract.slice(-2), ["--contract", "C"]);
});

check("reads pilean exit 1 as surfaced, not as a crash", () => {
  // lean's second terminal is a real verdict: a condition needs a person.
  assert.deepEqual(agentById("pilean").classifyExit(0), { outcome: "fixpoint", ok: true });
  assert.deepEqual(agentById("pilean").classifyExit(1), { outcome: "surfaced", ok: false });
});

check("reads pigmy exit 2 as misconfiguration", () => {
  assert.deepEqual(agentById("pigmy").classifyExit(0), { outcome: "completed", ok: true });
  assert.deepEqual(agentById("pigmy").classifyExit(2), { outcome: "misconfigured", ok: false });
});

check("unwraps pilean's content-block answer into readable text", () => {
  // Observed shape: the provider returns content blocks, and pilean prints
  // them verbatim rather than flattening to a string.
  const raw = JSON.stringify([
    { type: "text", text: "Created `answer.txt` containing:\n4", textSignature: '{"v":1}' },
  ]);
  assert.equal(agentById("pilean").formatAnswer(raw), "Created `answer.txt` containing:\n4");
});

check("leaves an already-plain pilean answer alone", () => {
  assert.equal(agentById("pilean").formatAnswer("  just text  "), "just text");
  // Unparseable JSON must surface as-is, never as an empty card.
  assert.equal(agentById("pilean").formatAnswer("[broken"), "[broken");
});

check("drops pigmy's trailer, which the card already shows", () => {
  const raw = "The file has 4 words.\n\n--- 3 turn(s), 2 witness(es), 0 blocked, phase SPECIFY ---";
  assert.equal(agentById("pigmy").formatAnswer(raw), "The file has 4 words.");
});

check("briefs each agent on what finishing means here", () => {
  // pilean's gates read `git diff HEAD`, so unstaged work is invisible.
  assert.match(agentById("pilean").briefing, /git add -A/);
  // pigmy can exit 0 having written only a spec; ask for the artifact.
  assert.match(agentById("pigmy").briefing, /not finishing it/);
});

check("classifies artifacts so html can be rendered and binaries refused", () => {
  assert.equal(classify("report.html"), "html");
  assert.equal(classify("weather.js"), "text");
  assert.equal(classify("notes"), "text");
  assert.equal(classify("chart.png"), "binary");
});

check("asks both agents to write documents to a file, not just stdout", () => {
  // Otherwise "provide simple html" produces stdout only, and the UI has
  // no artifact to show.
  for (const id of ["pilean", "pigmy"]) {
    assert.match(agentById(id).briefing, /write it to a file/);
  }
});

check("parses the credential file shapes that occur in practice", () => {
  const env = parseEnvFile(
    ["# comment", "OPENAI_API_KEY=sk-test-000", 'export QUOTED="v w"', "bad line", "EMPTY="].join(
      "\n",
    ),
  );
  assert.equal(env.OPENAI_API_KEY, "sk-test-000");
  assert.equal(env.QUOTED, "v w");
  assert.equal(env.EMPTY, "");
  assert.ok(!("bad line" in env));
});

// One async check: the traversal guard is the security-relevant part of
// serving artifacts, so it is asserted against the real filesystem.
await (async () => {
  const name = "refuses to read outside the workspace";
  try {
    await readArtifact(process.cwd(), "../../../../etc/passwd");
    failed += 1;
    process.stdout.write(`  FAIL  ${name}\n        it returned content instead of refusing\n`);
  } catch (err) {
    if (/escapes the workspace/.test(err.message)) {
      passed += 1;
      process.stdout.write(`  pass  ${name}\n`);
    } else {
      failed += 1;
      process.stdout.write(`  FAIL  ${name}\n        wrong error: ${err.message}\n`);
    }
  }
})();

process.stdout.write(`\n${passed} passing, ${failed} failing\n\n`);
process.exit(failed === 0 ? 0 : 1);
