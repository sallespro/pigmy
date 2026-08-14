#!/usr/bin/env bash
# Runs inside the sandbox-service image. One instance of this = one isolated
# sandbox: copies the baked read-only base rootfs, appends this sandbox's own
# app files, and runs litebox_runner_linux_userland against the copy so no
# two concurrent sandboxes ever share a tar or an --export-writable-layer path.
#
# Expects, bind-mounted by the host service:
#   /sandbox-in/app/          the user's Node.js app (entry.js required)
#   /sandbox-in/entry         file naming the entry point relative to app/, e.g. "index.js"
#   /sandbox-out/              writable; stdout/stderr already redirected here by the host
#   /sandbox-out/writable-layer.tar   destination for --export-writable-layer (this sandbox's own path)
set -euo pipefail

ENTRY="$(cat /sandbox-in/entry)"
case "$ENTRY" in
  /*|*..*) echo "invalid entry path: $ENTRY" >&2; exit 2 ;;
esac

# /sandbox-out is a bind-mounted host path, unlike /tmp (tmpfs, counts against
# the container's memory cgroup) -- copying the ~680MB base tar here instead
# roughly halves the memory needed to avoid an OOM-kill on the mmap+copy.
WORK_TAR="/sandbox-out/rootfs.tar"
cp /opt/litebox/base-rootfs.tar "$WORK_TAR"

# Append the app directory into the tar at guest path /app/... (root-relative,
# matching litebox_packager's own convention -- no "rootfs/" prefix; see
# run-alpine-node.sh's discovery of this the hard way). GNU tar's "." source
# arg produces entries as "./index.js", so the transform must strip that
# leading "./" before prefixing "app/" or paths land as "app/./index.js".
tar --append --file "$WORK_TAR" -C /sandbox-in/app --transform 's,^\./,,;s,^,app/,' .

/usr/local/bin/litebox_runner_linux_userland \
  --unstable \
  --initial-files "$WORK_TAR" \
  --program-from-tar \
  --export-writable-layer /sandbox-out/writable-layer.tar \
  -- /usr/bin/node "/app/${ENTRY}"
STATUS=$?
rm -f "$WORK_TAR"
exit "$STATUS"
