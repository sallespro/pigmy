/**
 * The view. Pure functions of state -- every interaction goes through the
 * store, which re-renders the whole tree; applyDiff decides what actually
 * touches the DOM.
 *
 * One webjsx property shapes this file: it has no component model. Its JSX
 * factory renders intrinsic elements only, and a non-string type is
 * discarded rather than invoked -- `<Row item={x}/>` silently produces
 * nothing at all. So the pieces below are plain functions returning vnodes,
 * and they are *called*, never used as tags. JSX here is markup, not
 * composition.
 */

/** Events that are structurally uninteresting unless you ask for them. */
const NOISE_KINDS = new Set(["stdout", "stderr"]);

const AGENT_ORDER = ["pilean", "pigmy"];

function clock(at) {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function elapsed(from, to) {
  if (!from) return "";
  const ms = (to ?? Date.now()) - from;
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function field(name, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (
    <span class="field">
      <span class="field-key">{name}</span>
      <span class="field-value">{text}</span>
    </span>
  );
}

function eventRow(event) {
  const agent = event.agent ?? "engine";
  const label = event.type ?? event.kind;
  const fields = event.fields ?? {};

  return (
    <div class={`event event-${agent} kind-${event.kind}`} key={event.seq}>
      <span class="seq">{String(event.seq).padStart(4, "0")}</span>
      <span class="time">{clock(event.at)}</span>
      <span class={`badge badge-${agent}`}>{agent}</span>
      <span class="type">{label}</span>
      <span class="body">
        {event.message ? <span class="message">{event.message}</span> : null}
        {Object.keys(fields).map((k) => field(k, fields[k]))}
      </span>
    </div>
  );
}

function agentCard(agent) {
  if (!agent) return null;

  const meta = [];
  if (agent.outcome) meta.push(field("outcome", agent.outcome));
  if (agent.exitCode !== null && agent.exitCode !== undefined) {
    meta.push(field("exit", String(agent.exitCode)));
  }

  return (
    <div class={`card status-${agent.status}`}>
      <div class="card-head">
        <span class={`badge badge-${agent.id}`}>{agent.label}</span>
        <span class="discipline">{agent.discipline}</span>
        <span class={`pill pill-${agent.status}`}>{agent.status}</span>
      </div>
      <div class="card-meta">{meta}</div>
      {agent.answer ? <pre class="answer">{agent.answer}</pre> : null}
    </div>
  );
}

/**
 * A column of events for one agent. Two columns side by side is the whole
 * reason for the sandbox: the same task, two disciplines, in step.
 */
function agentColumn(id, agent, events) {
  return (
    <section class="column" key={id}>
      {agentCard(agent)}
      <div class={`stream stream-${id}`} data-stream={id}>
        {events.length === 0 ? (
          <div class="empty">no events yet</div>
        ) : (
          events.map((e) => eventRow(e))
        )}
      </div>
    </section>
  );
}

function filterCheck(label, checked, onchange) {
  return (
    <label class="check">
      <input type="checkbox" checked={checked} onchange={onchange} />
      {label}
    </label>
  );
}

export function App({ state, actions }) {
  const visible = state.events.filter((e) => {
    if (!state.filter.noise && NOISE_KINDS.has(e.kind)) return false;
    if (e.agent && state.filter[e.agent] === false) return false;
    return true;
  });

  const engineEvents = visible.filter((e) => !e.agent);
  const running = state.status === "preparing" || state.status === "running";

  return (
    <div class="app">
      <header class="top">
        <div class="brand">
          <strong>sand</strong>
          <span class="sub">two pi agents, one task, side by side</span>
        </div>
        <div class="conn">
          <span class={`dot ${state.connected ? "on" : "off"}`}></span>
          {state.connected ? "live" : "reconnecting"}
          {state.runId ? <span class="runid">{state.runId}</span> : null}
          {state.startedAt ? (
            <span class="elapsed">{elapsed(state.startedAt, state.finishedAt)}</span>
          ) : null}
        </div>
      </header>

      {!state.hasApiKey ? (
        <div class="banner warn">
          {`No OPENAI_API_KEY at ${state.envPath} — runs will be refused.`}
        </div>
      ) : null}
      {state.error ? <div class="banner error">{state.error}</div> : null}

      <form
        class="controls"
        onsubmit={(e) => {
          e.preventDefault();
          const form = e.target;
          actions.start({
            task: form.elements.task.value,
            contract: form.elements.contract.value,
            reclone: form.elements.reclone.checked,
          });
        }}
      >
        <input
          name="task"
          class="task"
          placeholder="Task for both agents, e.g. Count the lines in README.md and report the number"
          disabled={running}
        />
        <input
          name="contract"
          class="contract"
          placeholder="Contract (optional, pilean verifier)"
          disabled={running}
        />
        <label class="check">
          <input type="checkbox" name="reclone" disabled={running} />
          re-clone
        </label>
        <button type="submit" class="go" disabled={running || !state.hasApiKey}>
          {running ? "running…" : "Run both"}
        </button>
        <button type="button" class="stop" onclick={() => actions.stop()} disabled={!running}>
          Stop
        </button>
      </form>

      <div class="filters">
        {AGENT_ORDER.map((id) =>
          filterCheck(id, state.filter[id], (e) => actions.setFilter(id, e.target.checked)),
        )}
        {filterCheck("raw stdout/stderr", state.filter.noise, (e) =>
          actions.setFilter("noise", e.target.checked),
        )}
        {filterCheck("follow", state.follow, (e) => actions.setFollow(e.target.checked))}
        <span class="count">{`${visible.length} / ${state.events.length} events`}</span>
      </div>

      <main class="columns">
        {AGENT_ORDER.map((id) =>
          agentColumn(
            id,
            state.agents[id],
            visible.filter((e) => e.agent === id),
          ),
        )}
      </main>

      <footer class="engine">
        <div class="engine-title">engine</div>
        <div class="stream stream-engine" data-stream="engine">
          {engineEvents.length === 0 ? (
            <div class="empty">idle</div>
          ) : (
            engineEvents.map((e) => eventRow(e))
          )}
        </div>
      </footer>
    </div>
  );
}
