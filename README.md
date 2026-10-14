# Shipwright

A small deployment tool: **zero-downtime rolling deploys** of Docker containers behind an
HAProxy load balancer, with **health checks and automatic rollback**. One YAML file, one
command, like a tiny single-host Kubernetes Deployment.

```
$ shipwright deploy --image shipwright-demo:v2
17:16:44.178 release 2: shipwright-demo:v2 (3 running → 3 replicas)
17:16:44.448   started demo-r2-0, waiting for health check
17:16:46.637   demo-r2-0 healthy, added to load balancer
17:16:48.586   stopped demo-r1-0
17:16:48.845   started demo-r2-1, waiting for health check
17:16:50.981   demo-r2-1 healthy, added to load balancer
17:16:52.907   stopped demo-r1-1
17:16:53.158   started demo-r2-2, waiting for health check
17:16:55.294   demo-r2-2 healthy, added to load balancer
17:16:57.215   stopped demo-r1-2
17:16:57.240 release 2 live on :8090

$ shipwright deploy --image shipwright-demo:v3-broken
17:16:57.687 release 3: shipwright-demo:v3-broken (3 running → 3 replicas)
17:16:57.946   started demo-r3-0, waiting for health check
17:17:08.324   FAILED: demo-r3-0 did not become healthy within 10000 ms. Rolling back.
17:17:10.281   rolled back to 3 replica(s) of the previous release
```

**Stack:** TypeScript, Node.js, Docker Engine API (dockerode), HAProxy Runtime API, Vitest,
GitHub Actions (unit tests + end-to-end tests against a real Docker daemon).

## Results

Measured with `scripts/zero-downtime.ts`: 20 concurrent clients hammer the load balancer
(~900 req/s) while a 3-replica deploy runs.

| scenario | requests during deploy | failed | p99 latency |
|---|---|---|---|
| nginx + reload (first version) | 14,617 | **3** (one per reload) | 33 ms |
| HAProxy Runtime API, 5 deploys | 75,705 | **0** | 27–33 ms |
| HAProxy, broken image → automatic rollback | 14,546 | **0** (all served by the old version) | 28 ms |

**Why the switch from nginx:** the first version rewrote the nginx config and ran
`nginx -s reload`. Under load, every deploy lost exactly 3 requests with `UND_ERR_SOCKET`
("other side closed"), one per reload. On reload, nginx's old worker processes close idle
keep-alive connections, and a client that sends a request on one of those connections at
that moment gets a reset. HAProxy's Runtime API changes a backend's servers in memory
with no reload, so client connections are never closed. The nginx version is in the
git history (commit `391e91f`).

## How a deploy works

```
for each replica slot i (maxSurge = 1, maxUnavailable = 0):
  1. start new[i]                      (container on the app's private Docker network)
  2. probe GET /health until 2 passes in a row (fail fast if the container exits)
  3. load balancer: put new[i] in rotation, set old[i] to DRAIN
  4. wait drainMs, then SIGTERM old[i]  (the app finishes in-flight requests and exits)
     old[i] is only *stopped*, not deleted, until the whole deploy succeeds
on any failed health check:
  restart the stopped old replicas → wait healthy → route traffic back → delete the new ones
```

- **Capacity never drops:** at every load-balancer change, at least as many healthy replicas
  are in rotation as before the deploy. A unit test checks this invariant over every step.
- **Load balancer without reloads:** the HAProxy backend has 40 server slots. Adding a
  replica = `set server app/sN addr <ip> port 3000` + `state ready`. Removing = `state drain`,
  then `maint` on the next change. Slot state is read from `show servers state` (the
  admin-state bitfield). The human-readable status isn't reliable: a draining server whose
  health check fails shows `DOWN`, which caused a real bug here. The admin socket is only
  reachable from inside the LB container (`docker exec` + `socat`), never over the network.
- **The runtime is the source of truth:** running replicas are discovered from Docker labels
  (`shipwright.app`, `shipwright.release`), not from a state file that could drift.
- **One deploy at a time:** a lock file created with `O_EXCL` (`open(path, "wx")`), so creation
  is atomic. A lock left by a crashed process is detected by its PID and taken over.
- **Crash-safe history:** written to a temp file and renamed (rename is atomic).
- **Testable:** the deployer only talks to a `Runtime` interface. Unit tests use an in-memory
  fake (failures at any step, crashing containers, flapping health checks, scale up and down);
  the e2e test runs the real thing on Docker in CI.

## Use it

```bash
npm ci && npm run build
npm run demo:images                 # builds shipwright-demo:v1, :v2, :v3-broken
node dist/cli.js deploy             # deploys the image in shipwright.yaml (v1)
curl localhost:8090                 # {"version":"v1","host":"..."}
node dist/cli.js deploy -i shipwright-demo:v2
node dist/cli.js deploy -i shipwright-demo:v3-broken   # fails health check → rolled back
node dist/cli.js status | history | rollback | destroy

npx tsx scripts/zero-downtime.ts shipwright-demo:v1    # deploy under load, print failures
npm test                            # 21 unit tests
npm run test:e2e                    # real Docker: rollout + rollback under load
```

`shipwright.yaml`:

```yaml
app: demo
image: shipwright-demo:v1
replicas: 3
port: 3000          # app port inside the container
publicPort: 8090    # load balancer port on the host
healthCheck: { path: /health, intervalMs: 300, timeoutMs: 10000, healthyThreshold: 2 }
drainMs: 1500       # time in DRAIN before SIGTERM
stopTimeoutSec: 10  # SIGTERM → SIGKILL grace period
```

## Layout

```
src/deployer.ts        rolling update + rollback (talks only to the Runtime interface)
src/runtime.ts         the Runtime interface
src/docker-runtime.ts  Docker implementation: containers, networks, health probes, HAProxy admin
src/haproxy.ts         HAProxy config, `show servers state` parser, slot planner (pure)
src/state.ts           release history, deploy lock
src/cli.ts             deploy / rollback / status / history / destroy
demo-app/              tiny HTTP service with graceful SIGTERM handling
scripts/               load generator and zero-downtime benchmark
test/                  unit tests (fake runtime) and e2e test (real Docker)
```

## Limits

Single host. No secrets management, image registry auth, or persistent volumes. The
deployer must stay running for the whole rollout; if it is killed mid-deploy, the next deploy
cleans up leftover containers, but the in-progress rollback doesn't resume.
