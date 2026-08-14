import { execFileSync } from "node:child_process";

import { GATES } from "./method.mjs";

const COMMENT_PATTERNS = [/^\+\s*\/\//, /^\+\s*\/\*/, /^\+\s*\*\s/, /^\+\s*#(?!!)/];

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return err && typeof err.stdout === "string" ? err.stdout : "";
  }
}

const PROSE_SUFFIXES = [".md", ".markdown", ".txt", ".rst", ".adoc"];

function addedLines(diff) {
  return diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
}

function addedCodeLines(diff) {
  const out = [];
  let inProseFile = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "").trim();
      inProseFile = PROSE_SUFFIXES.some((suffix) => path.toLowerCase().endsWith(suffix));
      continue;
    }
    if (inProseFile) continue;
    if (line.startsWith("+")) out.push(line);
  }
  return out;
}

function removedLines(diff) {
  return diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"));
}

export function createGates({ root, options = {} }) {
  const diffOf = () => git(root, ["diff", "HEAD", "--unified=0"]);

  const registry = {
    ONE_TASK_IN_FLIGHT: async () => {
      const live = options.livePlans ?? 1;
      if (live > 1) {
        return {
          ok: false,
          detail: `${live} plans are live; finish or abandon before starting another`,
          evidence: { livePlans: live },
        };
      }
      return { ok: true, detail: "one task in flight", evidence: { livePlans: live } };
    },

    CONTRACT_ONLY_DURABLE: async () => {
      const diff = diffOf();
      const offenders = addedCodeLines(diff).filter((line) =>
        COMMENT_PATTERNS.some((pattern) => pattern.test(line)),
      );
      if (offenders.length > 0) {
        return {
          ok: false,
          detail: `${offenders.length} added comment lines restate the code in prose; move the meaning into names, types or signatures`,
          evidence: { offenders: offenders.slice(0, 5) },
        };
      }
      return { ok: true, detail: "no prose restates the code", evidence: { offenders: [] } };
    },

    VERIFIER_BLIND: async () => {
      const report = options.verifierReport ?? null;
      if (!report) {
        return {
          ok: false,
          detail: "no independent verifier report; the contract has not been checked",
          evidence: {},
        };
      }
      if (report.sawImplementation) {
        return {
          ok: false,
          detail: "the verifier read the implementation and inherits its assumptions",
          evidence: { sawImplementation: true },
        };
      }
      return {
        ok: true,
        detail: "verifier worked from the contract in a separate context",
        evidence: { properties: (report.properties ?? []).length },
      };
    },

    NET_NEGATIVE: async () => {
      const diff = diffOf();
      const added = addedLines(diff).length;
      const removed = removedLines(diff).length;
      const net = added - removed;
      if (net > 0 && !options.growthReason) {
        return {
          ok: false,
          detail: `diff is net +${net} lines with no reason on the record; delete the superseded path or state why it grew`,
          evidence: { added, removed, net },
        };
      }
      return {
        ok: true,
        detail:
          net > 0 ? `net +${net} lines, reason recorded: ${options.growthReason}` : `net ${net} lines`,
        evidence: { added, removed, net, growthReason: options.growthReason ?? null },
      };
    },

    CONTRACT_SATISFIED: async () => {
      const report = options.verifierReport ?? null;
      const propertiesHold = Boolean(report && report.ok);
      const message = options.commitMessage ?? "";
      const carriesWhy = message.trim().split("\n").length > 1 || message.length > 50;
      if (!propertiesHold) {
        return {
          ok: false,
          detail: "properties do not hold; the contract is not satisfied",
          evidence: { report },
        };
      }
      if (!carriesWhy) {
        return {
          ok: false,
          detail: "the commit message does not carry the reason the contract changed",
          evidence: { message },
        };
      }
      return { ok: true, detail: "contract satisfied and recorded", evidence: { message } };
    },
  };

  async function evaluateGate(key) {
    const predicate = registry[key];
    if (!predicate) {
      return { ok: false, detail: `unknown gate predicate: ${key}`, unknown: true, evidence: {} };
    }
    try {
      const result = await predicate();
      return { gate: GATES[key] ? GATES[key].name : key, ...result };
    } catch (err) {
      return {
        gate: GATES[key] ? GATES[key].name : key,
        ok: false,
        detail: `gate evaluation failed: ${err && err.message ? err.message : err}`,
        evidence: {},
      };
    }
  }

  return { evaluateGate, registry };
}
