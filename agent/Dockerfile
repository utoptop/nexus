# syntax=docker/dockerfile:1
FROM rust:1.93-alpine AS builder
WORKDIR /app
RUN apk add --no-cache build-base
COPY Cargo.toml Cargo.lock ./
COPY src ./src
ARG TARGETARCH
RUN --mount=type=cache,id=nexus-agent-registry-${TARGETARCH},target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=nexus-agent-target-${TARGETARCH},target=/app/target,sharing=locked \
    cargo test --locked && cargo build --release --locked && cp target/release/nexus-agent /nexus-agent

FROM alpine:3.23
WORKDIR /app
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Nexus Agent" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.source="https://github.com/utoptop/nexus" \
      org.opencontainers.image.revision="${VCS_REF}"
COPY --from=builder /nexus-agent /usr/local/bin/nexus-agent
RUN mkdir -p /var/lib/nexus-agent
ENTRYPOINT ["nexus-agent"]
CMD ["--config", "/etc/nexus-agent/nexus-agent.toml"]
