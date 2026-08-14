# sand

A sandbox that clones two pi agent harnesses, runs them on the same task at
the same time, and streams every event either one produces to a web app.

The two harnesses are governed by different disciplines. Running them side
by side on one task is what makes the difference legible: the same answer
can arrive through a spine that refuses a transition and sweeps, or through
an admission layer that witnesses every tool call.

| Agent | Repo | Discipline | Entry |
|---|---|---|---|
| `pilean` | [sallespro/pilean](https://github.com/sallespro/pilean.git) | lean method | `bin/lean-har.mjs` |
| `pigmy` | [sallespro/pigmy](https://github.com/sallespro/pigmy.git) | gm admission | `har/bin/pi-gm.mjs` |

## Run it

Put an OpenAI key in `sand/.env`:

```bash
echo "OPENAI_API_KEY=sk-..." > sand/.env
```

Then:

```bash
cd sand && npm install && npm start
```

Open <http://localhost:7801>, type a task, press **Run both**.

The first run clones both repos and installs their dependencies, so it takes
a minute or two. Later runs reuse the clones; tick **re-clone** to start from
a fresh checkout.

## What happens on a run

1. Each repo is cloned into `run/agents/<id>/` if it is not there already.
2. `npm install` runs in each clone's package root.
3. Each agent gets an empty workspace at `run/workspaces/<runId>/<id>/`.
4. Both agents are spawned **concurrently** against the same task.
5. Every line either one writes is parsed, sequenced, and streamed to the app.

Preparation is deliberately sequential and execution deliberately concurrent:
two `npm install`s racing on a cold cache produce failures that look like
agent bugs, but running the agents together is the entire point.

## Credentials

`sand/.env` is read once, by the server, and injected into each agent's
process environment at spawn. Both harnesses let the process environment
override their own `.env`, so the key is never written into a clone and
never appears anywhere under `run/`.

## The event stream

Both harnesses log to stderr in the same shape, and the engine turns each
line into a sequenced event:

```
[witness] tool=write_file outcome=ok noop=false
```

```json
{ "seq": 18, "at": 1786723708290, "runId": "run-...", "agent": "pigmy",
  "kind": "agent", "phase": "run", "type": "witness",
  "fields": { "tool": "write_file", "outcome": "ok", "noop": "false" } }
```

`kind` is one of `lifecycle` (the engine narrating), `agent` (a parsed
harness event), `status` (an agent card patch), or `stdout`/`stderr` (a line
that did not parse -- a stack trace or usage message, kept rather than
dropped). Every run is also appended to `run/runs/<runId>/events.jsonl`.

The sequence number is what makes reconnection lossless: the browser asks
for `/api/events?since=N` and receives exactly what it missed.

## Each workspace is its own git repository

This is load-bearing. Both harnesses evaluate their gates with
`git diff HEAD` against the workspace. If the workspace is merely a
directory inside some other repository, git walks up and finds *that*
repository, and the agent is judged on unrelated uncommitted changes
elsewhere in the tree -- the same gate then refuses every run, identically,
whatever the task was.

So the supervisor runs `git init` in each workspace and commits an empty
baseline, and each agent is briefed to `git add -A` its work so the diff the
gates read is its own. Unstaged work is invisible to `git diff HEAD`, which
means a perfect file that was never staged is judged as if it never existed.

## Artifacts

The event stream says what an agent *did*; the artifacts are what it
produced. Each column lists the files left in that agent's workspace, and
clicking one opens it: `.html` renders, everything textual shows its source.

Generated pages are rendered in an `<iframe sandbox="" srcdoc="...">`. The
markup came from a model, so it is displayed with scripts and same-origin
access withheld rather than trusted against this app's origin. Reads are
confined to the workspace -- a name that resolves outside it is refused, not
served.

Both harnesses tend to read "provide HTML" as "print HTML to stdout", which
leaves nothing to open. Each agent is therefore briefed to write documents
to a file in the workspace root as well.

## Exit codes are verdicts, not failures

`pilean` exiting 1 means its sweep *surfaced* -- a condition needs a person --
which is a real outcome of the lean method, not a crash. The UI shows it as
`surfaced` with the refusing gate in the stream. Without `--contract`, the
`BUILD -> VERIFY` gate cannot pass, so a bare run is expected to surface.

| Agent | 0 | 1 | 2 |
|---|---|---|---|
| `pilean` | `fixpoint` | `surfaced` | `error` |
| `pigmy` | `completed` | `refused` | `misconfigured` |

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/state` | current run and per-agent status |
| `GET /api/events?since=N` | SSE feed, replaying everything after `N` |
| `POST /api/run` | `{ task, contract?, reclone? }` |
| `POST /api/stop` | SIGTERM every live child |
| `GET /api/artifacts?runId=` | files each agent produced in that run |
| `GET /api/artifact?runId=&agent=&name=` | one artifact's content |

## Layout

```
src/engine/agents.mjs      what differs between the two harnesses
src/engine/events.mjs      event bus, line splitter, stderr parser
src/engine/artifacts.mjs   listing and reading what an agent produced
src/engine/supervisor.mjs  clone, install, spawn, narrate
src/engine/server.mjs      static files, control endpoints, SSE
src/web/                   the webjsx app
bin/verify.mjs             offline checks (npm run verify)
run/                       clones, workspaces, logs (gitignored)
```

Adding a third agent means adding a row to `agents.mjs`. The supervisor
knows only "a repo, a command, an argv mapping".

## A note on webjsx

webjsx renders intrinsic elements only -- it has no component model. Its JSX
factory *discards* a non-string type instead of invoking it, so `<Row x={1}/>`
silently renders nothing. The view is therefore written as plain functions
returning vnodes, called directly rather than used as tags. State lives in
`src/web/store.js`, and every change re-renders the tree through `applyDiff`,
which patches only what actually differs.

## Verify

```bash
npm run verify
```

Twenty offline checks over the parser, the replay cursor, the argv mapping,
the exit-code classification, the answer formatting, artifact classification,
and the workspace-traversal guard. Nothing here spends API budget: a run that
costs money is not a test.
