import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

function resolveInside(root, candidate) {
  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const rel = relative(resolve(root), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes workspace root: ${candidate}`);
  }
  return abs;
}

function truncate(text, maxBytes) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  return {
    text: `${buf.subarray(0, maxBytes).toString("utf8")}\n[output truncated at ${maxBytes} bytes]`,
    truncated: true,
  };
}

export function runCommand({ command, cwd, timeoutMs, maxOutputBytes, signal, env = process.env }) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, { cwd, shell: true, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolvePromise({
        stdout: "",
        stderr: String(err && err.message ? err.message : err),
        exitCode: null,
        timedOut: false,
        truncated: false,
        spawnFailed: true,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      const o = truncate(stdout, maxOutputBytes);
      const e = truncate(stderr, maxOutputBytes);
      resolvePromise({
        stdout: o.text,
        stderr: e.text,
        exitCode,
        timedOut,
        truncated: o.truncated || e.truncated,
        spawnFailed: false,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        finish(null);
      }
    }, timeoutMs);

    const onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        finish(null);
      }
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += String(err && err.message ? err.message : err);
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

function textResult(text, details) {
  return { content: [{ type: "text", text }], details };
}

export function createTools({ root, config, redact = (s) => s, readOnly = false }) {
  const workspace = resolve(root);

  const exec = {
    name: "exec",
    label: "Run a shell command",
    description:
      "Execute a shell command in the workspace and return its real stdout, stderr, and exit code.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to run." },
        cwd: {
          type: "string",
          description: "Directory to run in, relative to the workspace root. Defaults to root.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const cwd = resolveInside(workspace, params.cwd ?? ".");
      const result = await runCommand({
        command: params.command,
        cwd,
        timeoutMs: config.execTimeoutMs,
        maxOutputBytes: config.maxOutputBytes,
        signal,
      });

      const parts = [];
      if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
      if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
      parts.push(
        result.timedOut
          ? `timed out after ${config.execTimeoutMs}ms`
          : `exit code: ${result.exitCode}`,
      );

      return textResult(redact(parts.join("\n\n")), {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: Boolean(result.truncated),
        cwd,
        noop: !result.stdout && !result.stderr && result.exitCode === 0,
      });
    },
  };

  const readFile = {
    name: "read_file",
    label: "Read a file",
    description: "Read a UTF-8 file from the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(toolCallId, params) {
      const abs = resolveInside(workspace, params.path);
      const raw = readFileSync(abs, "utf8");
      const { text, truncated } = truncate(raw, config.maxOutputBytes);
      return textResult(redact(text), { path: abs, bytes: raw.length, truncated, noop: false });
    },
  };

  const writeFile = {
    name: "write_file",
    label: "Write a file",
    description: "Write a UTF-8 file in the workspace, creating parent directories as needed.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    executionMode: "sequential",
    async execute(toolCallId, params) {
      const abs = resolveInside(workspace, params.path);
      let previous = null;
      try {
        previous = readFileSync(abs, "utf8");
      } catch {
        previous = null;
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, params.content, "utf8");
      const unchanged = previous === params.content;
      return textResult(
        `wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${
          relative(workspace, abs) || "."
        }`,
        { path: abs, unchanged, noop: unchanged },
      );
    },
  };

  const listDir = {
    name: "list_dir",
    label: "List a directory",
    description: "List entries of a directory in the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: [],
      additionalProperties: false,
    },
    async execute(toolCallId, params) {
      const abs = resolveInside(workspace, params.path ?? ".");
      const entries = readdirSync(abs).map((name) => {
        try {
          return statSync(join(abs, name)).isDirectory() ? `${name}/` : name;
        } catch {
          return name;
        }
      });
      return textResult(entries.join("\n") || "(empty)", {
        path: abs,
        count: entries.length,
        noop: false,
      });
    },
  };

  return readOnly ? [readFile, listDir] : [exec, readFile, writeFile, listDir];
}
