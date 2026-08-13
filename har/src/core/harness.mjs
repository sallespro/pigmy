/**
 * The join: a pi agent loop governed by gm's discipline.
 *
 * pi supplies the runtime and the hook seams. This module attaches gm to them:
 *
 *   beforeToolCall      -> admission filter (L1/L2/L3); a block means the tool
 *                          never runs
 *   afterToolCall       -> witness ledger; every executed dispatch is recorded
 *   shouldStopAfterTurn -> continuation invariant plus a runaway ceiling
 *   getSteeringMessages -> gate refusals routed back to the model as feedback
 *
 * pi's contract requires hooks not to throw: a throwing hook interrupts the
 * loop without a normal event sequence. Every hook here is total -- it catches
 * internally and returns a safe fallback.
 */

import { runAgentLoop } from "@earendil-works/pi-agent-core";

import { createAdmissionFilter } from "./admission.mjs";
import { createGates } from "./gates.mjs";
import { attemptTransition, nextForward, PHASES } from "./fsm.mjs";
import { Store } from "./store.mjs";
import { createTools } from "../tools/index.mjs";
import { createModelRegistry } from "../model/model.mjs";

const PHASE_GUIDANCE = {
  SPECIFY: "Enumerate the work. Every noun the request touches gets its own requirement.",
  PROVE: "Discharge each proof obligation by running real code and reading real output.",
  EMIT: "Write the source. No placeholder markers, no synthetic test files.",
  STATE: "Audit totality, ownership, and idempotency of what you emitted.",
  CONC: "Audit ordering and disjointness: what may run at once, and what must not.",
  SEC: "Audit secrets, trust boundaries, and injection surfaces.",
  RES: "Audit the exception model: every raised error handled or explicitly propagated.",
  DECIDE: "Verify adversarially by execution, then close.",
  COMPLETE: "Work is closed.",
};

function buildSystemPrompt({ phase, workspace, task }) {
  return [
    "You are an agent operating under gm admission discipline.",
    "",
    "Rules enforced mechanically, not by your judgment:",
    "- A claim without a witness does not exist. To assert something works, run it and read the output.",
    "- Mutations pass an admission filter. A blocked call explains why; adapt rather than retry identically.",
    "- Repeating an identical dispatch, or producing no observable change, is refused as dead motion.",
    "- One writer per file at a time.",
    "",
    `Workspace: ${workspace}`,
    `Current phase: ${phase} -- ${PHASE_GUIDANCE[phase] ?? ""}`,
    "",
    `Task: ${task}`,
    "",
    "Use the tools to do real work. When done, state what you verified and how.",
  ].join("\n");
}

/**
 * Create a harness bound to a workspace.
 *
 * `root` is the repository the gates inspect and the tools operate in.
 */
export function createHarness({ root, config, logger = () => {} }) {
  const store = new Store(root).init();
  const admission = createAdmissionFilter({ root, store });

  const redact = (value) => {
    let text = typeof value === "string" ? value : String(value);
    for (const secret of config.secrets ?? []) {
      if (secret && secret.length >= 8) text = text.split(secret).join("[REDACTED]");
    }
    return text.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]");
  };

  const tools = createTools({ root, config, redact });
  const gateOptions = { requiresApp: false, clientEdits: [], completionClaims: [] };
  const { evaluateGate, registry } = createGates({ root, store, options: gateOptions });

  /** Pending gate refusals to feed back into the conversation. */
  const steering = [];

  /**
   * Request a phase transition. A refusal becomes a steering message so the
   * agent learns which state it must reach instead of being silently stuck.
   */
  async function transition(to, note = "") {
    const from = store.getPhase();
    const result = await attemptTransition({ from, to, evaluateGate });
    if (result.ok) {
      store.setPhase(to, note);
      logger({ type: "transition", from, to });
    } else {
      logger({ type: "transition_refused", from, to, ...result });
      const detail =
        result.reason === "gate-refused"
          ? result.failures.map((f) => `${f.gate}: ${f.detail}`).join("; ")
          : `${result.reason}${result.allowed ? ` (allowed: ${result.allowed.join(", ")})` : ""}`;
      steering.push({
        role: "user",
        content: `Phase transition ${from} -> ${to} refused. ${detail}`,
        timestamp: Date.now(),
      });
    }
    return result;
  }

  /** Advance along the forward chain as far as the gates permit. */
  async function advanceAsFarAsPossible() {
    const walked = [];
    for (;;) {
      const from = store.getPhase();
      const to = nextForward(from);
      if (!to) break;
      const result = await transition(to, "forward walk");
      walked.push({ from, to, ok: result.ok, failures: result.failures ?? [] });
      if (!result.ok) break;
    }
    return walked;
  }

  /** Evaluate every gate, for reporting. */
  async function evaluateAll() {
    const out = {};
    for (const name of Object.keys(registry)) {
      out[name] = await evaluateGate(name);
    }
    return out;
  }

  /**
   * Run the agent against a task.
   *
   * Returns the transcript plus the admission and witness state produced, so a
   * caller can inspect what actually happened instead of trusting a summary.
   */
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

      // pi requires this: map the transcript to provider-compatible messages.
      convertToLlm: (messages) =>
        messages.filter(
          (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
        ),

      toolExecution: "sequential",

      /** L1/L2/L3. A rejection blocks execution and explains itself. */
      async beforeToolCall(ctx) {
        try {
          const verdict = admission.admit({
            callId: ctx.toolCall.id,
            toolName: ctx.toolCall.name,
            args: ctx.args,
          });
          if (!verdict.admit) {
            blocked.push({ tool: ctx.toolCall.name, layer: verdict.layer, reason: verdict.reason });
            logger({ type: "admission_blocked", tool: ctx.toolCall.name, ...verdict });
            return { block: true, reason: `[${verdict.layer}] ${verdict.reason}` };
          }
          logger({ type: "admission_admitted", tool: ctx.toolCall.name, surface: verdict.surface });
          return undefined;
        } catch (err) {
          // Fail closed: a check that cannot decide must not admit.
          return { block: true, reason: `admission failed: ${redact(err?.message ?? err)}` };
        }
      },

      /** Witness every executed dispatch, then release its surface claim. */
      async afterToolCall(ctx) {
        try {
          const details = ctx.result?.details ?? {};
          const output = (ctx.result?.content ?? [])
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          store.appendWitness({
            id: ctx.toolCall.id,
            tool: ctx.toolCall.name,
            surface: details.path ?? details.cwd ?? null,
            input: JSON.stringify(ctx.args ?? {}),
            output,
            outcome: ctx.isError ? "error" : "ok",
          });
          admission.release({ callId: ctx.toolCall.id, noop: Boolean(details.noop) });
          logger({
            type: "witness",
            tool: ctx.toolCall.name,
            outcome: ctx.isError ? "error" : "ok",
            noop: Boolean(details.noop),
          });
        } catch (err) {
          logger({ type: "witness_failed", error: redact(err?.message ?? err) });
        }
        return undefined;
      },

      /** Continuation invariant, bounded by a runaway-loop ceiling. */
      shouldStopAfterTurn() {
        try {
          turns += 1;
          logger({ type: "turn", n: turns });
          return turns >= maxTurns;
        } catch {
          return true;
        }
      },

      /** Route gate refusals back into the conversation. */
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

    const streamFn = (m, ctx, options) => models.stream(m, ctx, options);

    const messages = await runAgentLoop(prompts, context, loopConfig, emit, signal, streamFn);

    return {
      messages: messages ?? [],
      turns,
      blocked,
      events,
      admission: admission.state(),
      witnesses: store.readWitnesses(),
      phase: store.getPhase(),
    };
  }

  return {
    store,
    admission,
    tools,
    evaluateGate,
    evaluateAll,
    transition,
    advanceAsFarAsPossible,
    run,
    phases: PHASES,
  };
}
