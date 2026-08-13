# pi-gm harness

A [pi](https://github.com/earendil-works/pi) agent that runs code under
[gm](https://github.com/AnEntrypoint/gm) admission discipline.

pi provides the agent runtime and its lifecycle hooks. gm provides the
discipline: a nine-state phase machine, fifteen gate predicates, and a
three-layer admission filter. This harness joins them, so every mutation the
agent attempts is admitted or refused before it runs, and every mutation that
runs is recorded as an audit tuple.

The design rationale and full contract are in [spec.md](spec.md).

## Requirements

- Node 22.19 or newer
- `git` on `PATH`
- An OpenAI API key in `.env`

## Setup

```bash
npm install
```

Create `.env` in this directory:

```
OPENAI_API_KEY=sk-your-key-here
```

`.env` is gitignored, and the key is redacted from every log line, witness
record, and error path.

## Use

Run the agent against a task:

```bash
node bin/pi-gm.mjs "Write a script that counts lines in README.md, run it, and report the count"
```

Run it against a different workspace:

```bash
node bin/pi-gm.mjs --workspace /path/to/project "Fix the failing build and prove it passes"
```

Inspect the current phase and every gate verdict:

```bash
node bin/pi-gm.mjs --phase
```

Walk the phase chain as far as the gates permit:

```bash
node bin/pi-gm.mjs --advance
```

Report gate status for any workspace (exit 0 when all pass, 1 otherwise):

```bash
node bin/gates.mjs /path/to/project
```

## Verification

Verification runs real code and reads real output. There is no mock-based
suite, deliberately: gm's `no-synthetic-test-files` gate refuses one, on the
grounds that a suite asserting against mocks is not evidence.

Structural checks, no network:

```bash
npm run verify
```

Including a live run against the configured model:

```bash
npm run verify:live
```

The live check asks the agent to write and execute a program, then
independently re-runs the produced file and compares the output. The agent's
report is not treated as evidence; the second execution is.

## What the harness enforces

**Admission.** Each tool call passes three layers before it executes.

| Layer | Refuses |
| --- | --- |
| L1 witness | A completion claim with no supporting entry in the ledger |
| L2 single-writer | A second concurrent writer to a surface already claimed |
| L3 direction | Repeated identical dispatches, or a run of no-op mutations |

A refusal is returned to the model as a blocked tool result explaining the
layer and the reason, so the agent can adapt instead of retrying blindly. The
filter fails closed: an internal error is a refusal.

**Witnessing.** Every executed dispatch appends `(id, tool, surface, hash, ts,
outcome)` to `.gm-pi/witness.jsonl`. The ledger is append-only, which is what
makes replay-conflict detection possible.

**Gating.** A phase advances only when its outbound edge's predicates hold
against real state: git status, the PRD file, the ledger. Reaching `COMPLETE`
requires ten predicates simultaneously. Gate semantics come from gm's own
`fsm/predicates.md`.

## Layout

```
bin/
  pi-gm.mjs      CLI: run the agent, inspect phase, advance the chain
  verify.mjs     adversarial verification
  gates.mjs      standalone gate report
src/
  core/
    config.mjs     credential loading and redaction
    fsm.mjs        nine states, twenty-one edges
    gates.mjs      fifteen gate predicates
    admission.mjs  the three-layer filter
    store.mjs      phase, PRD, mutables, witness ledger
    harness.mjs    the join: pi hooks wired to gm discipline
  model/
    model.mjs      model resolution and provider registration
  tools/
    index.mjs      exec, read_file, write_file, list_dir
```

State is written to `.gm-pi/` in the target workspace, namespaced apart from
gm's own `.gm/` so the harness can operate inside a repository that is itself
under gm.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | required | Provider credential |
| `PI_GM_MODEL` | `gpt-5.6-luna` | Model id |
| `PI_GM_EXEC_TIMEOUT_MS` | `120000` | Per-command wall clock |
| `PI_GM_MAX_TURNS` | `40` | Turn ceiling for one run |
| `PI_GM_MAX_OUTPUT_BYTES` | `64000` | Captured output cap per tool result |

`PI_GM_MAX_TURNS` is a runaway-loop stop, not a work budget: reaching it
surfaces what remains rather than declaring the task finished.

## Extending

Add a tool by appending an entry in `src/tools/index.mjs` following pi's
`AgentTool` shape. If it mutates state, register how it derives its surface in
the `MUTATING` map in `src/core/admission.mjs` so L2 can claim it; otherwise it
is treated as read-only and skips surface claiming.

Change the phase graph by editing `EDGES` in `src/core/fsm.mjs`. Add a gate by
adding a predicate to the registry in `src/core/gates.mjs`; every predicate
returns `{ ok, detail }` and must not throw, since a probe that cannot decide
refuses its edge.
