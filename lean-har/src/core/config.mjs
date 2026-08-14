import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const HARNESS_ROOT = resolve(HERE, "..", "..");
export const REPO_ROOT = resolve(HARNESS_ROOT, "..");
export const DEFAULT_ENV_PATH = join(REPO_ROOT, "lean", ".env");

const DEFAULTS = {
  model: "gpt-5.6-luna",
  execTimeoutMs: 120_000,
  maxTurns: 40,
  maxOutputBytes: 64_000,
  maxSweeps: 8,
};

export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch (err) {
    return { __readError: String(err && err.message ? err.message : err) };
  }
}

function positiveInt(raw, fallback) {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig({ envPath = DEFAULT_ENV_PATH, env = process.env, root } = {}) {
  const fromFile = readEnvFile(envPath);
  const merged = { ...fromFile, ...env };

  const apiKey = merged.OPENAI_API_KEY ?? "";
  const secrets = [apiKey].filter((s) => typeof s === "string" && s.length >= 8);

  return {
    envPath,
    apiKey,
    hasApiKey: apiKey.length > 0,
    envReadError: fromFile.__readError ?? null,
    root: resolve(root ?? merged.LEAN_HAR_ROOT ?? REPO_ROOT),
    model: merged.LEAN_HAR_MODEL || DEFAULTS.model,
    execTimeoutMs: positiveInt(merged.LEAN_HAR_EXEC_TIMEOUT_MS, DEFAULTS.execTimeoutMs),
    maxTurns: positiveInt(merged.LEAN_HAR_MAX_TURNS, DEFAULTS.maxTurns),
    maxOutputBytes: positiveInt(merged.LEAN_HAR_MAX_OUTPUT_BYTES, DEFAULTS.maxOutputBytes),
    maxSweeps: positiveInt(merged.LEAN_HAR_MAX_SWEEPS, DEFAULTS.maxSweeps),
    secrets,
  };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function redact(value, secrets = []) {
  if (value === null || value === undefined) return value;
  let text = typeof value === "string" ? value : safeStringify(value);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) {
      text = text.split(secret).join("[REDACTED]");
    }
  }
  text = text.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]");
  text = text.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "$1 [REDACTED]");
  return text;
}

export function makeRedactor(config) {
  const secrets = (config && config.secrets) || [];
  return (value) => redact(value, secrets);
}
