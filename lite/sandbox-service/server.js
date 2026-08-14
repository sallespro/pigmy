// Sandbox service: spawns isolated litebox+Alpine sandboxes to run untrusted
// Node.js apps, one Docker container per sandbox for process/fs/network
// isolation, with per-sandbox export-writable-layer paths (avoids the tar
// collision hazard from two sandboxes sharing one export path), CPU/memory/
// wall-clock limits, and a lifecycle registry queryable over HTTP.
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const PORT = Number(process.env.SANDBOX_SERVICE_PORT || 8787);
const IMAGE = process.env.SANDBOX_IMAGE || 'litebox-sandbox:latest';
const WORK_ROOT = process.env.SANDBOX_WORK_ROOT || path.join(__dirname, '.sandboxes');
const MAX_CONCURRENT = Number(process.env.SANDBOX_MAX_CONCURRENT || 8);
const DEFAULT_TIMEOUT_MS = Number(process.env.SANDBOX_DEFAULT_TIMEOUT_MS || 60_000);
const MAX_TIMEOUT_MS = Number(process.env.SANDBOX_MAX_TIMEOUT_MS || 10 * 60_000);
// litebox_runner_linux_userland mmaps the whole base rootfs tar (~680MB for the
// nodejs-enabled image) plus copies it to /tmp (tmpfs, counts against the
// container's cgroup) before appending the app -- 256m OOM-kills (exit 137)
// even for a trivial script. 1536m covers the mmap + copy + guest heap headroom.
const DEFAULT_MEMORY = process.env.SANDBOX_DEFAULT_MEMORY || '1536m';
const DEFAULT_CPUS = process.env.SANDBOX_DEFAULT_CPUS || '1.0';
const MAX_APP_BYTES = Number(process.env.SANDBOX_MAX_APP_BYTES || 20 * 1024 * 1024);
const MAX_ENTRY_BYTES = Number(process.env.SANDBOX_MAX_ENTRY_BYTES || 5 * 1024 * 1024);

/** @typedef {'queued'|'running'|'completed'|'failed'|'timed_out'|'stopped'} SandboxStatus */

/** In-memory lifecycle registry. Keyed by sandbox id. */
const sandboxes = new Map();
let runningCount = 0;
const queue = [];

function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

function isPathSafe(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  if (path.isAbsolute(relPath)) return false;
  const normalized = path.normalize(relPath);
  if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) return false;
  return true;
}

function record(id, patch) {
  const cur = sandboxes.get(id);
  const next = { ...cur, ...patch };
  sandboxes.set(id, next);
  return next;
}

async function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > limitBytes) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Validate + materialize the spawn request's app files onto disk under a
 * fresh per-sandbox directory. Files map: { "relative/path.js": "source text" }.
 * Precondition: every key passes isPathSafe (no absolute paths, no traversal).
 * Postcondition: sandboxDir/app/<entry> exists and is non-empty.
 */
async function materializeApp(sandboxDir, { entry, files }) {
  if (!isPathSafe(entry)) {
    throw Object.assign(new Error(`invalid entry path: ${entry}`), { statusCode: 400 });
  }
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    throw Object.assign(new Error('files must be an object of {relativePath: content}'), { statusCode: 400 });
  }
  const appDir = path.join(sandboxDir, 'in', 'app');
  await fsp.mkdir(appDir, { recursive: true });

  let totalBytes = 0;
  for (const [relPath, content] of Object.entries(files)) {
    if (!isPathSafe(relPath)) {
      throw Object.assign(new Error(`invalid file path: ${relPath}`), { statusCode: 400 });
    }
    if (typeof content !== 'string') {
      throw Object.assign(new Error(`file content must be a string: ${relPath}`), { statusCode: 400 });
    }
    totalBytes += Buffer.byteLength(content, 'utf8');
    if (totalBytes > MAX_APP_BYTES) {
      throw Object.assign(new Error('app payload exceeds size limit'), { statusCode: 413 });
    }
    const dest = path.join(appDir, relPath);
    if (!dest.startsWith(appDir + path.sep) && dest !== appDir) {
      throw Object.assign(new Error(`file path escapes app dir: ${relPath}`), { statusCode: 400 });
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, content, 'utf8');
  }

  const entryPath = path.join(appDir, entry);
  const entryStat = await fsp.stat(entryPath).catch(() => null);
  if (!entryStat || entryStat.size === 0) {
    throw Object.assign(new Error(`entry file missing or empty in submitted files: ${entry}`), { statusCode: 400 });
  }
  if (entryStat.size > MAX_ENTRY_BYTES) {
    throw Object.assign(new Error('entry file exceeds size limit'), { statusCode: 413 });
  }
  await fsp.writeFile(path.join(sandboxDir, 'in', 'entry'), entry, 'utf8');
  return appDir;
}

/**
 * Launch one sandbox's Docker container. Never shares a container name, work
 * dir, or --export-writable-layer path with any other sandbox -- each is
 * scoped under sandboxDir, which is unique per id.
 */
function launchContainer(id, sandboxDir, opts) {
  const containerName = `litebox-sandbox-${id}`;
  const outDir = path.join(sandboxDir, 'out');
  const inDir = path.join(sandboxDir, 'in');
  const logPath = path.join(outDir, 'log.txt');
  const logFd = fs.openSync(logPath, 'a');

  const args = [
    'run',
    '--name', containerName,
    '--rm',
    '--privileged', // required by litebox_runner_linux_userland's own seccomp/namespace setup
    '--network', 'none', // no network by construction; opt-in networking is a documented future PRD row
    '--cpus', String(opts.cpus),
    '--memory', String(opts.memory),
    '--pids-limit', '256',
    '-v', `${inDir}:/sandbox-in:ro`,
    '-v', `${outDir}:/sandbox-out`,
    IMAGE,
  ];

  const child = spawn('docker', args, { stdio: ['ignore', logFd, logFd] });

  const timeoutHandle = setTimeout(() => {
    record(id, { status: 'timed_out' });
    execFile('docker', ['kill', containerName], () => {});
  }, opts.timeoutMs);

  child.on('exit', (code, signal) => {
    clearTimeout(timeoutHandle);
    fs.closeSync(logFd);
    const cur = sandboxes.get(id);
    const finishedStatus = cur && cur.status === 'timed_out'
      ? 'timed_out'
      : cur && cur.status === 'stopped'
        ? 'stopped'
        : code === 0
          ? 'completed'
          : 'failed';
    record(id, {
      status: finishedStatus,
      exitCode: code,
      signal,
      endedAt: new Date().toISOString(),
    });
    runningCount -= 1;
    drainQueue();
  });

  child.on('error', (err) => {
    clearTimeout(timeoutHandle);
    fs.closeSync(logFd);
    record(id, { status: 'failed', error: String(err), endedAt: new Date().toISOString() });
    runningCount -= 1;
    drainQueue();
  });

  return { containerName, logPath };
}

function drainQueue() {
  while (queue.length > 0 && runningCount < MAX_CONCURRENT) {
    const job = queue.shift();
    runningCount += 1;
    record(job.id, { status: 'running', startedAt: new Date().toISOString() });
    const { containerName, logPath } = launchContainer(job.id, job.sandboxDir, job.opts);
    record(job.id, { containerName, logPath });
  }
}

async function handleSpawn(req, res) {
  const body = await readJsonBody(req, MAX_APP_BYTES + 1024 * 1024);
  const { entry, files } = body;

  const timeoutMs = Math.min(
    Math.max(1, Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
  );
  const memory = typeof body.memory === 'string' ? body.memory : DEFAULT_MEMORY;
  const cpus = typeof body.cpus === 'string' || typeof body.cpus === 'number' ? String(body.cpus) : DEFAULT_CPUS;

  const id = newId();
  const sandboxDir = path.join(WORK_ROOT, id);
  await fsp.mkdir(path.join(sandboxDir, 'out'), { recursive: true });

  await materializeApp(sandboxDir, { entry, files });

  sandboxes.set(id, {
    id,
    status: 'queued',
    createdAt: new Date().toISOString(),
    timeoutMs,
    memory,
    cpus,
  });

  queue.push({ id, sandboxDir, opts: { timeoutMs, memory, cpus } });
  drainQueue();

  sendJson(res, 202, { id, status: sandboxes.get(id).status });
}

function handleStatus(res, id) {
  const s = sandboxes.get(id);
  if (!s) return sendJson(res, 404, { error: 'not found' });
  const { id: sid, status, createdAt, startedAt, endedAt, exitCode, signal, containerName } = s;
  sendJson(res, 200, { id: sid, status, createdAt, startedAt, endedAt, exitCode, signal, containerName });
}

async function handleLogs(res, id) {
  const s = sandboxes.get(id);
  if (!s) return sendJson(res, 404, { error: 'not found' });
  const logPath = path.join(WORK_ROOT, id, 'out', 'log.txt');
  try {
    const content = await fsp.readFile(logPath, 'utf8');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(content);
  } catch {
    sendJson(res, 200, { log: '' });
  }
}

function handleStop(res, id) {
  const s = sandboxes.get(id);
  if (!s) return sendJson(res, 404, { error: 'not found' });
  if (s.status !== 'running') return sendJson(res, 409, { error: `cannot stop sandbox in status ${s.status}` });
  record(id, { status: 'stopped' });
  execFile('docker', ['kill', s.containerName], (err) => {
    if (err) record(id, { status: 'failed', error: String(err) });
  });
  sendJson(res, 202, { id, status: 'stopping' });
}

async function handleDelete(res, id) {
  const s = sandboxes.get(id);
  if (!s) return sendJson(res, 404, { error: 'not found' });
  if (s.status === 'running' || s.status === 'queued') {
    return sendJson(res, 409, { error: 'stop the sandbox before deleting' });
  }
  sandboxes.delete(id);
  await fsp.rm(path.join(WORK_ROOT, id), { recursive: true, force: true });
  sendJson(res, 200, { id, deleted: true });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  (async () => {
    if (req.method === 'POST' && parts[0] === 'sandboxes' && parts.length === 1) {
      return handleSpawn(req, res);
    }
    if (parts[0] === 'sandboxes' && parts.length === 2 && req.method === 'GET') {
      return handleStatus(res, parts[1]);
    }
    if (parts[0] === 'sandboxes' && parts.length === 3 && parts[2] === 'logs' && req.method === 'GET') {
      return handleLogs(res, parts[1]);
    }
    if (parts[0] === 'sandboxes' && parts.length === 3 && parts[2] === 'stop' && req.method === 'POST') {
      return handleStop(res, parts[1]);
    }
    if (parts[0] === 'sandboxes' && parts.length === 2 && req.method === 'DELETE') {
      return handleDelete(res, parts[1]);
    }
    if (parts[0] === 'sandboxes' && parts.length === 1 && req.method === 'GET') {
      return sendJson(res, 200, { sandboxes: [...sandboxes.values()] });
    }
    sendJson(res, 404, { error: 'not found' });
  })().catch((err) => {
    const statusCode = err.statusCode || 500;
    sendJson(res, statusCode, { error: err.message || String(err) });
  });
});

fs.mkdirSync(WORK_ROOT, { recursive: true });
server.listen(PORT, () => {
  console.log(`sandbox-service listening on :${PORT}, image=${IMAGE}, workRoot=${WORK_ROOT}`);
});

module.exports = { server };
