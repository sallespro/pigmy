#!/usr/bin/env bash
# Runs inside the sandbox-service image. One instance of this = one isolated
# sandbox: copies the baked read-only base rootfs, appends this sandbox's own
# app files (node mode) or leaves the base rootfs untouched (shell mode, which
# runs "/bin/sh -c <command>" from inside the already-baked Alpine image), and
# runs litebox_runner_linux_userland against the copy so no two concurrent
# sandboxes ever share a tar or an --export-writable-layer path.
#
# Expects, bind-mounted read-only by the host service at /sandbox-in:
#   mode      "node" or "shell"
#   app/      (node mode) the user's Node.js app, entry file named by `entry`
#   entry     (node mode) entry path relative to app/, e.g. "index.js"
#   command   (shell mode) a shell command run as `/bin/sh -c "$(cat command)"`
#
# Expects, bind-mounted writable at /sandbox-out:
#   log.txt              (written by the host, not this script)
#   writable-layer.tar    --export-writable-layer destination (this sandbox's own path)
#
# Container env vars set by the host service (never by the guest payload):
#   SANDBOX_NETWORK=1        opt in to a NATed TUN device for guest internet egress
#   SANDBOX_PUBLISH_PORT=N   a host port already published via `docker run -p N:N`;
#                            NATed the same as any other guest-egress traffic, and
#                            the guest's own server should bind 0.0.0.0:N
#   any other var            forwarded into the guest via litebox's own --env K=V
#                            (never --forward-env, and never echoed to the log)
set -euo pipefail

MODE="$(cat /sandbox-in/mode)"

# /sandbox-out is a bind-mounted host path, unlike /tmp (tmpfs, counts against
# the container's memory cgroup) -- copying the ~680MB base tar here instead
# roughly halves the memory needed to avoid an OOM-kill on the mmap+copy.
WORK_TAR="/sandbox-out/rootfs.tar"
cp /opt/litebox/base-rootfs.tar "$WORK_TAR"

GUEST_ARGV=()
case "$MODE" in
  node)
    ENTRY="$(cat /sandbox-in/entry)"
    case "$ENTRY" in
      /*|*..*) echo "invalid entry path: $ENTRY" >&2; exit 2 ;;
    esac
    # Append the app directory into the tar at guest path /app/... (root-relative,
    # matching litebox_packager's own convention -- no "rootfs/" prefix; see
    # run-alpine-node.sh's discovery of this the hard way). GNU tar's "." source
    # arg produces entries as "./index.js", so the transform must strip that
    # leading "./" before prefixing "app/" or paths land as "app/./index.js".
    tar --append --file "$WORK_TAR" -C /sandbox-in/app --transform 's,^\./,,;s,^,app/,' .
    GUEST_ARGV=(/usr/bin/node "/app/${ENTRY}")
    ;;
  shell)
    # No tar append needed: sh/git/npm/node are already baked into the base
    # image, and the command itself (e.g. a git-clone+npm-install+npm-start
    # pipeline) is passed as a single argv element, never interpolated through
    # this outer shell -- the guest's own /bin/sh parses it.
    GUEST_ARGV=(/bin/sh -c "$(cat /sandbox-in/command)")
    ;;
  *)
    echo "invalid mode: $MODE" >&2
    exit 2
    ;;
esac

LITEBOX_ARGS=(
  --unstable
  --initial-files "$WORK_TAR"
  --program-from-tar
  --export-writable-layer /sandbox-out/writable-layer.tar
)

# Networking is opt-in: SANDBOX_NETWORK=1 creates+NATs a TUN device this
# container's own outbound interface, giving the guest real internet egress.
# litebox itself only forwards guest<->TUN packets (see litebox's own tests,
# which prove host<->guest reachability over the TUN, never internet egress)
# -- the NAT/forwarding is this script's own responsibility.
if [ "${SANDBOX_NETWORK:-0}" = "1" ]; then
  TUN_DEV="tun0"
  TUN_IP="10.0.0.1"
  GUEST_IP="10.0.0.2"

  ip tuntap add dev "$TUN_DEV" mode tun
  ip addr add "${TUN_IP}/24" dev "$TUN_DEV"
  ip link set dev "$TUN_DEV" up

  sysctl -w net.ipv4.ip_forward=1 >/dev/null

  # Masquerade guest-subnet traffic out through whichever interface actually
  # owns the container's default route (Docker's own outbound NIC), so the
  # guest's real internet egress works regardless of the container's own
  # network topology.
  EGRESS_IF="$(ip route show default | awk '/default/ {print $5; exit}')"
  if [ -z "$EGRESS_IF" ]; then
    echo "sandbox network requested but no default route found; cannot NAT" >&2
    exit 3
  fi
  iptables -t nat -A POSTROUTING -s "${TUN_IP%.*}.0/24" -o "$EGRESS_IF" -j MASQUERADE
  iptables -A FORWARD -i "$TUN_DEV" -o "$EGRESS_IF" -j ACCEPT
  iptables -A FORWARD -i "$EGRESS_IF" -o "$TUN_DEV" -m state --state RELATED,ESTABLISHED -j ACCEPT

  if [ -n "${SANDBOX_PUBLISH_PORT:-}" ]; then
    # The host already published this container's own SANDBOX_PUBLISH_PORT via
    # `docker run -p`; forward that port on to the guest so a server the guest
    # binds on 0.0.0.0:PORT is reachable from outside the container too.
    iptables -t nat -A PREROUTING -p tcp --dport "$SANDBOX_PUBLISH_PORT" \
      -j DNAT --to-destination "${GUEST_IP}:${SANDBOX_PUBLISH_PORT}"
    iptables -A FORWARD -p tcp -d "$GUEST_IP" --dport "$SANDBOX_PUBLISH_PORT" -j ACCEPT
  fi

  LITEBOX_ARGS+=(--tun-device-name "$TUN_DEV")
fi

# Secrets: every env var the host service set for this sandbox becomes a
# litebox --env K=V, an explicit allow-list -- never --forward-env, which
# would leak this whole container's environment (including nothing sensitive
# today, but that guarantee would silently break the moment anything is) into
# the guest. SANDBOX_* control-plane vars are excluded; they configure this
# script, not the guest's own environment.
while IFS='=' read -r -d '' name value; do
  case "$name" in
    SANDBOX_*|PATH|HOME|HOSTNAME|TERM|PWD|SHLVL|_) continue ;;
  esac
  LITEBOX_ARGS+=(--env "${name}=${value}")
done < <(env -0)

/usr/local/bin/litebox_runner_linux_userland "${LITEBOX_ARGS[@]}" -- "${GUEST_ARGV[@]}"
STATUS=$?
rm -f "$WORK_TAR"
exit "$STATUS"
