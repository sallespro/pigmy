# lean-har

A [pi](https://github.com/earendil-works/pi) agent harness governed by the
[lean](https://github.com/AnEntrypoint/lean) method, running on OpenAI
`gpt-5.6-luna`.

pi supplies the agent runtime and its hook seams. lean supplies the discipline:
nine phases, five spine gates, and a sweep loop with exactly two terminals. This
harness is the join — the gates are predicates evaluated against the real
repository, not instructions the model is asked to honour.

Sibling to `har/`, which is the same idea under the gm method. Neither depends on
the other.

## Run

```bash
cd lean-har && npm install
```

```bash
node bin/lean-har.mjs "Count the lines in README.md and report the number"
```

```bash
node bin/lean-har.mjs --root /path/to/workspace --contract "parse(input: Utf8): Accepted | Rejected" "Implement the parser"
```

Exit code 0 means the sweep reached a fixed point. Exit code 1 means it
surfaced: a condition needs a person.

## Verify

```bash
node bin/verify.mjs
```

```bash
node bin/verify.mjs --live
```

`--live` makes one real API call. If the model id is rejected, the failure
reports the provider's error and the available `gpt-5*` models rather than
substituting a different model.

## The gates

| Gate | Guards | Holds when |
|---|---|---|
| `one task in flight` | entry to SHAPE | No second plan is live. |
| `contract is the only durable description` | SHAPE to CONTRACT | No added line in the diff is a comment restating the code. |
| `verifier has not read the implementation` | BUILD to VERIFY | An independent verifier reported, and never opened an implementation path. |
| `change closes net-negative, or states why not` | VERIFY to PRESSURE | Added minus removed lines is at most zero, or a growth reason is on the record. |
| `contract satisfied and recorded` | RECORD to CONVERGENCE | Properties hold and the commit message carries the why. |

A refused transition is not a stop. It opens a condition, routes it back to the
phase that owns it via the method graph's labelled backreferences, and feeds the
refusal to the model as a steering message.

## Convergence

The sweep re-evaluates every gate and counts open conditions. That count is the
well-founded variant.

- **fixpoint** — no gate reopened and nothing changed. The operational meaning of
  done, not a proof of correctness.
- **surface** — the variant failed to fall, a gain from an earlier sweep was
  lost, or one condition recurred across two sweeps with no new information. The
  loop stops and hands the ambiguity to a person rather than burning budget.

A condition seen twice inside a single sweep is not a stall; only recurrence
across distinct sweeps is.

## Enforced on the agent

`no test files` — a write to `*.test.*`, `*.spec.*` or a `tests/` directory is
blocked at `beforeToolCall`. Verification is properties checked by an agent that
has not read the implementation. The verifier runs in its own pi context with
read-only tools and no shared history; a read of a declared implementation path
is blocked and recorded, which fails `VERIFIER_BLIND`.

Every executed tool call is appended to a witness ledger. A claim without a
witness is not evidence.

## Credentials and model

`OPENAI_API_KEY` is read from `../lean/.env`, then overridden by the process
environment. The key is never logged: known secret values and key-shaped
literals are masked from tool output, transcripts and errors.

pi ships an empty model catalog in a plain install, so the provider is built from
pi's own `envApiKeyAuth` and `openAIResponsesApi` with a supplied descriptor for
`gpt-5.6-luna`.

Override with `LEAN_HAR_MODEL`, `LEAN_HAR_MAX_TURNS`, `LEAN_HAR_MAX_SWEEPS`,
`LEAN_HAR_EXEC_TIMEOUT_MS`, `LEAN_HAR_MAX_OUTPUT_BYTES`, `LEAN_HAR_ROOT`.

## State

`.lean/` under the workspace root: `phase.json`, `conditions.json` (open and
closed conditions with the sweeps that saw them), `sweep-log.jsonl` (variant
history), `witness.jsonl`.
