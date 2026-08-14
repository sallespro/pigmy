#!/usr/bin/env node
/**
 * The sandbox server: static web app, control endpoints, and the SSE feed.
 *
 * Endpoints
 *   GET  /api/state              current run + agent status
 *   GET  /api/events?since=N     SSE feed, replaying everything after N
 *   POST /api/run                { task, contract?, reclone? } -> start a run
 *   POST /api/stop               SIGTERM every live child
 *
 * The SSE feed carries a `since` cursor so a browser that reconnects gets
 * the events it missed rather than a gap it cannot detect.
 */

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENTS } from "./agents.mjs";
import { listArtifacts, readArtifact } from "./artifacts.mjs";
import { createSupervisor } from "./supervisor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SAND_ROOT = resolve(HERE, "..", "..");
const PUBLIC_DIR = join(SAND_ROOT, "public");
const SANDBOX_ROOT = join(SAND_ROOT, "run");

/** Minimal dotenv parse: KEY=value, `export` prefix, quotes, comments. */
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

function loadApiKey() {
  const envPath = join(SAND_ROOT, ".env");
  const fromFile = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, "utf8")) : {};
  // Process environment wins, matching how both harnesses resolve config.
  return { key: process.env.OPENAI_API_KEY || fromFile.OPENAI_API_KEY || "", envPath };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      // Refuse an oversized body rather than buffering it into memory.
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  // normalize + prefix check keeps `..` from escaping the public dir.
  const target = normalize(join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR) || !existsSync(target)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(target)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(target).pipe(res);
}

export function createSandboxServer({ apiKey, envPath }) {
  const supervisor = createSupervisor({ sandboxRoot: SANDBOX_ROOT, apiKey });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const { pathname } = url;

    if (pathname === "/api/state" && req.method === "GET") {
      sendJson(res, 200, {
        ...supervisor.snapshot(),
        hasApiKey: Boolean(apiKey),
        envPath,
        available: AGENTS.map((a) => ({
          id: a.id,
          label: a.label,
          discipline: a.discipline,
          repo: a.repo,
        })),
      });
      return;
    }

    if (pathname === "/api/events" && req.method === "GET") {
      const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Proxies that buffer would defeat the point of a live feed.
        "x-accel-buffering": "no",
      });

      // Node buffers the head until the body is first written. On an idle
      // engine the replay below writes nothing, so without this the client
      // waits for the first event before it ever sees the response -- and
      // reads that silence as a failed connection.
      res.write(": open\n\n");

      const write = (event) => {
        res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      };

      // Replay first, then stream, so no event falls between the two.
      for (const event of supervisor.bus.since(since)) write(event);

      const onEvent = (event) => write(event);
      supervisor.bus.on("event", onEvent);

      // Comment frames keep idle connections from being reaped.
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

      req.on("close", () => {
        clearInterval(heartbeat);
        supervisor.bus.off("event", onEvent);
      });
      return;
    }

    // What the agents actually produced, as opposed to what they did.
    if (pathname === "/api/artifacts" && req.method === "GET") {
      const runId = url.searchParams.get("runId") || supervisor.snapshot().runId;
      if (!runId) {
        sendJson(res, 200, { runId: null, agents: [] });
        return;
      }
      const agents = await Promise.all(
        AGENTS.map(async (a) => ({
          id: a.id,
          label: a.label,
          artifacts: await listArtifacts(supervisor.workspaceFor(runId, a.id)),
        })),
      );
      sendJson(res, 200, { runId, agents });
      return;
    }

    if (pathname === "/api/artifact" && req.method === "GET") {
      const runId = url.searchParams.get("runId") || supervisor.snapshot().runId;
      const agentId = url.searchParams.get("agent");
      const name = url.searchParams.get("name");
      if (!runId || !agentId || !name) {
        sendJson(res, 400, { error: "runId, agent and name are required" });
        return;
      }
      if (!AGENTS.some((a) => a.id === agentId)) {
        sendJson(res, 404, { error: "no such agent" });
        return;
      }
      try {
        sendJson(res, 200, await readArtifact(supervisor.workspaceFor(runId, agentId), name));
      } catch (err) {
        sendJson(res, 404, { error: err.message });
      }
      return;
    }

    if (pathname === "/api/run" && req.method === "POST") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const result = await supervisor.startRun({
          task: body.task,
          contract: body.contract ?? "",
          reclone: Boolean(body.reclone),
        });
        sendJson(res, 202, result);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === "/api/stop" && req.method === "POST") {
      sendJson(res, 200, supervisor.stopRun());
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "no such endpoint" });
      return;
    }

    serveStatic(req, res, pathname);
  });

  return { server, supervisor };
}

// Only start listening when run directly, so tests can import the factory.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { key, envPath } = loadApiKey();
  const port = Number.parseInt(process.env.PORT ?? "7801", 10);
  const { server } = createSandboxServer({ apiKey: key, envPath });

  server.listen(port, () => {
    process.stdout.write(`sandbox listening on http://localhost:${port}\n`);
    process.stdout.write(`sandbox root: ${SANDBOX_ROOT}\n`);
    if (key) {
      process.stdout.write(`credentials: loaded from ${envPath}\n`);
    } else {
      process.stdout.write(`credentials: NO OPENAI_API_KEY at ${envPath} -- runs will be refused\n`);
    }
  });
}
