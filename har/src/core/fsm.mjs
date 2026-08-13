/**
 * The gm phase machine.
 *
 * Nine states, twenty-one edges. Transitions are requests: the machine
 * evaluates the requested edge's gate predicates against real state and either
 * advances or refuses with the failing predicates named. A refusal is
 * information, not an exception.
 *
 * Graph and gate assignments mirror AnEntrypoint/gm-config fsm/graph.json.
 */

export const PHASES = Object.freeze([
  "SPECIFY",
  "PROVE",
  "EMIT",
  "STATE",
  "CONC",
  "SEC",
  "RES",
  "DECIDE",
  "COMPLETE",
]);

export const CLOSURE_GATES = Object.freeze([
  "prd-all-closed",
  "mutables-all-resolved",
  "worktree-clean",
  "residual-scan-fired",
  "ci-validated-fresh",
  "browser-witness-coverage",
  "app-loads-witnessed",
  "submodules-clean",
  "claim-audit-clean",
  "no-hedge-language-in-diff",
]);

/** Every legal edge, with the gates guarding it. */
export const EDGES = Object.freeze([
  { from: "SPECIFY", to: "PROVE", gates: [] },
  { from: "PROVE", to: "EMIT", gates: ["mutables-all-resolved"] },
  {
    from: "EMIT",
    to: "STATE",
    gates: [
      "no-synthetic-test-files",
      "no-graphical-symbols-in-diff",
      "no-admit-deferral-markers",
    ],
  },
  { from: "STATE", to: "CONC", gates: ["idempotent-dispatch-replay-safe"] },
  { from: "CONC", to: "SEC", gates: [] },
  { from: "SEC", to: "RES", gates: ["no-secrets-in-diff"] },
  { from: "RES", to: "DECIDE", gates: ["no-unchecked-panics-in-diff"] },
  { from: "DECIDE", to: "COMPLETE", gates: CLOSURE_GATES },

  // Feedback edges: a later stage's discovery routes backward.
  { from: "PROVE", to: "SPECIFY", gates: [] },
  { from: "EMIT", to: "SPECIFY", gates: [] },
  { from: "STATE", to: "EMIT", gates: [] },
  { from: "STATE", to: "SPECIFY", gates: [] },
  { from: "CONC", to: "STATE", gates: [] },
  { from: "CONC", to: "EMIT", gates: [] },
  { from: "SEC", to: "STATE", gates: [] },
  { from: "SEC", to: "EMIT", gates: [] },
  { from: "RES", to: "EMIT", gates: [] },
  { from: "RES", to: "SPECIFY", gates: [] },
  { from: "DECIDE", to: "SPECIFY", gates: [] },
  { from: "DECIDE", to: "PROVE", gates: [] },
  { from: "COMPLETE", to: "COMPLETE", gates: [] },
]);

export function isPhase(value) {
  return PHASES.includes(value);
}

/** The edge from -> to, or null when the transition is not in the graph. */
export function findEdge(from, to) {
  return EDGES.find((e) => e.from === from && e.to === to) ?? null;
}

/** Every phase reachable from `from` in one transition. */
export function successors(from) {
  return EDGES.filter((e) => e.from === from).map((e) => e.to);
}

/** The forward (non-feedback) successor of a phase, or null at COMPLETE. */
export function nextForward(from) {
  const idx = PHASES.indexOf(from);
  if (idx < 0 || idx >= PHASES.length - 1) return null;
  return PHASES[idx + 1];
}

/**
 * Attempt a transition.
 *
 * `evaluateGate(name)` returns `{ ok, detail }` and must not throw; a throwing
 * probe is treated as a failed predicate so a broken check can never wave an
 * edge through.
 */
export async function attemptTransition({ from, to, evaluateGate }) {
  if (!isPhase(from)) {
    return { ok: false, reason: "unknown-source-phase", from, to, failures: [] };
  }
  if (!isPhase(to)) {
    return { ok: false, reason: "unknown-target-phase", from, to, failures: [] };
  }

  const edge = findEdge(from, to);
  if (!edge) {
    return {
      ok: false,
      reason: "illegal-transition",
      from,
      to,
      allowed: successors(from),
      failures: [],
    };
  }

  const failures = [];
  const evaluated = [];
  for (const gate of edge.gates) {
    let result;
    try {
      result = await evaluateGate(gate);
    } catch (err) {
      result = { ok: false, detail: `gate probe threw: ${err?.message ?? err}` };
    }
    const ok = Boolean(result && result.ok);
    evaluated.push({ gate, ok, detail: result?.detail ?? "" });
    if (!ok) failures.push({ gate, detail: result?.detail ?? "" });
  }

  if (failures.length > 0) {
    return { ok: false, reason: "gate-refused", from, to, failures, evaluated };
  }
  return { ok: true, from, to, failures: [], evaluated };
}
