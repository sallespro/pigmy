# Builds litebox_packager + litebox_runner_linux_userland once, packages the
# nodejs-enabled Alpine rootfs once, and bakes both into a runtime image so a
# sandbox spawn never pays the ~15min cargo rebuild cost run-alpine-node.sh did.
FROM rust:1-bookworm AS builder

ARG LITEBOX_REF=main
RUN apt-get update -qq && apt-get install -y -qq git && rm -rf /var/lib/apt/lists/*
RUN git clone --quiet https://github.com/AnEntrypoint/litebox /litebox
WORKDIR /litebox
RUN git checkout --quiet "${LITEBOX_REF}"
RUN cargo build --locked --release -p litebox_packager -p litebox_runner_linux_userland

ARG ALPINE_IMAGE=ghcr.io/anentrypoint/litebox-alpine-base:latest
RUN ./target/release/litebox_packager --oci-image "${ALPINE_IMAGE}" \
    -o /base-rootfs.tar --verbose

FROM debian:bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq tar ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /litebox/target/release/litebox_runner_linux_userland /usr/local/bin/litebox_runner_linux_userland
COPY --from=builder /base-rootfs.tar /opt/litebox/base-rootfs.tar
COPY entrypoint.sh /usr/local/bin/sandbox-entrypoint.sh
RUN chmod +x /usr/local/bin/sandbox-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint.sh"]
