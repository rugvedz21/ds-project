# ---------------------------------------------------------------------------
# Session server image.
#
# Unit 1 self-study: the role of virtualization in distributed systems.
#
# Containerising this component buys three specific things, none of which are
# about "making deployment easier" in the abstract:
#
#   1. ISOLATION -- the server carries its own Node runtime and its own
#      dependency tree. It cannot be broken by whatever Node version happens
#      to be on the host, and it cannot break anything else on that host.
#
#   2. REPRODUCIBILITY -- the pinned base image plus a lockfile-driven install
#      means the same bytes run on both team members' laptops and on the
#      evaluation machine. "Works on mine" stops being a defence.
#
#   3. SUBSTITUTABILITY -- the server addresses the broker as the hostname
#      "broker" rather than an IP. What answers to that name is a deployment
#      decision, not a code decision, so a container can be swapped for a
#      remote broker without touching a line of source.
#
# It is worth being precise at the evaluation about what virtualization does
# NOT do here: it changes nothing about latency, consistency, or failure
# semantics. Containers give you packaging and isolation. Every hard problem
# in this project -- clock disagreement, delay, partial failure -- is exactly
# as hard inside a container as outside one.
# ---------------------------------------------------------------------------

FROM node:20-alpine

WORKDIR /app

# Dependencies are copied and installed before the source so that editing
# source code does not invalidate the cached dependency layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY proto ./proto
COPY server ./server
COPY web ./web

# 8080  client + gRPC/JSON gateway
# 50051 native gRPC (so grpcurl can reach the service from the host)
EXPOSE 8080 50051

# The broker runs as its own container, so the embedded one is switched off.
ENV EMBEDDED_BROKER=0
ENV MQTT_HOST=broker

# Run unprivileged. The node image ships a "node" user for exactly this; a
# container that does not need root should not have it.
USER node

CMD ["node", "server/index.js"]
