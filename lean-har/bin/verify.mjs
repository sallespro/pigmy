#!/usr/bin/env node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, parseEnvFile, redact } from "../src/core/config.mjs";
import { createGates } from "../src/core/gates.mjs";
import {
  BACKREFERENCES,
  GATES,
  PHASES,
  SPINE,
  SPINE_EDGES,
  gateGuarding,
  nextPhase,
  routeCondition,
} from "../src/core/method.mjs";
import { Store } from "../src/core/store.mjs";
import { monotonicityHeld, variantDecreased } from "../src/core/sweep.mjs";
import { createModelRegistry, listAvailableModels } from "../src/model/model.mjs";

const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail ?? "" });
  } catch (err) {
    results.push({ name, ok: false, detail: err && err.message ? err.message : String(err) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

check("method declares nine phases", () => {
  const count = Object.keys(PHASES).length;
  assert(count === 9, `expected 9 phases, found ${count}`);
  return Object.values(PHASES)
    .map((p) => p.id)
    .join(" ");
});

check("method declares five spine gates", () => {
  const count = Object.keys(GATES).length;
  assert(count === 5, `expected 5 gates, found ${count}`);
  return Object.values(GATES)
    .map((g) => g.name)
    .join("; ");
});

check("spine reaches CONVERGENCE from SHAPE", () => {
  let phase = SPINE[0];
  const visited = [phase];
  while (nextPhase(phase)) {
    phase = nextPhase(phase);
    visited.push(phase);
    assert(visited.length <= SPINE.length + 1, "spine walk did not terminate");
  }
  assert(phase === "CONVERGENCE", `spine ended at ${phase}`);
  return visited.join(" -> ");
});

check("every gated spine edge names a known gate", () => {
  for (const edge of SPINE_EDGES) {
    if (!edge.gate) continue;
    assert(GATES[edge.gate], `edge ${edge.from}->${edge.to} names unknown gate ${edge.gate}`);
    const gate = gateGuarding(edge.from, edge.to);
    assert(gate && gate.key === edge.gate, `gateGuarding lost ${edge.gate}`);
  }
  return `${SPINE_EDGES.filter((e) => e.gate).length} gated edges`;
});

check("every backreference routes to a real phase", () => {
  for (const ref of BACKREFERENCES) {
    assert(PHASES[ref.to], `backreference "${ref.condition}" routes to unknown phase ${ref.to}`);
  }
  return `${BACKREFERENCES.length} backreferences`;
});

check("routeCondition resolves a known condition", () => {
  const route = routeCondition("prose was needed to explain the code");
  assert(route === "CONTRACT", `expected CONTRACT, got ${route}`);
  return route;
});

check("dotenv parser reads a quoted key", () => {
  const parsed = parseEnvFile('export OPENAI_API_KEY="sk-test-000000000000000000"\n# comment\n');
  assert(parsed.OPENAI_API_KEY === "sk-test-000000000000000000", "key not parsed");
  return "ok";
});

check("redaction masks a key-shaped literal", () => {
  const masked = redact("token sk-abcdefghijklmnopqrstuvwxyz here", []);
  assert(!masked.includes("sk-abcdefghij"), "key survived redaction");
  return masked;
});

check("store round-trips phase and conditions", () => {
  const root = mkdtempSync(join(tmpdir(), "lean-har-verify-"));
  const store = new Store(root).init();
  assert(store.getPhase() === "SHAPE", `initial phase was ${store.getPhase()}`);
  store.setPhase("CONTRACT", "verify");
  assert(store.getPhase() === "CONTRACT", "phase did not persist");
  const opened = store.openCondition({
    condition: "a gate reopened: probe",
    route: "SHAPE",
    sweep: 1,
  });
  assert(store.openConditionCount() === 1, "condition not counted");
  assert(store.repeatedWithoutNewInformation().length === 0, "fresh condition marked repeated");
  store.openCondition({ condition: "a gate reopened: probe", route: "SHAPE", sweep: 1 });
  assert(
    store.repeatedWithoutNewInformation().length === 0,
    "a second sighting within one sweep was counted as a stall",
  );
  store.openCondition({ condition: "a gate reopened: probe", route: "SHAPE", sweep: 2 });
  assert(store.repeatedWithoutNewInformation().length === 1, "cross-sweep repeat not detected");
  store.closeCondition(opened.id, "verified");
  assert(store.openConditionCount() === 0, "condition not closed");
  return root;
});

check("variant must strictly decrease", () => {
  assert(variantDecreased([3, 2]), "a falling variant was rejected");
  assert(!variantDecreased([2, 2]), "a flat variant was accepted");
  assert(!variantDecreased([2, 3]), "a rising variant was accepted");
  return "ok";
});

check("monotonicity detects a lost gain", () => {
  assert(monotonicityHeld(["a"], ["a", "b"]).held, "a preserved gain was rejected");
  const lost = monotonicityHeld(["a", "b"], ["a"]);
  assert(!lost.held && lost.reopened === "b", "a lost gain went undetected");
  return "ok";
});

check("five gate predicates are registered", () => {
  const { registry } = createGates({ root: process.cwd(), options: {} });
  const keys = Object.keys(registry);
  assert(keys.length === 5, `expected 5 predicates, found ${keys.length}`);
  for (const key of Object.keys(GATES)) {
    assert(typeof registry[key] === "function", `missing predicate ${key}`);
  }
  return keys.join(" ");
});

check("model registry resolves the configured model", () => {
  const config = loadConfig();
  const { model } = createModelRegistry({ modelId: config.model });
  assert(model.id === config.model, `registry produced ${model.id}`);
  assert(model.api === "openai-responses", `unexpected api ${model.api}`);
  return `${model.id} via ${model.api}`;
});

async function live() {
  const config = loadConfig();
  if (!config.hasApiKey) {
    results.push({ name: "live call", ok: false, detail: `no key at ${config.envPath}` });
    return;
  }

  const { models, model } = createModelRegistry({ modelId: config.model, apiKey: config.apiKey });

  try {
    const context = {
      systemPrompt: "Answer with a single number and nothing else.",
      messages: [{ role: "user", content: "What is 6 multiplied by 7?", timestamp: Date.now() }],
      tools: [],
    };
    const stream = await models.stream(model, context, {});
    let text = "";
    let streamError = null;
    for await (const event of stream) {
      if (event.type === "text_delta" && event.delta) text += event.delta;
      if (event.type === "error") streamError = event;
    }
    if (streamError) throw new Error(JSON.stringify(streamError).slice(0, 400));
    const answer = text.trim();
    assert(answer.length > 0, "the model accepted the request but returned no text");
    results.push({
      name: `live call to ${model.id}`,
      ok: true,
      detail: `returned ${JSON.stringify(answer)}`,
    });
  } catch (err) {
    const catalog = await listAvailableModels(config.apiKey);
    const available = catalog.ok
      ? catalog.ids.filter((id) => id.startsWith("gpt-5")).join(", ")
      : JSON.stringify(catalog.error);
    results.push({
      name: `live call to ${model.id}`,
      ok: false,
      detail: `${err && err.message ? err.message : err}\n      available gpt-5 models: ${available}`,
    });
  }
}

const wantLive = process.argv.includes("--live");
if (wantLive) await live();

let failed = 0;
for (const result of results) {
  if (!result.ok) failed += 1;
  const status = result.ok ? "PASS" : "FAIL";
  process.stdout.write(
    `${status}  ${result.name}${result.detail ? `\n      ${result.detail}` : ""}\n`,
  );
}

process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
if (!wantLive) process.stdout.write("run with --live to make one real API call\n");
process.exit(failed === 0 ? 0 : 1);
