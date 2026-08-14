import { SWEEP_TRIGGERS, routeCondition } from "./method.mjs";

export const TERMINAL_FIXPOINT = "fixpoint";
export const TERMINAL_SURFACE = "surface";

export function variantDecreased(history) {
  if (history.length < 2) return true;
  const previous = history[history.length - 2];
  const current = history[history.length - 1];
  return current < previous;
}

export function monotonicityHeld(previousClosed, currentClosed) {
  for (const id of previousClosed) {
    if (!currentClosed.includes(id)) return { held: false, reopened: id };
  }
  return { held: true, reopened: null };
}

export function detectTriggers(gateResults) {
  const fired = [];
  for (const [key, result] of Object.entries(gateResults)) {
    if (result.ok) continue;
    const trigger = SWEEP_TRIGGERS.find((t) => t.condition === "a gate reopened");
    fired.push({
      condition: "a gate reopened",
      detail: `${result.gate ?? key}: ${result.detail}`,
      route: trigger ? trigger.to : routeCondition("a gate reopened"),
      origin: key,
    });
  }
  return fired;
}

export async function runSweep({ store, evaluateAll, maxSweeps = 8, onSweep = () => {} }) {
  const variantHistory = [];
  let previousClosed = store
    .readConditions()
    .filter((c) => c.status === "closed")
    .map((c) => c.id);

  for (let sweep = 1; sweep <= maxSweeps; sweep += 1) {
    const gateResults = await evaluateAll();
    const fired = detectTriggers(gateResults);

    for (const item of fired) {
      store.openCondition({
        condition: `${item.condition}: ${item.detail}`,
        route: item.route,
        origin: item.origin,
        sweep,
      });
    }

    const variant = store.openConditionCount();
    variantHistory.push(variant);

    const currentClosed = store
      .readConditions()
      .filter((c) => c.status === "closed")
      .map((c) => c.id);
    const monotone = monotonicityHeld(previousClosed, currentClosed);
    previousClosed = currentClosed;

    const changed = fired.length > 0 || !monotone.held;
    store.appendSweep({ sweep, variant, changed, fired: fired.length });
    onSweep({ sweep, variant, changed, fired, monotone });

    if (variant === 0 && !changed) {
      store.appendSweep({ sweep, variant, terminal: TERMINAL_FIXPOINT });
      return {
        terminal: TERMINAL_FIXPOINT,
        sweeps: sweep,
        variantHistory,
        reason: "a sweep changed nothing: no gate reopened, no counterexample, no growth",
      };
    }

    const stalled = store.repeatedWithoutNewInformation();
    if (stalled.length > 0) {
      store.appendSweep({ sweep, variant, terminal: TERMINAL_SURFACE });
      return {
        terminal: TERMINAL_SURFACE,
        sweeps: sweep,
        variantHistory,
        reason: `a condition fired twice with no new information: ${stalled[0].condition}`,
        stalled,
      };
    }

    if (!variantDecreased(variantHistory)) {
      store.appendSweep({ sweep, variant, terminal: TERMINAL_SURFACE });
      return {
        terminal: TERMINAL_SURFACE,
        sweeps: sweep,
        variantHistory,
        reason: `the open-condition count did not fall (${variantHistory.join(" -> ")})`,
      };
    }

    if (!monotone.held) {
      store.appendSweep({ sweep, variant, terminal: TERMINAL_SURFACE });
      return {
        terminal: TERMINAL_SURFACE,
        sweeps: sweep,
        variantHistory,
        reason: `an earlier sweep's gain was lost: ${monotone.reopened}`,
      };
    }
  }

  return {
    terminal: TERMINAL_SURFACE,
    sweeps: maxSweeps,
    variantHistory,
    reason: `the sweep did not converge within ${maxSweeps} sweeps`,
  };
}
