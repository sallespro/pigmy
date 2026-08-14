#!/usr/bin/env bash
# Build litebox (AnEntrypoint/litebox), package an Alpine rootfs (with Node.js
# baked in), and run a Node.js script inside it via litebox_runner_linux_userland.
#
# litebox_packager and litebox_runner_linux_userland are Linux-only (seccomp-bpf,
# native syscall interception), so on macOS the whole pipeline runs inside a
# Linux Docker container. On a real Linux host, DOCKER_ONLY=0 skips the wrapper
# and builds/runs litebox directly.
#
# Usage:
#   ./run-alpine-node.sh path/to/script.js [node-args...]
#
# Env vars:
#   LITEBOX_REPO   litebox checkout dir      (default: ./litebox)
#   LITEBOX_REF    git ref to build          (default: main)
#   WORK_DIR       scratch dir for build artifacts (default: ./.litebox-work)
#   DOCKER_ONLY    1 = force Docker wrapper, 0 = run natively (default: auto)

set -euo pipefail

SCRIPT_PATH="${1:?usage: $0 path/to/script.js [node-args...]}"
shift
NODE_ARGS=("$@")

LITEBOX_REPO="${LITEBOX_REPO:-$PWD/litebox}"
LITEBOX_REF="${LITEBOX_REF:-main}"
WORK_DIR="${WORK_DIR:-$PWD/.litebox-work}"
ROOTFS_TAR="$WORK_DIR/alpine-rootfs.tar"
# Alpine base image with nodejs/npm/python3 baked in, published by litebox's own
# release-windows-alpine.yml workflow from dist_tools/base-image/Dockerfile.
ALPINE_IMAGE="${ALPINE_IMAGE:-ghcr.io/anentrypoint/litebox-alpine-base:latest}"

SCRIPT_PATH="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)/$(basename "$SCRIPT_PATH")"
mkdir -p "$WORK_DIR"

need_docker_wrapper() {
  if [ "${DOCKER_ONLY:-auto}" = "1" ]; then return 0; fi
  if [ "${DOCKER_ONLY:-auto}" = "0" ]; then return 1; fi
  [ "$(uname -s)" != "Linux" ]
}

build_and_run_native() {
  if [ ! -d "$LITEBOX_REPO" ]; then
    echo "==> Cloning litebox into $LITEBOX_REPO"
    git clone https://github.com/AnEntrypoint/litebox "$LITEBOX_REPO"
  fi
  git -C "$LITEBOX_REPO" fetch --quiet origin "$LITEBOX_REF"
  git -C "$LITEBOX_REPO" checkout --quiet "$LITEBOX_REF"

  echo "==> Building litebox_packager and litebox_runner_linux_userland (release)"
  (cd "$LITEBOX_REPO" && cargo build --locked --release \
    -p litebox_packager -p litebox_runner_linux_userland)

  local PACKAGER="$LITEBOX_REPO/target/release/litebox_packager"
  local RUNNER="$LITEBOX_REPO/target/release/litebox_runner_linux_userland"

  echo "==> Packaging Alpine rootfs (nodejs baked in) -> $ROOTFS_TAR"
  "$PACKAGER" --oci-image "$ALPINE_IMAGE" \
    -o "$ROOTFS_TAR" --verbose

  # litebox_runner_linux_userland's --insert-file is unimplemented() in this build, so the
  # script is baked into the rootfs tar itself (paths inside are guest-root-relative,
  # e.g. usr/bin/node -- no "rootfs/" prefix) instead.
  echo "==> Adding $SCRIPT_PATH to the rootfs tar as /script.js"
  local STAGE_DIR
  STAGE_DIR="$(mktemp -d)"
  cp "$SCRIPT_PATH" "$STAGE_DIR/script.js"
  tar --append --file "$ROOTFS_TAR" -C "$STAGE_DIR" script.js
  rm -rf "$STAGE_DIR"

  echo "==> Running $SCRIPT_PATH inside the Alpine rootfs via litebox"
  "$RUNNER" \
    --unstable \
    --initial-files "$ROOTFS_TAR" \
    --program-from-tar \
    -- /usr/bin/node /script.js "${NODE_ARGS[@]}"
}

run_via_docker() {
  echo "==> No native Linux userland available here; building and running litebox inside Docker"
  docker run --rm \
    --privileged \
    -e LITEBOX_REF="$LITEBOX_REF" \
    -e ALPINE_IMAGE="$ALPINE_IMAGE" \
    -v "$WORK_DIR:/work" \
    -v "$SCRIPT_PATH:/input/script.js:ro" \
    rust:1-bookworm \
    bash -euxc '
      apt-get update -qq && apt-get install -y -qq git >/dev/null
      git clone --quiet https://github.com/AnEntrypoint/litebox /litebox
      cd /litebox && git checkout --quiet "$LITEBOX_REF"
      cargo build --locked --release -p litebox_packager -p litebox_runner_linux_userland
      PACKAGER=./target/release/litebox_packager
      RUNNER=./target/release/litebox_runner_linux_userland
      "$PACKAGER" --oci-image "$ALPINE_IMAGE" -o /work/alpine-rootfs.tar --verbose
      STAGE_DIR="$(mktemp -d)"
      cp /input/script.js "$STAGE_DIR/script.js"
      tar --append --file /work/alpine-rootfs.tar -C "$STAGE_DIR" script.js
      rm -rf "$STAGE_DIR"
      "$RUNNER" \
        --unstable \
        --initial-files /work/alpine-rootfs.tar \
        --program-from-tar \
        -- /usr/bin/node /script.js "$@"
    ' _ "${NODE_ARGS[@]}"
}

if need_docker_wrapper; then
  run_via_docker
else
  build_and_run_native
fi
