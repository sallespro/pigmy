import { runAgentLoop } from "@earendil-works/pi-agent-core";

import { createGates } from "./gates.mjs";
import { PHASES, SPINE, gateGuarding, nextPhase, routeCondition } from "./method.mjs";
import { Store } from "./store.mjs";
import { runSweep } from "./sweep.mjs";
import { runIndependentVerifier } from "./verifier.mjs";
import { createModelRegistry } from "../model/model.mjs";
import { createTools } from "../tools/index.mjs";

function buildSystemPrompt({ phase, workspace, task }) {
  const spec = PHASES[phase] ?? PHASES.SHAPE;
  return [
    "You build software under the lean method. The contract is the artifact.",
    "",
    "Enforced mechanically, not by your judgment:",
    "- A comment that restates the code is refused. Put the meaning in the name, the type or the signature.",
    "- A rule the type cannot express becomes a precondition in the signature.",
    "- No test files. Verification is properties checked by an agent that has not read your implementation.",
    "- A change that grows the artifact needs a reason on the record; superseded paths are deleted, not guarded.",
    "",
    `Workspace: ${workspace}`,
    `Phase ${spec.id} ${spec.title}: ${spec.purpose}`,
    `Anchors: ${spec.anchors.slice(0, 6).join("; ")}`,
    "",
    `Task: ${task}`,
    "",
    "Do real work with the tools. State what you verified and the output that showed it.",
  ].join("\n");
}

export function createHarness({ root, config, logger = () => {} }) {
  const store = new Store(root).init();

  const redact = (value) => {
    let text = typeof value === "string" ? value : String(value);
    for (const secret of config.secrets ?? []) {
      if (secret && secret.length >= 8) text = text.split(secret).join("[REDACTED]");
    }
    return text.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]");
  };

  const tools = createTools({ root, config, redact });

  const gateOptions = {
    livePlans: 1,
    verifierReport: null,
    growthReason: null,
    commitMessage: "",
  };
  const { evaluateGate, registry } = createGates({ root, options: gateOptions });

  const steering = [];

  async function evaluateAll() {
    const out = {};
    for (const key of Object.keys(registry)) {
      out[key] = await evaluateGate(key);
    }
    return out;
  }

  function openCondition(condition, origin) {
    const route = routeCondition(condition) ?? "SHAPE";
    const row = store.openCondition({ condition, route, origin });
    steering.push({
      role: "user",
      content: `Condition fired: ${condition}. This routes back to ${route}. Address it there.`,
      timestamp: Date.now(),
    });
    logger({ type: "condition", condition, route, repeated: row.repeated });
    return row;
  }

  async function transition(to, note = "") {
    const from = store.getPhase();
    const gate = gateGuarding(from, to);
    if (!gate) {
      store.setPhase(to, note);
      logger({ type: "transition", from, to, gate: null });
      return { ok: true, gate: null };
    }

    const verdict = await evaluateGate(gate.key);
    if (!verdict.ok) {
      logger({ type: "transition_refused", from, to, gate: gate.name, detail: verdict.detail });
      openCondition(`a gate reopened: ${gate.name} -- ${verdict.detail}`, gate.key);
      return { ok: false, gate: gate.name, detail: verdict.detail };
    }

    store.setPhase(to, note);
    logger({ type: "transition", from, to, gate: gate.name });
    return { ok: true, gate: gate.name, detail: verdict.detail };
  }

  async function walk() {
    const steps = [];
    for (;;) {
      const from = store.getPhase();
      const to = nextPhase(from);
      if (!to) break;
      const result = await transition(to, "spine walk");
      steps.push({ from, to, ...result });
      if (!result.ok) break;
    }
    return steps;
  }

  async function verify({ contract, signal }) {
    const report = await runIndependentVerifier({ contract, root, config, redact, signal });
    gateOptions.verifierReport = report;
    logger({
      type: "verifier",
      verdict: report.verdict,
      sawImplementation: report.sawImplementation,
    });
    return report;
  }

  async function sweep({ onSweep } = {}) {
    return runSweep({
      store,
      evaluateAll,
      maxSweeps: config.maxSweeps,
      onSweep: (entry) => {
        logger({ type: "sweep", sweep: entry.sweep, variant: entry.variant, fired: entry.fired.length });
        if (onSweep) onSweep(entry);
      },
    });
  }

  async function run({ task, modelId = config.model, maxTurns = config.maxTurns, signal }) {
    const { models, model } = createModelRegistry({ modelId, apiKey: config.apiKey });

    let turns = 0;
    const blocked = [];
    const events = [];

    const context = {
      systemPrompt: buildSystemPrompt({ phase: store.getPhase(), workspace: root, task }),
      messages: [],
      tools,
    };

    const loopConfig = {
      model,
      convertToLlm: (messages) =>
        messages.filter(
          (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
        ),
      toolExecution: "sequential",

      async beforeToolCall(ctx) {
        try {
          const path = String((ctx.args && ctx.args.path) ?? "");
          if (/\.(test|spec)\.[a-z]+$/i.test(path) || /(^|\/)(__tests__|tests?)\//.test(path)) {
            blocked.push({ tool: ctx.toolCall.name, reason: "test file" });
            return {
              block: true,
              reason:
                "no test files: verification is properties checked by an agent that has not read the implementation",
            };
          }
          return undefined;
        } catch (err) {
          return { block: true, reason: `admission failed: ${redact(err && err.message)}` };
        }
      },

      async afterToolCall(ctx) {
        try {
          const details = (ctx.result && ctx.result.details) ?? {};
          const output = ((ctx.result && ctx.result.content) ?? [])
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          store.appendWitness({
            id: ctx.toolCall.id,
            tool: ctx.toolCall.name,
            surface: details.path ?? details.cwd ?? null,
            outcome: ctx.isError ? "error" : "ok",
            noop: Boolean(details.noop),
            bytes: output.length,
          });
        } catch (err) {
          logger({ type: "witness_failed", error: redact(err && err.message) });
        }
        return undefined;
      },

      shouldStopAfterTurn() {
        try {
          turns += 1;
          logger({ type: "turn", n: turns });
          return turns >= maxTurns;
        } catch {
          return true;
        }
      },

      async getSteeringMessages() {
        try {
          if (steering.length === 0) return [];
          return steering.splice(0, steering.length);
        } catch {
          return [];
        }
      },
    };

    const prompts = [{ role: "user", content: task, timestamp: Date.now() }];

    const emit = (event) => {
      events.push(event.type);
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
        logger({ type: event.type, tool: event.toolName });
      }
    };

    const messages = await runAgentLoop(prompts, context, loopConfig, emit, signal, (m, c, o) =>
      models.stream(m, c, o),
    );

    return {
      messages: messages ?? [],
      turns,
      blocked,
      events,
      witnesses: store.readWitnesses(),
      phase: store.getPhase(),
      openConditions: store.openConditionCount(),
    };
  }

  return {
    store,
    tools,
    gateOptions,
    evaluateGate,
    evaluateAll,
    openCondition,
    transition,
    walk,
    verify,
    sweep,
    run,
    phases: SPINE,
  };
}
