# Running on Kubernetes

These manifests deploy the same two components as `docker-compose.yml`: the
Mosquitto broker and the session server. Both go into a namespace called
`ensemble`.

| File                | Creates |
|---------------------|---------|
| `00-namespace.yaml` | Namespace `ensemble` |
| `broker.yaml`       | ConfigMap `mosquitto-config`, Deployment + Service `broker` |
| `server.yaml`       | Deployment + Service `server` (1 replica, `Recreate` strategy) |

Exposed ports (NodePort):

| Port  | What |
|-------|------|
| 30080 | Web client + JSON gateway (container port 8080) |
| 30051 | Native gRPC (container port 50051) |
| 30901 | MQTT over WebSocket for browsers (container port 9001) |

## Prerequisites

- `kubectl`
- A local cluster. Any one of these works:
  - **Docker Desktop Kubernetes** (recommended, and what the manifests target):
    Docker Desktop → Settings → Kubernetes → *Enable Kubernetes*
  - **minikube**
  - **kind**

Check that kubectl is pointed at the cluster:

```bash
kubectl config get-contexts
kubectl config use-context docker-desktop   # or minikube / kind-kind
kubectl get nodes
```

## 1. Build the server image

From the project root:

```bash
docker build -t ensemble-server:1.0 .
```

The Deployment uses `imagePullPolicy: IfNotPresent`, so the cluster must
already have this image locally:

| Cluster | Extra step |
|---------|-----------|
| Docker Desktop | None. It shares Docker's image store. |
| minikube | `minikube image load ensemble-server:1.0` |
| kind | `kind load docker-image ensemble-server:1.0` |

## 2. Deploy

```bash
kubectl apply -f k8s/
```

The files are applied in name order, so `00-namespace.yaml` is created first.
If you get `namespaces "ensemble" not found`, run the command again.

Wait for both pods to become ready:

```bash
kubectl -n ensemble get pods -w
```

The server pod shows `0/1` until its `/readyz` probe passes, which needs the
broker to be up.

## 3. Open it

| Cluster | URL |
|---------|-----|
| Docker Desktop | **http://localhost:30080** |
| minikube | `minikube service server -n ensemble --url`, or `http://$(minikube ip):30080` |
| kind | Node ports aren't exposed by default. Use port-forwarding (below). |

With port-forwarding, which works on any cluster:

```bash
kubectl -n ensemble port-forward svc/server 8080:8080
kubectl -n ensemble port-forward svc/broker 30901:9001
```

Then open http://localhost:8080. The second forward is needed because browsers
connect to the broker directly on port 30901 (`MQTT_WS_PUBLIC_PORT`).

## Useful commands

```bash
kubectl -n ensemble get all                       # everything in the namespace
kubectl -n ensemble describe pod -l app=server    # events, probe failures
kubectl -n ensemble logs -f deploy/server         # server logs
kubectl -n ensemble logs -f deploy/broker         # broker logs
kubectl -n ensemble rollout restart deploy/server # restart after rebuilding the image
```

Self-healing demo: delete the server pod and watch Kubernetes replace it.

```bash
kubectl -n ensemble delete pod -l app=server
kubectl -n ensemble get pods -w
```

Readiness vs liveness demo: kill the broker. The server goes not-ready
(`0/1`) but is **not** restarted. When the broker comes back, it becomes ready
again.

```bash
kubectl -n ensemble scale deploy/broker --replicas=0
kubectl -n ensemble get pods -w
kubectl -n ensemble scale deploy/broker --replicas=1
```

Run the MapReduce job inside the server pod:

```bash
kubectl -n ensemble exec -it deploy/server -- node server/mapreduce.js
```

## Updating after a code change

```bash
docker build -t ensemble-server:1.0 .
# minikube / kind: load the image again (see step 1)
kubectl -n ensemble rollout restart deploy/server
```

## Tear down

```bash
kubectl delete -f k8s/
```

Deleting the namespace removes everything in it.

## Notes

- **Why one server replica?** The session registry and ledger live in the
  server's memory. Two replicas would split the sessions between them. The
  comments in `server.yaml` and `docs/ARCHITECTURE.md` explain this.
- **Storage is `emptyDir`.** Retained MQTT messages and telemetry survive a
  container restart but are lost if the pod is deleted.
