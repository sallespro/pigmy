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
- **Network isolation**: `--network none` by default. litebox's own
  networking is opt-in via `--tun-device-name`, which this service never
  passes, so a guest app has no network reachability by construction.
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

- `POST /sandboxes` `{entry, files: {path: content}, timeoutMs?, memory?, cpus?}` -> `202 {id, status}`
- `GET /sandboxes/:id` -> lifecycle record
- `GET /sandboxes/:id/logs` -> plaintext combined stdout/stderr
- `POST /sandboxes/:id/stop` -> force-kills a running sandbox
- `DELETE /sandboxes/:id` -> removes a terminal sandbox's on-disk state
- `GET /sandboxes` -> list all tracked sandboxes

### Environment variables

`SANDBOX_SERVICE_PORT`, `SANDBOX_IMAGE`, `SANDBOX_WORK_ROOT`,
`SANDBOX_MAX_CONCURRENT`, `SANDBOX_DEFAULT_TIMEOUT_MS`, `SANDBOX_MAX_TIMEOUT_MS`,
`SANDBOX_DEFAULT_MEMORY`, `SANDBOX_DEFAULT_CPUS`, `SANDBOX_MAX_APP_BYTES`,
`SANDBOX_MAX_ENTRY_BYTES`.

## Validated

3 simultaneous sandboxes spawned via the HTTP API, each running a distinct
test app, all completed independently with correct isolated output and zero
cross-contamination (see `validate-concurrent.js`). Stop and delete endpoints
verified against a live long-running sandbox. Path-traversal rejection
verified on both the entry path and app file paths.
