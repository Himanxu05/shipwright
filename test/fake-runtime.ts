import type { Config } from "../src/config.js";
import type { Probe, Replica, Runtime } from "../src/runtime.js";

// In-memory Runtime. An image containing "broken" never passes its health
// check; one containing "crash" exits on start. Every load-balancer update is
// recorded so tests can check invariants over the whole rollout.
export class FakeRuntime implements Runtime {
  replicas = new Map<string, Replica>();
  upstreamHistory: Replica[][] = [];
  probes: Probe[] | null = null; // optional scripted probe results
  private nextId = 1;

  constructor(initial: { image: string; release: number; count: number } | null = null) {
    if (initial) {
      for (let i = 0; i < initial.count; i++) {
        const r = this.make(initial.image, initial.release, i);
        this.replicas.set(r.id, r);
      }
      this.upstreamHistory.push([...this.replicas.values()]);
    }
  }

  get upstreams(): Replica[] {
    return this.upstreamHistory.at(-1) ?? [];
  }

  private make(image: string, release: number, index: number): Replica {
    const id = `c${this.nextId++}`;
    return { id, name: `app-r${release}-${index}`, release, index, image, hostPort: 40000 + this.nextId, running: true };
  }

  async ensureInfra(_cfg: Config) {}

  async listReplicas() {
    return [...this.replicas.values()].map((r) => ({ ...r }));
  }

  async startReplica(_cfg: Config, image: string, release: number, index: number) {
    const r = this.make(image, release, index);
    if (image.includes("crash")) r.running = false;
    this.replicas.set(r.id, r);
    return { ...r };
  }

  async probe(_cfg: Config, replica: Replica): Promise<Probe> {
    const r = this.replicas.get(replica.id);
    if (!r?.running) return "exited";
    if (this.probes) return this.probes.shift() ?? "healthy";
    return r.image.includes("broken") ? "unhealthy" : "healthy";
  }

  async setUpstreams(_cfg: Config, replicas: Replica[]) {
    for (const r of replicas) {
      if (!this.replicas.get(r.id)?.running) throw new Error(`routing to non-running ${r.name}`);
    }
    this.upstreamHistory.push(replicas.map((r) => ({ ...r })));
  }

  async stopReplica(replica: Replica) {
    this.replicas.get(replica.id)!.running = false;
  }

  async restartReplica(replica: Replica) {
    const r = this.replicas.get(replica.id)!;
    r.running = true;
    r.hostPort += 1000; // ports change on restart
    return { ...r };
  }

  async removeReplica(replica: Replica) {
    this.replicas.delete(replica.id);
  }

  async destroy() {
    this.replicas.clear();
  }
}
