# litebox sandbox service

Spawns isolated litebox+Alpine sandboxes on demand to run untrusted Node.js
apps, each in its own Docker container for process/filesystem/network
isolation. Builds on the litebox integration proven in `../run-alpine-node.sh`.

## Architecture

- `Dockerfile` builds `litebox_packager` + `litebox_runner_linux_userland`
  **once** and bakes in the nodejs-enabled Alpine base rootfs
  (`ghcr.io/anentrypoint/litebox-alpine-base:latest`), so a sandbox spawn
  never pays the ~15min cargo rebuild `run-alpine-node.sh` pays per call.
- `entrypoint.sh` runs inside every sandbox container: copies the baked
  read-only base rootfs to the sandbox's own bind-mounted output dir, appends
  that sandbox's app files, and runs litebox against the copy.
- `server.js` is the HTTP service: spawn/status/logs/stop/delete, a
  concurrency cap, per-sandbox resource limits and timeouts, and a lifecycle
  registry.
- `validate-concurrent.js` is an operational driver (not a test file) that
  spawns N sandboxes concurrently and verifies each produced its own correct,
  uncontaminated output.

## Isolation model

- **Process isolation**: one Docker container per sandbox (`--privileged`,
  required by litebox's own seccomp/namespace setup), never shared.
- **Filesystem isolation**: each sandbox gets its own copy of the base rootfs
  tar (never a shared mutable tar across sandboxes) plus its own
  `--export-writable-layer` path under `.sandboxes/<id>/out/writable-layer.tar`
  -- this is what avoids litebox's own documented hazard of two sandboxes
  racing on one shared export path and silently corrupting both archives.
- **Network isolation**: `--network none` by default. Opt in per spawn with
  `"network": true` -- the container then creates+NATs its own TUN device
  (`ip tuntap`, `iptables MASQUERADE`) and passes `--tun-device-name` to
  litebox, since litebox itself only forwards guest<->TUN packets and
  provides no NAT/internet routing on its own. **See "Known litebox
  limitations" below: this path is NAT-correct at the container level
  (verified -- packets do reach MASQUERADE) but guest-side internet egress
  has not been proven to complete a round trip; treat `network: true` as
  experimental until that's resolved upstream.**
- **Secrets**: opt in per spawn with `"env": {"NAME": "value"}` -- passed
  straight to litebox's own `--env NAME=value` (never `--forward-env`, which
  would leak this whole container's environment into the guest). Names are
  allow-listed against `^[A-Za-z_][A-Za-z0-9_]*$`; values are never written
  to the sandbox's persisted `in`/`out` files or logs.
- **Resource limits**: `--cpus`/`--memory` per container (litebox itself has
  no resource-limit flag) plus `--pids-limit 256` and a wall-clock timeout
  enforced by the host service via `docker kill`.
- **Input validation**: entry path and every app file path are checked against
  path traversal / absolute-path escape before ever reaching the filesystem or
  the tar-append step.
- **Concurrency cap**: `SANDBOX_MAX_CONCURRENT` (default 8) bounds
  simultaneously running containers; excess spawns queue.

## Known memory requirement

litebox_runner_linux_userland mmaps the full base rootfs tar (~680MB for the
nodejs image); the entrypoint also copies it to the sandbox's bind-mounted
output dir before appending the app (not `/tmp`, which is tmpfs and would
double-count against the container's memory cgroup). The default `1536m`
memory limit covers this; do not lower it below roughly 1GB or sandboxes will
be OOM-killed (`exit 137`) even for a trivial script.

## Usage

```bash
npm run build-image     # one-time (or after a litebox/Dockerfile change)
npm start                # starts the HTTP service on :8787
node validate-concurrent.js 3   # spawns 3 concurrent sandboxes and reports pass/fail
```

### API

- `POST /sandboxes` -- one of two mutually exclusive payload shapes:
  - file mode: `{entry, files: {path: content}, timeoutMs?, memory?, cpus?, network?, env?, mode?, publishPort?}`
  - command mode: `{command, timeoutMs?, memory?, cpus?, network?, env?, mode?, publishPort?}`
    runs `/bin/sh -c "<command>"` as the guest's sole process instead of
    `node <entry>` -- **but see "Known litebox limitations": a command that
    itself spawns and waits on a second process crashes litebox, so this is
    only useful for a single external binary invocation, not a multi-step
    shell pipeline.**
  - `mode: "server"` marks a sandbox that's expected to stay running rather
    than complete quickly (longer default timeout; still bounded by
    `SANDBOX_MAX_TIMEOUT_MS` and stoppable via `/stop`).
  - `publishPort` (requires `network: true`) publishes a host port and DNATs
    it to the guest's `10.0.0.2` for a server-mode sandbox to be externally
    reachable -- untested end-to-end pending the networking limitation below.
  -> `202 {id, status}`
- `GET /sandboxes/:id` -> lifecycle record
- `GET /sandboxes/:id/logs` -> plaintext combined stdout/stderr
- `POST /sandboxes/:id/stop` -> force-kills a running sandbox
- `DELETE /sandboxes/:id` -> removes a terminal sandbox's on-disk state
- `GET /sandboxes` -> list all tracked sandboxes

### Environment variables

`SANDBOX_SERVICE_PORT`, `SANDBOX_IMAGE`, `SANDBOX_WORK_ROOT`,
`SANDBOX_MAX_CONCURRENT`, `SANDBOX_DEFAULT_TIMEOUT_MS`, `SANDBOX_MAX_TIMEOUT_MS`,
`SANDBOX_DEFAULT_MEMORY`, `SANDBOX_DEFAULT_CPUS`, `SANDBOX_MAX_APP_BYTES`,
`SANDBOX_MAX_ENTRY_BYTES`, `SANDBOX_MAX_COMMAND_BYTES`.

## Validated

3 simultaneous sandboxes spawned via the HTTP API, each running a distinct
test app, all completed independently with correct isolated output and zero
cross-contamination (see `validate-concurrent.js`). Stop and delete endpoints
verified against a live long-running sandbox. Path-traversal rejection
verified on both the entry path and app file paths. A single-process Node.js
script ran cleanly with `network: true` set (no crash, confirmed via
`iptables` packet counters that litebox does emit real packets onto the
NATed TUN device) -- see below for what's still open.

## Known litebox limitations (found live, not assumed)

Attempting to run `github.com/sallespro/sand` -- a Node app that clones repos,
runs `npm install`, and spawns child agent processes -- surfaced two real gaps
in `litebox_runner_linux_userland`/`litebox_platform_linux_userland`
(upstream `AnEntrypoint/litebox`, not something fixable in this service):

1. **Any guest process that spawns a child and waits on it crashes litebox.**
   Reproduced three ways: (a) two ELF binaries run sequentially in one
   `/bin/sh -c "cmd1; cmd2"` -- segfaults on `cmd1`'s own exit, regardless of
   `;` vs `&&`, and regardless of whether `cmd1` is `git`, `node`, or anything
   non-trivial (a bare `echo; echo` does *not* crash, so this is specific to
   binaries with real cleanup paths); (b) `child_process.execSync`/`spawnSync`
   from Node, any `stdio` mode -- hard panic, not a segfault:
   `thread 'main' panicked at litebox_platform_linux_userland/src/lib.rs:1453:9: not implemented`,
   which is an `unimplemented!()` on an anonymous `MAP_SHARED` mmap request
   (a different, still-open code path from the file-backed `MAP_SHARED` fix
   litebox's own recent changelog mentions). This means `npm install`,
   `npm start` for anything that itself forks (nearly everything), and
   sand's own two-agent-subprocess design cannot run inside litebox as it
   exists today. **This service now enforces single-process invocations
   only** (`command` mode's docstring above); there is no workaround at the
   sandbox-service layer for a workload that genuinely needs fork/exec.
2. **Internet egress through a NATed TUN device is unproven.** litebox's own
   test suite (`litebox_runner_linux_userland/tests/run.rs`) only proves
   host<->guest reachability over the TUN at fixed addresses
   (`10.0.0.1`/`10.0.0.2`, e.g. `test_tun_with_curl`) -- never a guest
   reaching the real internet. This service's own container-level NAT setup
   is confirmed correct (`iptables -t nat -L POSTROUTING` shows the outbound
   SYN hitting MASQUERADE), but a guest-side TCP connect to a hardcoded
   internet IP still times out with no reply, and neither
   `litebox_platform_linux_userland`'s source nor its tests show it
   configuring a guest-side default route beyond the fixed `/24` -- the
   guest's own IP stack (smoltcp-based) appears to need address/route
   configuration this service does not currently know how to drive from a
   stock Node.js app. Treat `network: true` as *sends real packets, response
   path unverified* until this is root-caused.

Given both, `sand` cannot run inside this sandbox today. The `network`/`env`/
command-mode extensions built while investigating this remain useful for
single-process, no-network-required workloads (the file-mode 3-concurrent
validation above still passes unmodified) and for single-process workloads
against a service already reachable at a fixed `10.0.0.1` host address (per
litebox's own proven `test_tun_with_curl` pattern), but general internet
egress and any multi-process guest workload need upstream litebox work
first.
