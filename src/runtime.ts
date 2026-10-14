import type { Config } from "./config.js";

// One running (or stopped) copy of the app.
export interface Replica {
  id: string;
  name: string;
  release: number;
  index: number;
  image: string;
  hostPort: number; // published on 127.0.0.1 so the deployer can health-check it
  running: boolean;
}

export type Probe = "healthy" | "unhealthy" | "exited";

// Everything the deployer needs from the container platform. The Docker
// implementation is in docker-runtime.ts; tests use an in-memory fake.
export interface Runtime {
  ensureInfra(cfg: Config): Promise<void>;
  listReplicas(app: string): Promise<Replica[]>;
  startReplica(cfg: Config, image: string, release: number, index: number): Promise<Replica>;
  probe(cfg: Config, replica: Replica): Promise<Probe>;
  setUpstreams(cfg: Config, replicas: Replica[]): Promise<void>;
  stopReplica(replica: Replica, timeoutSec: number): Promise<void>;
  restartReplica(replica: Replica): Promise<Replica>;
  removeReplica(replica: Replica): Promise<void>;
  destroy(app: string): Promise<void>;
}
