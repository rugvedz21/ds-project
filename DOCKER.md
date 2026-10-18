# Running with Docker

This runs the session server and a **real Mosquitto MQTT broker** as two
containers. Without Docker, `npm start` uses an embedded broker. Peers can't
tell the two setups apart.

| Container         | Image                  | Ports                                   |
|-------------------|------------------------|-----------------------------------------|
| `ensemble-broker` | `eclipse-mosquitto:2`  | 1883 (MQTT), 9001 (MQTT over WebSocket) |
| `ensemble-server` | built from `Dockerfile`| 8080 (web + JSON gateway), 50051 (gRPC) |

## Prerequisites

- Docker Desktop (Windows/macOS) or Docker Engine + Compose v2 (Linux)
- **Docker must be running.** Check with:

```bash
docker info
```

If that prints `failed to connect to the docker API`, start Docker Desktop and
wait until it shows "Engine running".

- Ports 1883, 9001, 8080 and 50051 must be free. Stop `npm start` first if it
  is running, because it uses the same ports.

## Start

From the project root:

```bash
docker compose up --build
```

Then open **http://localhost:8080**.

The server waits for the broker's health check to pass before it starts, so
the first launch takes a few extra seconds.

To run in the background instead:

```bash
docker compose up --build -d
```

## Useful commands

```bash
docker compose ps                 # container status and health
docker compose logs -f            # follow logs from both containers
docker compose logs -f server     # just the session server
docker compose logs -f broker     # just Mosquitto (shows client connects)
docker compose restart server     # restart one service
docker compose up --build server  # rebuild after editing source
```

Watch the MQTT traffic live from inside the broker container:

```bash
docker exec -it ensemble-broker mosquitto_sub -t '#' -v
```

Call the gRPC service from the host (requires
[grpcurl](https://github.com/fullstorydev/grpcurl)):

```bash
grpcurl -plaintext -import-path proto -proto session.proto localhost:50051 list
```

Run the MapReduce job inside the server container:

```bash
docker exec -it ensemble-server node server/mapreduce.js
```

## Stop

```bash
docker compose down        # stop and remove containers
docker compose down -v     # also delete the broker-data volume (retained messages)
```

## Building the image on its own

```bash
docker build -t ensemble-server:1.0 .
```

The Kubernetes manifests in [`k8s/`](k8s/README.md) use this tag.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `failed to connect to the docker API ... dockerDesktopLinuxEngine` | Docker Desktop isn't running. Start it. |
| `port is already allocated` | Something else (often `npm start`) is using that port. Stop it, or change the left-hand port in `docker-compose.yml`. |
| Server keeps restarting | `docker compose logs server`. Usually it can't reach the broker. Check that `docker compose ps` shows the broker as `healthy`. |
| Page loads but peers never see each other | The browser can't reach `ws://<host>:9001`. On another machine, use the host's LAN IP, and allow ports 8080 and 9001 through the firewall. |
| Peers get evicted while joining | Some machines are slow to create peer connections. Add `PEER_TIMEOUT_MS: "15000"` under the server's `environment:` in `docker-compose.yml`. |
