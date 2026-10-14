import Docker from "dockerode";
import { PassThrough } from "node:stream";
import type { Config } from "./config.js";
import { ADMIN_SOCKET, BACKEND, parseSlots, planUpstreams, renderHaproxyConfig } from "./haproxy.js";
import type { Probe, Replica, Runtime } from "./runtime.js";

const LABEL = "shipwright.app";
const LB_IMAGE = "haproxy:3.2-alpine";

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
      // The config is passed in an env var and written at startup, so no
      // host files or bind mounts are needed.
      Env: [`HAPROXY_CFG=${renderHaproxyConfig(cfg.healthCheck.path, cfg.port)}`],
      Entrypoint: ["sh", "-c", 'printf "%s" "$HAPROXY_CFG" > /tmp/haproxy.cfg && exec haproxy -W -db -f /tmp/haproxy.cfg'],
      ExposedPorts: { "80/tcp": {} },
      HostConfig: {
        PortBindings: { "80/tcp": [{ HostPort: String(cfg.publicPort) }] },
        NetworkMode: networkName(cfg.app),
        RestartPolicy: { Name: "unless-stopped" },
      },
    });
    await created.start();
    await this.waitForAdminSocket(cfg.app);
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

  // Change which replicas receive traffic, without reloading HAProxy.
  async setUpstreams(cfg: Config, replicas: Replica[]): Promise<void> {
    const ips = await Promise.all(replicas.map((r) => this.ipOf(r.id, cfg.app)));
    const commands = planUpstreams(parseSlots(await this.admin(cfg.app, `show servers state ${BACKEND}`)), ips, cfg.port);
    if (commands.length > 0) await this.admin(cfg.app, commands.join("; "));

    // Verify instead of trusting command output: every wanted IP must now be active.
    const active = new Set(
      parseSlots(await this.admin(cfg.app, `show servers state ${BACKEND}`))
        .filter((s) => s.state === "active")
        .map((s) => s.addr),
    );
    const missing = ips.filter((ip) => !active.has(ip));
    if (missing.length > 0) throw new Error(`HAProxy did not activate ${missing.join(", ")}`);
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

  private async ipOf(id: string, app: string): Promise<string> {
    const info = await this.docker.getContainer(id).inspect();
    const ip = info.NetworkSettings.Networks[networkName(app)]?.IPAddress;
    if (!ip) throw new Error(`${info.Name} has no IP on ${networkName(app)}`);
    return ip;
  }

  // Send commands to HAProxy's Runtime API over its unix socket, from inside
  // the LB container, so the admin API is never exposed on the network.
  private async admin(app: string, command: string): Promise<string> {
    const { exitCode, output } = await this.exec(lbName(app), ["sh", "-c", `printf '%s\\n' "$CMD" | socat stdio unix-connect:${ADMIN_SOCKET}`], [
      `CMD=${command}`,
    ]);
    if (exitCode !== 0) throw new Error(`HAProxy admin command failed: ${output}`);
    return output;
  }

  private async waitForAdminSocket(app: string): Promise<void> {
    for (let i = 0; i < 50; i++) {
      try {
        await this.admin(app, "show info");
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("HAProxy admin socket did not come up");
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
