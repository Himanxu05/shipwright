import type { Config } from "./config.js";
import type { Replica, Runtime } from "./runtime.js";

export interface DeployDeps {
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

export type DeployResult =
  | { status: "succeeded"; replicas: Replica[] }
  | { status: "rolled_back"; reason: string; replicas: Replica[] };

class DeployFailed extends Error {}

// Poll a replica until it passes `healthyThreshold` probes in a row, exits,
// or runs out of time.
export async function waitHealthy(rt: Runtime, cfg: Config, replica: Replica, deps: DeployDeps): Promise<void> {
  const { intervalMs, timeoutMs, healthyThreshold } = cfg.healthCheck;
  const attempts = Math.ceil(timeoutMs / intervalMs);
  let streak = 0;
  for (let i = 0; i < attempts; i++) {
    const result = await rt.probe(cfg, replica);
    if (result === "exited") throw new DeployFailed(`${replica.name} exited during startup`);
    streak = result === "healthy" ? streak + 1 : 0;
    if (streak >= healthyThreshold) return;
    await deps.sleep(intervalMs);
  }
  throw new DeployFailed(`${replica.name} did not become healthy within ${timeoutMs} ms`);
}

// Rolling update with maxSurge=1, maxUnavailable=0:
//
//   for each slot i:
//     start new[i] → wait until healthy → switch the load balancer to
//     (new[0..i] + old[i+1..]) → let old[i] drain → stop old[i]
//
// At every load-balancer switch, the number of healthy replicas in rotation
// is never below the starting count. Old replicas are only *stopped* until
// the deploy succeeds, so if any new replica fails its health check we start
// them again, point the load balancer back, and remove the new ones.
export async function deploy(
  rt: Runtime,
  cfg: Config,
  image: string,
  release: number,
  deps: DeployDeps,
): Promise<DeployResult> {
  await rt.ensureInfra(cfg);
  const old = (await rt.listReplicas(cfg.app)).filter((r) => r.running).sort((a, b) => a.index - b.index);
  const fresh: Replica[] = [];
  const stopped: Replica[] = [];
  const serving = () => [...fresh, ...old.filter((r) => !stopped.includes(r))];

  const retire = async (victim: Replica) => {
    stopped.push(victim);
    await rt.setUpstreams(cfg, serving());
    await deps.sleep(cfg.drainMs);
    await rt.stopReplica(victim, cfg.stopTimeoutSec);
    deps.log(`  stopped ${victim.name}`);
  };

  async function rollback(): Promise<Replica[]> {
    const restored: Replica[] = [];
    for (const r of stopped) {
      const again = await rt.restartReplica(r);
      try {
        await waitHealthy(rt, cfg, again, deps);
        restored.push(again);
        deps.log(`  restarted ${again.name}`);
      } catch (e) {
        deps.log(`  could not restore ${r.name}: ${(e as Error).message}`);
      }
    }
    const previous = [...old.filter((r) => !stopped.includes(r)), ...restored].sort((a, b) => a.index - b.index);
    await rt.setUpstreams(cfg, previous);
    await deps.sleep(cfg.drainMs);
    for (const r of fresh) await rt.removeReplica(r);
    deps.log(`  rolled back to ${previous.length} replica(s) of the previous release`);
    return previous;
  }

  deps.log(`release ${release}: ${image} (${old.length} running → ${cfg.replicas} replicas)`);
  try {
    for (let i = 0; i < cfg.replicas; i++) {
      const replica = await rt.startReplica(cfg, image, release, i);
      fresh.push(replica);
      deps.log(`  started ${replica.name}, waiting for health check`);
      await waitHealthy(rt, cfg, replica, deps);
      deps.log(`  ${replica.name} healthy, added to load balancer`);
      const victim = old[i];
      if (victim) await retire(victim);
      else await rt.setUpstreams(cfg, serving());
    }
    // Scaling down: retire old replicas that have no new counterpart.
    for (const victim of old.slice(cfg.replicas)) await retire(victim);
  } catch (err) {
    if (!(err instanceof DeployFailed)) throw err;
    deps.log(`  FAILED: ${err.message}. Rolling back.`);
    return { status: "rolled_back", reason: err.message, replicas: await rollback() };
  }

  for (const r of stopped) await rt.removeReplica(r);
  deps.log(`release ${release} live on :${cfg.publicPort}`);
  return { status: "succeeded", replicas: fresh };
}
