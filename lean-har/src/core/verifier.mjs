import { runAgentLoop } from "@earendil-works/pi-agent-core";

import { createModelRegistry } from "../model/model.mjs";
import { createTools } from "../tools/index.mjs";

const VERIFIER_BRIEF = [
  "You verify a contract you did not write and whose implementation you have not seen.",
  "",
  "You receive types, names and signatures. You never receive the implementation source,",
  "and you must not read it: opening the implementing file makes your assertions a mirror",
  "of the code rather than a check on it.",
  "",
  "State properties and invariants the contract must satisfy, then look for a call sequence,",
  "boundary value or metamorphic relation that falsifies one. Report each property with the",
  "verdict you reached and the evidence that produced it.",
  "",
  "Close with a final line of exactly HOLDS or FALSIFIED.",
].join("\n");

export function contractLeaksImplementation(contract, implementationPaths = []) {
  const text = String(contract);
  return implementationPaths.some((path) => text.includes(path));
}

export async function runIndependentVerifier({
  contract,
  root,
  config,
  redact = (s) => s,
  signal,
  maxTurns = 12,
}) {
  const { models, model } = createModelRegistry({
    modelId: config.model,
    apiKey: config.apiKey,
  });

  const tools = createTools({ root, config, redact, readOnly: true });

  let turns = 0;
  let sawImplementation = false;
  const inspected = [];

  const context = { systemPrompt: VERIFIER_BRIEF, messages: [], tools };

  const loopConfig = {
    model,
    convertToLlm: (messages) =>
      messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
    toolExecution: "sequential",

    async beforeToolCall(ctx) {
      try {
        const requested = String((ctx.args && ctx.args.path) ?? "");
        const forbidden = (config.implementationPaths ?? []).some((p) => requested.includes(p));
        if (forbidden) {
          sawImplementation = true;
          return {
            block: true,
            reason: "reading the implementation would make this verification a mirror of the code",
          };
        }
        inspected.push(requested);
        return undefined;
      } catch {
        return { block: true, reason: "verifier admission failed" };
      }
    },

    shouldStopAfterTurn() {
      turns += 1;
      return turns >= maxTurns;
    },

    async getSteeringMessages() {
      return [];
    },
  };

  const prompts = [
    { role: "user", content: `Contract under verification:\n\n${contract}`, timestamp: Date.now() },
  ];

  const messages = await runAgentLoop(
    prompts,
    context,
    loopConfig,
    () => {},
    signal,
    (m, ctx, options) => models.stream(m, ctx, options),
  );

  const transcript = (messages ?? [])
    .filter((m) => m.role === "assistant")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");

  const falsified = /\bFALSIFIED\b/.test(transcript);
  const holds = /\bHOLDS\b/.test(transcript);

  return {
    ok: holds && !falsified,
    sawImplementation,
    verdict: falsified ? "FALSIFIED" : holds ? "HOLDS" : "INCONCLUSIVE",
    properties: transcript
      .split("\n")
      .filter((line) => /^\s*[-*\d]/.test(line))
      .map((line) => line.trim()),
    inspected,
    transcript: redact(transcript),
    turns,
  };
}
