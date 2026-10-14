import Docker from "dockerode";
import { PassThrough } from "node:stream";
import type { Config } from "./config.js";
import { renderNginx } from "./nginx.js";
import type { Probe, Replica, Runtime } from "./runtime.js";

const LABEL = "shipwright.app";
const LB_IMAGE = "nginx:1.27-alpine";
const CONF = "/etc/nginx/conf.d/default.conf";

const networkName = (app: string) => `shipwright-${app}`;
const lbName = (app: string) => `${app}-lb`;

// Talks to the Docker Engine API over /var/run/docker.sock (via dockerode).
export class DockerRuntime implements Runtime {
  constructor(private readonly docker = new Docker()) {}

  async ensureInfra(cfg: Config): Promise<void> {
    const networks = await this.docker.listNetworks({ filters: { name: [networkName(cfg.app)] } });
    if (!networks.some((n) => n.Name === networkName(cfg.app))) {
      await this.docker.createNetwork({ Name: networkName(cfg.app), Labels: { [LABEL]: cfg.app } });
    }

    const lb = this.docker.getContainer(lbName(cfg.app));
    const info = await lb.inspect().catch(() => null);
    if (info?.State.Running) return;
    if (info) {
      await lb.start();
      return;
    }
    await this.pull(LB_IMAGE);
    const created = await this.docker.createContainer({
      name: lbName(cfg.app),
      Image: LB_IMAGE,
      Labels: { [LABEL]: cfg.app, "shipwright.role": "lb" },
      ExposedPorts: { "80/tcp": {} },
      HostConfig: {
        PortBindings: { "80/tcp": [{ HostPort: String(cfg.publicPort) }] },
        NetworkMode: networkName(cfg.app),
        RestartPolicy: { Name: "unless-stopped" },
      },
    });
    await created.start();
    await this.setUpstreams(cfg, []);
  }

  async listReplicas(app: string): Promise<Replica[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL}=${app}`, "shipwright.role=replica"] },
    });
    return containers.map((c) => ({
      id: c.Id,
      name: c.Names[0]!.replace(/^\//, ""),
      release: Number(c.Labels["shipwright.release"]),
      index: Number(c.Labels["shipwright.index"]),
      image: c.Image,
      hostPort: c.Ports.find((p) => p.PublicPort)?.PublicPort ?? 0,
      running: c.State === "running",
    }));
  }

  async startReplica(cfg: Config, image: string, release: number, index: number): Promise<Replica> {
    const name = `${cfg.app}-r${release}-${index}`;
    // Leftover from a crashed deploy with the same release number.
    await this.docker.getContainer(name).remove({ force: true }).catch(() => undefined);
    await this.pull(image);
    const container = await this.docker.createContainer({
      name,
      Image: image,
      Env: Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`),
      Labels: {
        [LABEL]: cfg.app,
        "shipwright.role": "replica",
        "shipwright.release": String(release),
        "shipwright.index": String(index),
      },
      ExposedPorts: { [`${cfg.port}/tcp`]: {} },
      HostConfig: {
        // Empty HostPort = Docker picks a free port; bound to localhost only.
        PortBindings: { [`${cfg.port}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }] },
        NetworkMode: networkName(cfg.app),
      },
    });
    await container.start();
    return this.describe(container.id, release, index, image);
  }

  async probe(cfg: Config, replica: Replica): Promise<Probe> {
    const info = await this.docker.getContainer(replica.id).inspect();
    if (!info.State.Running) return "exited";
    try {
      const res = await fetch(`http://127.0.0.1:${replica.hostPort}${cfg.healthCheck.path}`, {
        signal: AbortSignal.timeout(2_000),
      });
      return res.ok ? "healthy" : "unhealthy";
    } catch {
      return "unhealthy"; // not listening yet
    }
  }

  // Swap the nginx config and reload. The new file is validated with
  // `nginx -t` first; if it is invalid the previous config is put back, so a
  // bad render can never take the load balancer down. `nginx -s reload` is
  // graceful: old workers finish their in-flight requests.
  async setUpstreams(cfg: Config, replicas: Replica[]): Promise<void> {
    const script = [
      `cp ${CONF} ${CONF}.bak 2>/dev/null || true`,
      `printf '%s' "$NGINX_CONF" > ${CONF}`,
      `if nginx -t 2>/tmp/nginx-test.log; then nginx -s reload; else cp ${CONF}.bak ${CONF}; cat /tmp/nginx-test.log; exit 1; fi`,
    ].join(" && ");
    const { exitCode, output } = await this.exec(lbName(cfg.app), ["sh", "-c", script], [
      `NGINX_CONF=${renderNginx(cfg, replicas)}`,
    ]);
    if (exitCode !== 0) throw new Error(`nginx rejected the new config:\n${output}`);
  }

  async stopReplica(replica: Replica, timeoutSec: number): Promise<void> {
    // SIGTERM, then SIGKILL after timeoutSec if the app hasn't exited.
    await this.docker.getContainer(replica.id).stop({ t: timeoutSec }).catch(ignoreNotModified);
  }

  async restartReplica(replica: Replica): Promise<Replica> {
    await this.docker.getContainer(replica.id).start().catch(ignoreNotModified);
    // The host port is reassigned on restart, so read it again.
    return this.describe(replica.id, replica.release, replica.index, replica.image);
  }

  async removeReplica(replica: Replica): Promise<void> {
    await this.docker.getContainer(replica.id).remove({ force: true });
  }

  async destroy(app: string): Promise<void> {
    const all = await this.docker.listContainers({ all: true, filters: { label: [`${LABEL}=${app}`] } });
    await Promise.all(all.map((c) => this.docker.getContainer(c.Id).remove({ force: true })));
    await this.docker.getNetwork(networkName(app)).remove().catch(() => undefined);
  }

  private async describe(id: string, release: number, index: number, image: string): Promise<Replica> {
    const info = await this.docker.getContainer(id).inspect();
    const binding = Object.values(info.NetworkSettings.Ports ?? {})[0]?.[0];
    return {
      id,
      name: info.Name.replace(/^\//, ""),
      release,
      index,
      image,
      hostPort: Number(binding?.HostPort ?? 0),
      running: info.State.Running,
    };
  }

  private async pull(image: string): Promise<void> {
    const present = await this.docker.getImage(image).inspect().then(
      () => true,
      () => false,
    );
    if (present) return;
    const stream = await this.docker.pull(image);
    await new Promise((resolve, reject) =>
      this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve(undefined))),
    );
  }

  private async exec(container: string, cmd: string[], env: string[]): Promise<{ exitCode: number; output: string }> {
    const exec = await this.docker.getContainer(container).exec({
      Cmd: cmd,
      Env: env,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({});
    const out = new PassThrough();
    let output = "";
    out.on("data", (chunk: Buffer) => (output += chunk.toString()));
    this.docker.modem.demuxStream(stream, out, out);
    await new Promise((resolve) => stream.on("end", resolve));
    const { ExitCode } = await exec.inspect();
    return { exitCode: ExitCode ?? 1, output };
  }
}

function ignoreNotModified(err: { statusCode?: number }) {
  if (err.statusCode !== 304) throw err; // 304 = already stopped/started
}
