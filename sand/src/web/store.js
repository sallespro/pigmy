/**
 * Client state and the SSE connection.
 *
 * webjsx is a VDOM and nothing more -- no stateful components, no
 * scheduler. So the app owns its state here and re-renders by calling
 * applyDiff against the whole tree. That is cheap precisely because
 * applyDiff patches only what actually changed.
 */

const MAX_EVENTS = 4000;

export function createStore(onChange) {
  const state = {
    connected: false,
    hasApiKey: false,
    envPath: "",
    runId: null,
    status: "idle",
    task: "",
    startedAt: null,
    finishedAt: null,
    agents: {},
    available: [],
    events: [],
    // UI-only concerns, kept beside server state so one render reads one object.
    filter: { pilean: true, pigmy: true, noise: false },
    follow: true,
    error: "",
    // What the agents produced: a per-agent file list, plus whichever one
    // the user opened. `viewer` holds the fetched content so a re-render
    // does not refetch it.
    artifacts: {},
    viewer: null,
    viewerLoading: false,
  };

  let lastSeq = 0;
  let source = null;

  const notify = () => onChange(state);

  function addEvent(event) {
    lastSeq = Math.max(lastSeq, event.seq ?? 0);

    if (event.kind === "status" && event.agent && state.agents[event.agent]) {
      // Status events double as patches to the agent cards, so the summary
      // stays correct without re-fetching /api/state on every change.
      const { seq, at, runId, kind, agent, ...patch } = event;
      Object.assign(state.agents[agent], patch);
    }
    if (event.kind === "lifecycle" && !event.agent && typeof event.message === "string") {
      if (event.message.endsWith("started")) state.status = "running";
      if (event.message.endsWith("finished") || event.message.endsWith("aborted")) {
        state.status = "done";
        // The artifacts exist only once the agents have exited.
        refreshArtifacts(event.runId ?? state.runId);
      }
      if (event.runId) state.runId = event.runId;
    }

    state.events.push(event);
    if (state.events.length > MAX_EVENTS) {
      state.events.splice(0, state.events.length - MAX_EVENTS);
    }
  }

  /**
   * Pull the file listing for a run. Called when a run ends and on load,
   * so re-opening the page after a run still shows what it produced.
   */
  async function refreshArtifacts(runId) {
    const id = runId ?? state.runId;
    if (!id) return;
    try {
      const res = await fetch(`/api/artifacts?runId=${encodeURIComponent(id)}`);
      const data = await res.json();
      state.artifacts = Object.fromEntries(data.agents.map((a) => [a.id, a.artifacts]));
      notify();
    } catch {
      // The listing is a convenience; failing to get it must not disturb
      // the event stream, which is the primary view.
    }
  }

  async function refresh() {
    try {
      const res = await fetch("/api/state");
      const data = await res.json();
      Object.assign(state, {
        hasApiKey: data.hasApiKey,
        envPath: data.envPath,
        runId: data.runId,
        status: data.status,
        task: data.task,
        startedAt: data.startedAt,
        finishedAt: data.finishedAt,
        agents: data.agents,
        available: data.available,
      });
      notify();
    } catch (err) {
      state.error = `cannot reach the sandbox engine: ${err.message}`;
      notify();
    }
  }

  function connect() {
    // EventSource reconnects on its own; `since` makes that reconnect lossless.
    source = new EventSource(`/api/events?since=${lastSeq}`);

    source.onopen = () => {
      state.connected = true;
      state.error = "";
      notify();
    };

    source.onmessage = (message) => {
      try {
        addEvent(JSON.parse(message.data));
        notify();
      } catch {
        // A frame we cannot parse is not worth tearing the stream down for.
      }
    };

    source.onerror = () => {
      state.connected = false;
      notify();
      // Reopen with the current cursor so the gap is replayed, not skipped.
      source.close();
      setTimeout(connect, 1500);
    };
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
    return data;
  }

  return {
    state,
    notify,
    async start({ task, contract, reclone }) {
      state.error = "";
      // A new run starts a new narrative; clearing avoids reading the last
      // run's events, or its artifacts, as if they belonged to this one.
      state.events = [];
      state.artifacts = {};
      state.viewer = null;
      notify();
      try {
        await post("/api/run", { task, contract, reclone });
        await refresh();
      } catch (err) {
        state.error = err.message;
        notify();
      }
    },
    async stop() {
      try {
        await post("/api/stop");
      } catch (err) {
        state.error = err.message;
        notify();
      }
    },
    setFilter(key, value) {
      state.filter[key] = value;
      notify();
    },
    setFollow(value) {
      state.follow = value;
      notify();
    },
    /** Open one artifact, fetching its content once. */
    async selectArtifact(agentId, name) {
      state.viewerLoading = true;
      state.viewer = { agentId, name, kind: null, content: "" };
      notify();
      try {
        const query = new URLSearchParams({ runId: state.runId ?? "", agent: agentId, name });
        const res = await fetch(`/api/artifact?${query}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "could not read artifact");
        state.viewer = { agentId, name, kind: data.kind, content: data.content };
      } catch (err) {
        state.viewer = { agentId, name, kind: "error", content: err.message };
      } finally {
        state.viewerLoading = false;
        notify();
      }
    },
    closeArtifact() {
      state.viewer = null;
      notify();
    },
    async init() {
      await refresh();
      // A finished run reloaded in a new tab should still show its output.
      if (state.runId) await refreshArtifacts(state.runId);
      connect();
    },
  };
}
