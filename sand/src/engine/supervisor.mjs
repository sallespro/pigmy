/**
 * The sandbox supervisor.
 *
 * Coordinates one run: prepare each agent's clone, then spawn both against
 * the same task at the same time and narrate everything they do onto the
 * event bus.
 *
 * Two properties are deliberate.
 *
 * Preparation is sequential, execution is concurrent. Two `npm install`s
 * racing on a cold cache fight over the same cache entries and produce
 * failures that look like agent bugs. The agents themselves run truly in
 * parallel -- that is the point of the sandbox -- but only once both are
 * known good.
 *
 * The credential never touches a clone. Both harnesses let the process
 * environment override their own .env, so the key is injected into the child
 * environment at spawn and exists nowhere on disk inside sand/run/.
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { AGENTS } from "./agents.mjs";
import { EventBus, createLineSplitter, parseAgentLine } from "./events.mjs";

/**
 * Run a command to completion, streaming both its streams as events.
 * Resolves with the exit code rather than rejecting, because a non-zero
 * exit is frequently a meaningful agent verdict, not an exception.
 */
function runProcess({ command, args, cwd, env, agent, phase, bus, onStdout, register, unregister }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (register) register(child);

    const emitStream = (kind, line) => {
      // Agent events arrive on stderr in `[type] k=v` form. Anything that
      // does not parse is still shown -- a stack trace or a usage message
      // is exactly what an operator needs when a run misbehaves.
      const parsed = kind === "stderr" ? parseAgentLine(line) : null;
      if (parsed) {
        bus.emitEvent({ agent, phase, kind: "agent", type: parsed.type, fields: parsed.fields });
      } else {
        bus.emitEvent({ agent, phase, kind, message: line });
      }
    };

    const outSplitter = createLineSplitter((line) => {
      if (onStdout) onStdout(line);
      emitStream("stdout", line);
    });
    const errSplitter = createLineSplitter((line) => emitStream("stderr", line));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => outSplitter.push(chunk));
    child.stderr.on("data", (chunk) => errSplitter.push(chunk));

    child.on("error", (err) => {
      bus.emitEvent({ agent, phase, kind: "stderr", message: `spawn failed: ${err.message}` });
      if (unregister) unregister(child);
      resolvePromise(-1);
    });

    child.on("close", (code, signal) => {
      outSplitter.flush();
      errSplitter.flush();
      if (unregister) unregister(child);
      // A signalled process reports code null; surface that as non-zero so
      // callers never read a kill as success.
      resolvePromise(code === null ? (signal ? 128 : -1) : code);
    });
  });
}

function freshAgentState(a) {
  return {
    id: a.id,
    label: a.label,
    discipline: a.discipline,
    status: "idle",
    exitCode: null,
    outcome: null,
    answer: "",
  };
}

export function createSupervisor({ sandboxRoot, apiKey, historyLimit }) {
  const bus = new EventBus({ historyLimit });

  const state = {
    runId: null,
    status: "idle", // idle | preparing | running | done
    task: "",
    startedAt: null,
    finishedAt: null,
    agents: Object.fromEntries(AGENTS.map((a) => [a.id, freshAgentState(a)])),
  };

  /** Live child processes, so a stop request can reach them. */
  const children = new Set();
  const register = (c) => children.add(c);
  const unregister = (c) => children.delete(c);

  let logStream = null;

  const emit = (event) => {
    const stored = bus.emitEvent({ runId: state.runId, ...event });
    if (logStream) logStream.write(`${JSON.stringify(stored)}\n`);
    return stored;
  };

  // The bus is also fed directly by runProcess, which does not know about
  // the log stream. Mirror those events into the log too.
  bus.on("event", (stored) => {
    if (logStream && stored.runId === undefined) logStream.write(`${JSON.stringify(stored)}\n`);
  });

  const setAgent = (id, patch) => {
    Object.assign(state.agents[id], patch);
    emit({ agent: id, kind: "status", ...patch });
  };

  /**
   * Clone (or reuse) the repo and install its dependencies. Returns the
   * directory the entry point should be spawned from, or null on failure.
   */
  async function prepareAgent(agent, { reclone }) {
    const cloneDir = join(sandboxRoot, "agents", agent.id);
    const pkgDir = resolve(cloneDir, agent.packageDir);

    if (reclone && existsSync(cloneDir)) {
      emit({ agent: agent.id, phase: "clone", kind: "lifecycle", message: "removing previous clone" });
      await rm(cloneDir, { recursive: true, force: true });
    }

    if (!existsSync(cloneDir)) {
      emit({ agent: agent.id, phase: "clone", kind: "lifecycle", message: `cloning ${agent.repo}` });
      setAgent(agent.id, { status: "cloning" });
      const code = await runProcess({
        command: "git",
        args: ["clone", "--depth", "1", agent.repo, cloneDir],
        cwd: sandboxRoot,
        env: process.env,
        agent: agent.id,
        phase: "clone",
        bus,
        register,
        unregister,
      });
      if (code !== 0) {
        setAgent(agent.id, { status: "failed", outcome: "clone-failed" });
        return null;
      }
    } else {
      emit({ agent: agent.id, phase: "clone", kind: "lifecycle", message: "reusing existing clone" });
    }

    if (!existsSync(join(pkgDir, "node_modules"))) {
      emit({
        agent: agent.id,
        phase: "install",
        kind: "lifecycle",
        message: `npm install in ${agent.packageDir}`,
      });
      setAgent(agent.id, { status: "installing" });
      const code = await runProcess({
        command: "npm",
        args: ["install", "--no-audit", "--no-fund"],
        cwd: pkgDir,
        env: process.env,
        agent: agent.id,
        phase: "install",
        bus,
        register,
        unregister,
      });
      if (code !== 0) {
        setAgent(agent.id, { status: "failed", outcome: "install-failed" });
        return null;
      }
    } else {
      emit({ agent: agent.id, phase: "install", kind: "lifecycle", message: "dependencies already installed" });
    }

    setAgent(agent.id, { status: "ready" });
    return pkgDir;
  }

  /**
   * Make the workspace its own git repository.
   *
   * This is load-bearing, not hygiene. Both harnesses evaluate their gates
   * with `git diff HEAD` against the workspace. Without a repo of its own,
   * git walks up and finds whatever repository the sandbox happens to live
   * in, and the agent is then judged on *that* repo's uncommitted changes --
   * so an unrelated edit elsewhere in the tree can refuse a gate forever,
   * identically, no matter what the agent was asked to do.
   *
   * The baseline commit is empty so that everything the agent produces
   * appears as its own addition.
   */
  async function initWorkspaceRepo(agentId, workspace) {
    const run = (args) =>
      runProcess({
        command: "git",
        args,
        cwd: workspace,
        env: process.env,
        agent: agentId,
        phase: "workspace",
        bus,
        register,
        unregister,
      });

    await run(["init", "--quiet", "--initial-branch=main"]);
    // Identity must be local: the machine may have no global git config,
    // and an unset identity makes the baseline commit fail.
    await run(["config", "user.email", "sandbox@localhost"]);
    await run(["config", "user.name", "sand"]);
    await run(["commit", "--quiet", "--allow-empty", "-m", "sandbox baseline"]);

    emit({
      agent: agentId,
      phase: "workspace",
      kind: "lifecycle",
      message: "workspace initialised as its own git repo",
    });
  }

  /** Spawn one prepared agent against the task in its own workspace. */
  async function runAgent(agent, pkgDir, { task, contract }) {
    const workspace = join(sandboxRoot, "workspaces", state.runId, agent.id);
    await mkdir(workspace, { recursive: true });
    await initWorkspaceRepo(agent.id, workspace);

    setAgent(agent.id, { status: "running" });
    emit({ agent: agent.id, phase: "run", kind: "lifecycle", message: `workspace ${workspace}` });

    // stdout carries the agent's final answer; collect it separately from
    // the event narration so the UI can show a conclusion, not just a log.
    const answerLines = [];

    // The briefing tells each harness what "finished" means in this
    // sandbox. It is appended rather than prepended so the user's own
    // words stay first, and it is per-agent because the two harnesses
    // fall short in different ways.
    const briefedTask = agent.briefing ? `${task}\n\n${agent.briefing}` : task;

    const code = await runProcess({
      command: process.execPath,
      args: [join(pkgDir, agent.entry), ...agent.argv({ task: briefedTask, workspace, contract })],
      cwd: workspace,
      // The key is injected here and only here.
      env: { ...process.env, OPENAI_API_KEY: apiKey },
      agent: agent.id,
      phase: "run",
      bus,
      onStdout: (line) => answerLines.push(line),
      register,
      unregister,
    });

    const { outcome, ok } = agent.classifyExit(code);
    const raw = answerLines.join("\n").trim();
    setAgent(agent.id, {
      status: ok ? "succeeded" : "failed",
      exitCode: code,
      outcome,
      // Each harness reports its conclusion in its own format; the registry
      // knows how to render each one as something a person can read.
      answer: agent.formatAnswer ? agent.formatAnswer(raw) : raw,
    });
    return code;
  }

  async function startRun({ task, contract = "", reclone = false }) {
    if (state.status === "preparing" || state.status === "running") {
      throw new Error("a run is already in progress");
    }
    if (!task || !task.trim()) throw new Error("task is required");
    if (!apiKey) throw new Error("OPENAI_API_KEY is missing from sand/.env");

    const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    state.runId = runId;
    state.task = task.trim();
    state.status = "preparing";
    state.startedAt = Date.now();
    state.finishedAt = null;
    for (const a of AGENTS) state.agents[a.id] = freshAgentState(a);

    const runDir = join(sandboxRoot, "runs", runId);
    await mkdir(runDir, { recursive: true });
    logStream = createWriteStream(join(runDir, "events.jsonl"), { flags: "a" });

    emit({ kind: "lifecycle", phase: "run", message: `run ${runId} started`, task: state.task });

    // Prepare sequentially -- concurrent npm installs corrupt each other.
    const prepared = [];
    for (const agent of AGENTS) {
      const pkgDir = await prepareAgent(agent, { reclone });
      prepared.push({ agent, pkgDir });
    }

    const runnable = prepared.filter((p) => p.pkgDir);
    if (runnable.length === 0) {
      state.status = "done";
      state.finishedAt = Date.now();
      emit({ kind: "lifecycle", phase: "run", message: "no agent could be prepared; run aborted" });
      logStream?.end();
      logStream = null;
      return { runId };
    }

    state.status = "running";
    emit({
      kind: "lifecycle",
      phase: "run",
      message: `spawning ${runnable.length} agent(s) concurrently`,
    });

    // The concurrent part: both agents work the same task at once.
    Promise.all(
      runnable.map(({ agent, pkgDir }) => runAgent(agent, pkgDir, { task: state.task, contract })),
    )
      .catch((err) => {
        emit({ kind: "lifecycle", phase: "run", message: `run error: ${err.message}` });
      })
      .finally(() => {
        state.status = "done";
        state.finishedAt = Date.now();
        children.clear();
        emit({ kind: "lifecycle", phase: "run", message: `run ${runId} finished` });
        logStream?.end();
        logStream = null;
      });

    return { runId };
  }

  function stopRun() {
    if (children.size === 0) return { stopped: 0 };
    const count = children.size;
    emit({ kind: "lifecycle", phase: "run", message: `stopping ${count} process(es)` });
    for (const child of children) child.kill("SIGTERM");
    children.clear();
    return { stopped: count };
  }

  return {
    bus,
    startRun,
    stopRun,
    /**
     * Where a given agent worked. Exposed so artifacts can be served for
     * any run on disk, not only the one currently in memory.
     */
    workspaceFor: (runId, agentId) => join(sandboxRoot, "workspaces", runId, agentId),
    snapshot: () => ({ ...state, agents: { ...state.agents }, seq: bus.seq }),
  };
}
