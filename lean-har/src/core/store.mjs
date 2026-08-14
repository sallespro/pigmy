import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { SPINE } from "./method.mjs";

const STATE_DIR = ".lean";

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return out;
}

export class Store {
  constructor(root) {
    this.root = resolve(root);
    this.dir = join(this.root, STATE_DIR);
    this.phasePath = join(this.dir, "phase.json");
    this.conditionsPath = join(this.dir, "conditions.json");
    this.sweepPath = join(this.dir, "sweep-log.jsonl");
    this.witnessPath = join(this.dir, "witness.jsonl");
  }

  init() {
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.phasePath)) this.setPhase(SPINE[0], "init");
    if (!existsSync(this.conditionsPath)) writeFileSync(this.conditionsPath, "[]", "utf8");
    return this;
  }

  getPhase() {
    return readJson(this.phasePath, { phase: SPINE[0] }).phase;
  }

  setPhase(phase, note = "") {
    writeFileSync(this.phasePath, JSON.stringify({ phase, note, ts: Date.now() }, null, 2), "utf8");
    return phase;
  }

  readConditions() {
    return readJson(this.conditionsPath, []);
  }

  openCondition({ condition, route, origin = "", sweep = 0 }) {
    const conditions = this.readConditions();
    const id = slug(condition);
    const existing = conditions.find((c) => c.id === id && c.status === "open");
    if (existing) {
      const seen = new Set(existing.sweeps ?? []);
      const repeated = seen.size > 0 && !seen.has(sweep);
      seen.add(sweep);
      existing.sweeps = [...seen];
      existing.fired = existing.sweeps.length;
      existing.lastFiredTs = Date.now();
      writeFileSync(this.conditionsPath, JSON.stringify(conditions, null, 2), "utf8");
      return { ...existing, repeated };
    }
    const row = {
      id,
      condition,
      route,
      origin,
      status: "open",
      fired: 1,
      sweeps: [sweep],
      openedTs: Date.now(),
      lastFiredTs: Date.now(),
    };
    conditions.push(row);
    writeFileSync(this.conditionsPath, JSON.stringify(conditions, null, 2), "utf8");
    return { ...row, repeated: false };
  }

  closeCondition(id, reason = "") {
    const conditions = this.readConditions();
    const row = conditions.find((c) => c.id === id);
    if (!row) return null;
    row.status = "closed";
    row.reason = reason;
    row.closedTs = Date.now();
    writeFileSync(this.conditionsPath, JSON.stringify(conditions, null, 2), "utf8");
    return row;
  }

  openConditionCount() {
    return this.readConditions().filter((c) => c.status === "open").length;
  }

  repeatedWithoutNewInformation() {
    return this.readConditions().filter(
      (c) => c.status === "open" && (c.sweeps ?? []).filter((s) => s > 0).length >= 2,
    );
  }

  appendSweep(entry) {
    appendFileSync(this.sweepPath, `${JSON.stringify({ ...entry, ts: Date.now() })}\n`, "utf8");
  }

  readSweeps() {
    return readJsonl(this.sweepPath);
  }

  appendWitness(entry) {
    appendFileSync(this.witnessPath, `${JSON.stringify({ ...entry, ts: Date.now() })}\n`, "utf8");
  }

  readWitnesses() {
    return readJsonl(this.witnessPath);
  }
}
