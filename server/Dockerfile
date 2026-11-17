# syntax=docker/dockerfile:1
FROM rust:1.93-slim-bookworm AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY src/ src/
COPY templates/*.html templates/
ARG TARGETARCH
RUN --mount=type=cache,id=cargo-registry-${TARGETARCH},target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=cargo-git-${TARGETARCH},target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=cargo-target-${TARGETARCH},target=/app/target \
    cargo build --release --locked && cp target/release/nexus /nexus

FROM gcr.io/distroless/cc-debian12:nonroot
WORKDIR /app
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Nexus" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.source="https://github.com/utoptop/nexus" \
      org.opencontainers.image.revision="${VCS_REF}"
ENV TZ=Asia/Shanghai
COPY --from=builder --chown=nonroot:nonroot /nexus /app/nexus
COPY --chown=nonroot:nonroot templates/assets/ /app/templates/assets/
EXPOSE 3000
ENTRYPOINT ["/app/nexus"]
CMD ["--config", "/etc/nexus/nexus.toml"]
