# pi-gm harness -- specification

A custom agent harness that runs a [pi](https://github.com/earendil-works/pi) agent under the
admission discipline of [gm](https://github.com/AnEntrypoint/gm).

pi supplies the agent runtime: model streaming, tool dispatch, transcript state, and a set of
lifecycle hooks. gm supplies the discipline: a phase machine, a gate registry, and a
three-layer admission filter that decides which mutations are allowed to happen at all.

This harness is the join. Every mutation a pi agent attempts is routed through gm's admission
filter before it executes, and every mutation that does execute is recorded as a witness tuple.
Phase advancement is gated on predicates evaluated against real repository state.

---

## 1. Why this exists

A stock agent loop executes whatever the model asks for. The model proposes a tool call, the
runtime runs it, the result goes back into context. Nothing structurally distinguishes a
correct mutation from a plausible-looking one, and nothing prevents the agent from declaring
work finished while state contradicts the claim.

gm's answer is that a claim without a witness is not in the system. This harness enforces that
mechanically:

- A tool call that would mutate state is admitted only if it passes three filter layers.
- An admitted mutation produces an append-only `(id, hash, ts)` audit tuple.
- A phase advances only when its outbound edge's gate predicates evaluate true against real
  state -- git status, the PRD file, the witness ledger -- never against the model's assertion.
- Completion is a gate, not a decision. Ten predicates must hold simultaneously.

The result is an agent that can run code, as gm prescribes, without being trusted to
self-report whether it did so correctly.

---

## 2. Upstream contracts this depends on

These were read from source, not assumed. Both are pinned facts the implementation binds to.

### 2.1 pi

Monorepo, TypeScript ESM, `node >= 22.19.0`. The relevant package is
`@earendil-works/pi-agent-core` (`packages/agent`), which exports an `Agent` class and the
lower-level `agentLoop` / `runAgentLoop` functions.

`AgentLoopConfig` (`packages/agent/src/types.ts`) exposes the seams this harness attaches to:

| Hook | Signature | Used for |
| --- | --- | --- |
| `beforeToolCall` | `(ctx, signal) => Promise<{block?, reason?, terminate?}>` | Admission filter (L1/L2/L3) |
| `afterToolCall` | `(ctx, signal) => Promise<{content?, details?, isError?, usage?, terminate?}>` | Witness capture |
| `shouldStopAfterTurn` | `(ctx) => boolean` | Continuation invariant |
| `prepareNextTurn` | `(ctx) => {context?, model?, thinkingLevel?}` | Phase-aware context/model swap |
| `getSteeringMessages` | `() => Promise<AgentMessage[]>` | Gate-denial feedback injection |
| `convertToLlm` | `(messages) => Message[]` | Required; maps transcript to provider messages |

Two contract details govern the implementation:

- **Hooks must not throw.** The pi docs state throwing interrupts the loop without a normal
  event sequence. Every hook in this harness is total: it catches internally and returns a safe
  fallback (`fail-closed` for admission, `undefined` for witness).
- **`beforeToolCall` returning `{block: true}`** causes pi to emit an error tool result carrying
  `reason` instead of executing. This is the enforcement primitive -- the harness never needs to
  monkey-patch tool execution.

Tool shape (`AgentTool`):

```ts
{
  label: string;
  execute(toolCallId, params, signal?, onUpdate?): Promise<AgentToolResult<T>>;
  executionMode?: "sequential" | "parallel";
  prepareArguments?(args: unknown): Static<TParameters>;
}
```

`execute` throws on failure rather than encoding errors in `content`.

### 2.2 Model: `gpt-5.6-luna`

Verified live against the OpenAI Responses API with the key in `har/.env`:

```
POST https://api.openai.com/v1/responses   {"model":"gpt-5.6-luna", ...}
-> status: "completed", model: "gpt-5.6-luna", output[].content[].text: "PONG"
```

Note that pi's `models.generated.ts` is produced at build time by `npm run generate:models` and
is empty in a fresh clone. The harness therefore does not assume catalog population: it resolves
the model through pi's `getModel("openai", "gpt-5.6-luna")` when the catalog is available and
falls back to a direct Responses-API model descriptor when it is not. Both paths are exercised.

The model is reasoning-capable (`reasoning.effort: "medium"` by default) and supports tool
calling and `parallel_tool_calls`.

### 2.3 gm

The phase machine and gate registry are taken from `AnEntrypoint/gm-config`
(`fsm/graph.json`, `fsm/predicates.md`) -- the same definitions gm's own plugkit serves.

---

## 3. Architecture

```
                         +---------------------------+
   task ----------------->        Harness CLI        |
                         +-------------+-------------+
                                       |
                         +-------------v-------------+
                         |      Phase Machine        |
                         |  9 states / 21 edges      |
                         +------+-------------+------+
                                |             |
                   transition   |             |  gate evaluation
                                v             v
                    +-----------+--+    +-----+------------------+
                    | Gate Registry |<--| Repo + Store probes    |
                    | 15 predicates |   | git, prd, mutables,    |
                    +-----------+---+   | witness ledger         |
                                        +------------------------+
                                       |
                         +-------------v-------------+
                         |        pi Agent           |
                         |  agentLoop + hooks        |
                         +--+--------+--------+------+
       beforeToolCall       |        |        |    afterToolCall
                            v        |        v
              +-------------+--+     |   +----+-------------+
              | Admission Filter|    |   | Witness Ledger   |
              | L1 witness      |    |   | append-only      |
              | L2 single-writer|    |   | (id, hash, ts)   |
              | L3 direction    |    |   +------------------+
              +-----------------+    |
                                     v
                              +------+---------+
                              |  Tool Surface  |
                              | exec/read/     |
                              | write/list     |
                              +----------------+
```

State lives in `.gm-pi/` at the repository root, deliberately namespaced apart from gm's own
`.gm/` so the harness can run inside a repo that is itself under gm without colliding.

```
.gm-pi/
  phase.json        current phase + history
  prd.yml           requirement rows
  mutables.yml      open proof obligations
  witness.jsonl     append-only audit tuples
  markers/          residual-scan, ci-validated
```

---

## 4. The admission filter

Every tool call passes three layers in order. Any layer rejecting blocks execution. The filter
fails **closed**: an internal error in the filter is a rejection, never a pass-through.

### L1 -- witness

Admit on witness, not on cheapness. A tool call asserting a state change that has not been
measured is rejected; a correct, witnessed mutation is admitted regardless of cost. The only
cost weighed is the correctness-cost of an unverified claim -- never effort.

Concretely: a call that claims completion (`complete`, `resolve`) for a target with no
corresponding witness tuple in the ledger is rejected with the missing target named.

### L2 -- single-writer

Each mutable surface has writer capacity 1. A write to a surface already claimed by an
in-flight writer is backpressured to a defer queue rather than racing. A write outside any
sanctioned surface is unreconcilable and inadmissible.

Surfaces are derived from the tool call: a file write claims its normalized absolute path; an
exec claims its working directory. Claims are released when the tool result is finalized in
`afterToolCall`.

This is a crash-safety floor on concurrent writes, not a coverage ceiling. It never reduces
what the agent may attempt -- only how many writers may touch one surface at once.

### L3 -- direction

Motion that does not reduce distance to the goal is dead. Each accepted dispatch appends an
audit tuple, and the recent tuple sequence is classified as
`convergent | flat | divergent | chaotic`. On a non-convergent classification the filter holds
and requires re-orientation rather than admitting more motion.

The concrete signal is repetition: identical `(surface, hash)` dispatches recurring with
different outcomes indicate non-idempotent thrash, and a run of no-op mutations indicates flat
motion.

---

## 5. Phase machine

Nine states. Twenty-one edges: eight forward, twelve feedback, one self-loop on `COMPLETE`.

```
SPECIFY -> PROVE -> EMIT -> STATE -> CONC -> SEC -> RES -> DECIDE -> COMPLETE
```

Feedback edges (a later stage's discovery routes backward):

| From | To |
| --- | --- |
| PROVE, EMIT, STATE, RES, DECIDE | SPECIFY |
| STATE, CONC, SEC, RES | EMIT |
| CONC, SEC | STATE |
| DECIDE | PROVE |

Stage ownership:

| Phase | Owns | Outbound gates |
| --- | --- | --- |
| SPECIFY | alignment, research, PRD density | none |
| PROVE | mutable proof obligations | `mutables-all-resolved` |
| EMIT | source emission | `no-synthetic-test-files`, `no-graphical-symbols-in-diff`, `no-admit-deferral-markers` |
| STATE | totality, ownership, idempotency | `idempotent-dispatch-replay-safe` |
| CONC | happens-before, disjointness | none |
| SEC | zero-trust, secrets, injection | `no-secrets-in-diff` |
| RES | exception model, degradation | `no-unchecked-panics-in-diff` |
| DECIDE | adversarial verification, commitment | the full closure set (10 predicates) |

A transition is a request. The machine evaluates the edge's gates against real state and either
advances or refuses with the failing predicates named. A refusal is not an error condition --
it is information routed back to the agent as a steering message.

---

## 6. Gate registry

Sixteen predicates, semantics taken verbatim from gm's `fsm/predicates.md`.

| Predicate | True when |
| --- | --- |
| `prd-all-closed` | `prd.yml` has zero rows in an open status |
| `mutables-all-resolved` | `mutables.yml` has zero rows in unknown/pending status |
| `worktree-clean` | `git status --porcelain` is empty |
| `residual-scan-fired` | residual-scan marker present and non-empty |
| `ci-validated-fresh` | ci-validated marker's `head_sha` equals current `git rev-parse HEAD` |
| `browser-witness-coverage` | every edited client-side file has a witness entry with matching content hash |
| `app-loads-witnessed` | the application has been observed loading |
| `submodules-clean` | no submodule drifted from its recorded commit |
| `claim-audit-clean` | no unwitnessed completion claims |
| `no-hedge-language-in-diff` | touched `*.md` introduce no hedge phrase |
| `no-synthetic-test-files` | diff introduces no `*.test.*`, `*.spec.*`, or `test/` directory |
| `no-graphical-symbols-in-diff` | new lines introduce no decorative non-ASCII glyph |
| `no-admit-deferral-markers` | new source lines introduce no colon-form admit marker, no placeholder macro, no "not yet implemented" phrase |
| `no-secrets-in-diff` | diff introduces no AWS key id, PEM header, bearer/API token literal, or DB URL with inline password |
| `no-unchecked-panics-in-diff` | new lines introduce no bare `unwrap()`/`expect()`/`panic!()` outside test paths, and no unpaired `throw` |

Two doctrinal points these encode:

**`no-synthetic-test-files` is not an oversight.** gm's VERIFY doctrine holds that verification
is a live witness against real code, never a suite asserting against mocks. This harness is
verified by executing it and reading actual output. That is why the verification described in
section 9 runs the real agent against the real model rather than shipping a mock-based suite --
a suite of that shape would itself trip this gate.

**`no-secrets-in-diff` guards a live key.** `har/.env` holds a real `OPENAI_API_KEY`. It is
gitignored, never logged, and redacted on every output surface including error paths and
witness records.

---

## 7. Tool surface

Four tools, each a sanctioned mutable surface under L2.

| Tool | Surface claimed | Mutating |
| --- | --- | --- |
| `exec` | working directory | yes |
| `write_file` | normalized absolute path | yes |
| `read_file` | none | no |
| `list_dir` | none | no |

`exec` is the capability gm prescribes -- the agent runs real code and reads real output. It
enforces a wall-clock timeout, captures `stdout`/`stderr`/`exitCode` separately, and truncates
captured output at a bounded size so a runaway process cannot exhaust context. Its result is
witnessed: the audit tuple hashes the command and its observed output.

Non-mutating tools skip L2 entirely (no surface to claim) but still pass L1 and L3, and still
produce witness tuples -- a read is evidence, and evidence is what L1 later admits against.

---

## 8. Witness ledger

Append-only JSONL. One record per accepted dispatch:

```json
{"id":"<toolCallId>","surface":"/abs/path","hash":"<sha256 of normalized input+output>",
 "ts":1786649000000,"outcome":"ok","tool":"write_file"}
```

Append-only is load-bearing for replay: `idempotent-dispatch-replay-safe` is decided by scanning
for an exact `(id, hash)` pair recorded under two different outcomes, which is only detectable
if history is never rewritten. `claim-audit-clean` is decided by checking that every completion
claim has a corresponding tuple.

Records are written before the tool result is returned to the model, so a crash between
execution and response leaves the mutation witnessed rather than invisible.

---

## 9. Verification plan

Verification is by live execution, per section 6.

**Live model witness.** The harness runs an end-to-end task against `gpt-5.6-luna` using the
key in `har/.env`: the agent is asked to write a program, execute it, and report the real
output. Passing requires the observed stdout to match the expected computation -- evidence the
full path (model -> tool call -> admission -> exec -> witness -> result -> model) works.

**Gate negative witness.** Each gate is exercised adversarially by constructing the state it is
supposed to refuse and confirming it refuses:

| Gate | Constructed violation |
| --- | --- |
| `no-secrets-in-diff` | stage a line containing a token-shaped literal |
| `no-hedge-language-in-diff` | stage a `.md` line containing a hedge phrase |
| `no-admit-deferral-markers` | stage a source line carrying a colon-form admit marker |
| `worktree-clean` | leave an uncommitted file |
| `mutables-all-resolved` | leave a pending mutable row |
| `idempotent-dispatch-replay-safe` | append two conflicting outcomes for one `(id, hash)` |

A gate that passes when it should refuse is a defect, not a tuning parameter.

**Admission negative witness.** Two writers contending for one surface: the second is deferred,
not raced. A completion claim with no backing witness tuple: rejected by L1.

---

## 10. Configuration

Environment is read from `har/.env`:

| Variable | Required | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | Provider credential; never logged |
| `PI_GM_MODEL` | no | Model id, default `gpt-5.6-luna` |
| `PI_GM_EXEC_TIMEOUT_MS` | no | Per-exec wall clock, default 120000 |
| `PI_GM_MAX_TURNS` | no | Turn ceiling for one run, default 40 |

`PI_GM_MAX_TURNS` bounds a single run's provider calls. It is a runaway-loop stop, not a work
budget: exhausting it surfaces the remaining PRD rows rather than declaring the task finished.

---

## 11. Failure model

Every raised error is handled or explicitly propagated; none is left to crash the process
uncaught (this is what `no-unchecked-panics-in-diff` enforces on the diff).

| Failure | Response |
| --- | --- |
| Provider call fails | retry with backoff; surface after exhaustion, phase unchanged |
| Tool throws | captured as an error tool result; witnessed with `outcome: "error"` |
| Admission filter throws | fail closed -- treated as a rejection |
| Gate probe throws | predicate is false; transition refused |
| Ledger write fails | dispatch aborts before the tool runs |
| Interrupt mid-tool | surface claim released; partial state witnessed |

The unifying rule: a failure never silently converts into an apparent success, and never
advances a phase.
