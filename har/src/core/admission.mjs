/**
 * The three-layer admission filter.
 *
 *   candidate -> [L1 witness] -> [L2 single-writer] -> [L3 direction] -> execute
 *
 * Layers run in order; the first rejection stops evaluation. The filter fails
 * closed: an internal error is a rejection, never a pass-through, because an
 * admission check that cannot decide must not admit.
 */

import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

/** Tools that mutate state, and how each derives its written surface. */
const MUTATING = {
  write_file: (args) => args?.path,
  exec: (args) => args?.cwd ?? ".",
};

/** Tool names that assert completion and therefore require prior evidence. */
const CLAIM_TOOLS = new Set(["complete", "resolve", "prd_resolve"]);

export function isMutating(toolName) {
  return Object.hasOwn(MUTATING, toolName);
}

/** Normalize a surface to an absolute path so two spellings cannot race. */
export function normalizeSurface(root, raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const text = String(raw);
  return isAbsolute(text) ? resolve(text) : resolve(root, text);
}

export function surfaceFor(root, toolName, args) {
  const derive = MUTATING[toolName];
  if (!derive) return null;
  return normalizeSurface(root, derive(args));
}

function hashOf(toolName, surface, args) {
  let payload;
  try {
    payload = JSON.stringify(args ?? {});
  } catch {
    payload = String(args);
  }
  return createHash("sha256").update(`${toolName}|${surface ?? ""}|${payload}`).digest("hex");
}

function reject(layer, reason) {
  return { admit: false, layer, reason };
}
const ADMIT = { admit: true, layer: null, reason: "" };

/**
 * Create an admission filter bound to a repository root and store.
 *
 * `directionWindow` is how many recent dispatches the L3 classifier considers,
 * `flatLimit` how many consecutive no-op mutations count as dead motion, and
 * `repeatLimit` how many identical dispatches count as thrash.
 */
export function createAdmissionFilter({
  root,
  store,
  directionWindow = 12,
  flatLimit = 5,
  repeatLimit = 3,
}) {
  /** Surfaces currently claimed by an in-flight writer: surface -> callId. */
  const claims = new Map();
  /** Dispatches deferred by L2 backpressure, in arrival order. */
  const deferred = [];
  /** Recent dispatches for the L3 direction classifier. */
  const recent = [];

  function classify() {
    if (recent.length < 3) return "convergent";

    const window = recent.slice(-directionWindow);

    const counts = new Map();
    for (const r of window) {
      const key = `${r.surface ?? ""}|${r.hash}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const maxRepeat = Math.max(...counts.values());
    if (maxRepeat >= repeatLimit) return "chaotic";

    let flatRun = 0;
    for (let i = window.length - 1; i >= 0; i -= 1) {
      if (window[i].noop) flatRun += 1;
      else break;
    }
    if (flatRun >= flatLimit) return "flat";

    return "convergent";
  }

  /**
   * L1 -- witness. A claim of completion requires prior evidence in the
   * ledger. Non-claim calls pass: they are how evidence gets produced.
   */
  function layer1({ toolName, args }) {
    if (!CLAIM_TOOLS.has(toolName)) return ADMIT;
    const target = args?.id ?? args?.target ?? null;
    if (!target) return reject("L1", "completion claim names no target");
    const witnessed = store.readWitnesses();
    const hasEvidence = witnessed.some(
      (w) =>
        w.outcome === "ok" &&
        (w.id === target || String(w.surface ?? "").includes(String(target))),
    );
    return hasEvidence
      ? ADMIT
      : reject("L1", `completion claim for "${target}" has no witness in the ledger`);
  }

  /** L2 -- single-writer. Capacity 1 per surface; contention defers. */
  function layer2({ callId, toolName, args }) {
    if (!isMutating(toolName)) return ADMIT;
    const surface = surfaceFor(root, toolName, args);
    if (!surface) return reject("L2", `${toolName} names no writable surface`);
    const holder = claims.get(surface);
    if (holder && holder !== callId) {
      deferred.push({ callId, toolName, surface, ts: Date.now() });
      return reject("L2", `surface already claimed by in-flight writer ${holder}; deferred`);
    }
    return ADMIT;
  }

  /** L3 -- direction. Motion that does not reduce distance is refused. */
  function layer3() {
    const trajectory = classify();
    if (trajectory === "convergent") return ADMIT;
    return reject(
      "L3",
      `trajectory is ${trajectory}; re-orient before dispatching more of the same motion`,
    );
  }

  /**
   * Run all layers. Never throws -- an internal error is a rejection.
   * On admission the surface is claimed and must be released via `release`.
   */
  function admit({ callId, toolName, args }) {
    try {
      for (const layer of [layer1, layer2, layer3]) {
        const verdict = layer({ callId, toolName, args });
        if (!verdict.admit) return verdict;
      }
      const surface = surfaceFor(root, toolName, args);
      if (surface) claims.set(surface, callId);
      recent.push({
        callId,
        surface,
        hash: hashOf(toolName, surface, args),
        ts: Date.now(),
        noop: false,
      });
      return { admit: true, layer: null, reason: "", surface };
    } catch (err) {
      // Fail closed.
      return reject("filter", `admission check failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Release a surface claim once the tool result is finalized, and record
   * whether the dispatch actually changed anything (feeds the L3 classifier).
   */
  function release({ callId, noop = false }) {
    for (const [surface, holder] of claims.entries()) {
      if (holder === callId) claims.delete(surface);
    }
    const entry = recent.find((r) => r.callId === callId);
    if (entry) entry.noop = Boolean(noop);
    const idx = deferred.findIndex((d) => d.callId === callId);
    if (idx >= 0) deferred.splice(idx, 1);
  }

  function state() {
    return {
      claims: Object.fromEntries(claims),
      deferred: deferred.map((d) => ({ callId: d.callId, surface: d.surface })),
      trajectory: classify(),
      dispatches: recent.length,
    };
  }

  return {
    admit,
    release,
    state,
    classify,
    isMutating,
    surfaceFor: (toolName, args) => surfaceFor(root, toolName, args),
  };
}
