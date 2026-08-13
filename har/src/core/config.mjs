/**
 * Configuration and credential loading.
 *
 * The API key is read from har/.env and never leaves this module in raw form
 * except when handed directly to the provider. `redact` is applied to every
 * string that reaches a log, a witness record, or an error message.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const HARNESS_ROOT = resolve(HERE, "..", "..");

const DEFAULTS = {
  model: "gpt-5.6-luna",
  execTimeoutMs: 120_000,
  maxTurns: 40,
  maxOutputBytes: 64_000,
};

/**
 * Parse a dotenv file. Supports `KEY=value`, `export KEY=value`, comments,
 * and single/double quoted values. Malformed lines are skipped rather than
 * throwing, so one bad line cannot prevent the process from starting.
 */
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
    // A credential file that exists but cannot be read is a hard problem the
    // operator must see, but it is surfaced as a value, not an uncaught throw.
    return { __readError: String(err && err.message ? err.message : err) };
  }
}

function positiveInt(raw, fallback) {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Load harness configuration. `process.env` wins over the dotenv file so a
 * caller can override without editing the file.
 */
export function loadConfig({ envPath = join(HARNESS_ROOT, ".env"), env = process.env } = {}) {
  const fromFile = readEnvFile(envPath);
  const merged = { ...fromFile, ...env };

  const apiKey = merged.OPENAI_API_KEY ?? "";
  const secrets = [apiKey].filter((s) => typeof s === "string" && s.length >= 8);

  return {
    envPath,
    apiKey,
    hasApiKey: apiKey.length > 0,
    envReadError: fromFile.__readError ?? null,
    model: merged.PI_GM_MODEL || DEFAULTS.model,
    execTimeoutMs: positiveInt(merged.PI_GM_EXEC_TIMEOUT_MS, DEFAULTS.execTimeoutMs),
    maxTurns: positiveInt(merged.PI_GM_MAX_TURNS, DEFAULTS.maxTurns),
    maxOutputBytes: positiveInt(merged.PI_GM_MAX_OUTPUT_BYTES, DEFAULTS.maxOutputBytes),
    secrets,
  };
}

/**
 * Remove known secret values and secret-shaped literals from a string.
 *
 * Two passes: exact known values (the loaded key), then a shape-based pass so
 * a key arriving from an unexpected path is still masked.
 */
export function redact(value, secrets = []) {
  if (value === null || value === undefined) return value;
  let text = typeof value === "string" ? value : safeStringify(value);

  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) {
      text = text.split(secret).join("[REDACTED]");
    }
  }

  // Provider key shapes, independent of whether they were the configured key.
  text = text.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]");
  text = text.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "$1 [REDACTED]");

  return text;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A redactor bound to one config, for convenience at call sites. */
export function makeRedactor(config) {
  const secrets = config?.secrets ?? [];
  return (value) => redact(value, secrets);
}
