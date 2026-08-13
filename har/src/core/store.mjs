/**
 * On-disk state for the harness: phase, PRD rows, mutables, witness ledger,
 * and markers.
 *
 * Writes are atomic (write to a temp file in the same directory, then rename)
 * so a crash mid-write leaves the previous consistent state rather than a
 * truncated file. The witness ledger is append-only, which is what makes
 * replay-conflict detection possible at all.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const STORE_DIRNAME = ".gm-pi";

const OPEN_PRD_STATUSES = new Set(["pending", "in-progress", "open", "blocked"]);
const OPEN_MUTABLE_STATUSES = new Set(["unknown", "pending", "open"]);

export function storePaths(root) {
  const base = join(root, STORE_DIRNAME);
  return {
    base,
    phase: join(base, "phase.json"),
    prd: join(base, "prd.yml"),
    mutables: join(base, "mutables.yml"),
    witness: join(base, "witness.jsonl"),
    markers: join(base, "markers"),
    residualMarker: join(base, "markers", "residual-scan"),
    ciMarker: join(base, "markers", "ci-validated"),
  };
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

/** Atomic replace: temp file in the same directory, then rename over target. */
function atomicWrite(path, contents) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, path);
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Minimal YAML reader for the row shape this harness writes:
 * a sequence of `- key: value` mappings. Deliberately not a general parser --
 * it reads exactly what the serializer produces, and unparseable input yields
 * an empty list rather than a throw.
 */
export function parseRows(text) {
  const rows = [];
  let current = null;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const startsRow = /^\s*-\s+/.test(rawLine);
    const body = startsRow ? rawLine.replace(/^\s*-\s+/, "") : rawLine.trim();
    const eq = body.indexOf(":");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (startsRow) {
      if (current) rows.push(current);
      current = {};
    }
    if (!current) current = {};
    current[key] = value;
  }
  if (current && Object.keys(current).length > 0) rows.push(current);
  return rows;
}

function serializeRows(rows) {
  if (!rows.length) return "[]\n";
  const lines = [];
  for (const row of rows) {
    const entries = Object.entries(row);
    if (!entries.length) continue;
    entries.forEach(([key, value], i) => {
      const text = String(value ?? "").replace(/"/g, '\\"');
      const prefix = i === 0 ? "- " : "  ";
      lines.push(`${prefix}${key}: "${text}"`);
    });
  }
  return `${lines.join("\n")}\n`;
}

export class Store {
  constructor(root) {
    this.root = root;
    this.paths = storePaths(root);
  }

  init() {
    ensureDir(this.paths.base);
    ensureDir(this.paths.markers);
    if (!existsSync(this.paths.phase)) this.setPhase("SPECIFY", "init");
    if (!existsSync(this.paths.prd)) atomicWrite(this.paths.prd, "[]\n");
    if (!existsSync(this.paths.mutables)) atomicWrite(this.paths.mutables, "[]\n");
    return this;
  }

  // --- phase -------------------------------------------------------------

  getPhase() {
    const state = readJson(this.paths.phase, null);
    return state && typeof state.phase === "string" ? state.phase : "SPECIFY";
  }

  getPhaseState() {
    return readJson(this.paths.phase, { phase: "SPECIFY", history: [] });
  }

  setPhase(phase, note = "") {
    const prev = readJson(this.paths.phase, { phase: null, history: [] });
    const history = Array.isArray(prev.history) ? prev.history : [];
    history.push({ from: prev.phase ?? null, to: phase, ts: Date.now(), note });
    atomicWrite(this.paths.phase, `${JSON.stringify({ phase, history }, null, 2)}\n`);
    return phase;
  }

  // --- rows --------------------------------------------------------------

  readPrd() {
    return existsSync(this.paths.prd) ? parseRows(readFileSync(this.paths.prd, "utf8")) : [];
  }

  writePrd(rows) {
    atomicWrite(this.paths.prd, serializeRows(rows));
  }

  addPrdRow({ id, text, status = "pending" }) {
    const rows = this.readPrd();
    const existing = rows.findIndex((r) => r.id === id);
    const row = { id, text, status };
    if (existing >= 0) rows[existing] = { ...rows[existing], ...row };
    else rows.push(row);
    this.writePrd(rows);
    return row;
  }

  resolvePrdRow(id, note = "") {
    const rows = this.readPrd();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) return { ok: false, reason: "unknown-id", id };
    rows[idx] = { ...rows[idx], status: "completed", note };
    this.writePrd(rows);
    return { ok: true, id };
  }

  openPrdRows() {
    return this.readPrd().filter((r) => OPEN_PRD_STATUSES.has(String(r.status ?? "pending")));
  }

  readMutables() {
    return existsSync(this.paths.mutables)
      ? parseRows(readFileSync(this.paths.mutables, "utf8"))
      : [];
  }

  writeMutables(rows) {
    atomicWrite(this.paths.mutables, serializeRows(rows));
  }

  addMutable({ id, text, status = "pending" }) {
    const rows = this.readMutables();
    const idx = rows.findIndex((r) => r.id === id);
    const row = { id, text, status };
    if (idx >= 0) rows[idx] = { ...rows[idx], ...row };
    else rows.push(row);
    this.writeMutables(rows);
    return row;
  }

  resolveMutable(id, evidence = "") {
    const rows = this.readMutables();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) return { ok: false, reason: "unknown-id", id };
    rows[idx] = { ...rows[idx], status: "resolved", evidence };
    this.writeMutables(rows);
    return { ok: true, id };
  }

  openMutables() {
    return this.readMutables().filter((r) =>
      OPEN_MUTABLE_STATUSES.has(String(r.status ?? "pending")),
    );
  }

  // --- witness ledger ----------------------------------------------------

  /**
   * Append one audit tuple. Append-only: records are never rewritten, which is
   * what lets replay-conflict detection see two outcomes for one (id, hash).
   */
  appendWitness({ id, tool, surface = null, input = "", output = "", outcome = "ok" }) {
    ensureDir(this.paths.base);
    const hash = createHash("sha256")
      .update(`${tool} ${surface ?? ""} ${input} ${output}`)
      .digest("hex");
    const record = { id, tool, surface, hash, ts: Date.now(), outcome };
    appendFileSync(this.paths.witness, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  readWitnesses() {
    if (!existsSync(this.paths.witness)) return [];
    const out = [];
    for (const line of readFileSync(this.paths.witness, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A corrupt line is skipped; the rest of the ledger stays readable.
      }
    }
    return out;
  }

  // --- markers -----------------------------------------------------------

  fireResidualScan(detail = "residual scan fired") {
    ensureDir(this.paths.markers);
    atomicWrite(this.paths.residualMarker, `${detail}\n`);
  }

  residualScanFired() {
    if (!existsSync(this.paths.residualMarker)) return false;
    try {
      return statSync(this.paths.residualMarker).size > 0;
    } catch {
      return false;
    }
  }

  markCiValidated(headSha) {
    ensureDir(this.paths.markers);
    atomicWrite(this.paths.ciMarker, `${JSON.stringify({ head_sha: headSha })}\n`);
  }

  readCiMarker() {
    return readJson(this.paths.ciMarker, null);
  }
}
