import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { deploy } from "../src/deployer.js";
import { FakeRuntime } from "./fake-runtime.js";

const cfg = parseConfig(`
app: app
image: app:v1
replicas: 3
port: 3000
publicPort: 8080
healthCheck: { intervalMs: 10, timeoutMs: 100, healthyThreshold: 2 }
`);
const deps = { sleep: async () => {}, log: () => {} };

const images = (rt: FakeRuntime) => rt.upstreams.map((r) => r.image).sort();

describe("deploy", () => {
  it("brings up a first release", async () => {
    const rt = new FakeRuntime();
    const result = await deploy(rt, cfg, "app:v1", 1, deps);
    expect(result.status).toBe("succeeded");
    expect(images(rt)).toEqual(["app:v1", "app:v1", "app:v1"]);
  });

  it("replaces every replica and removes the old ones", async () => {
    const rt = new FakeRuntime({ image: "app:v1", release: 1, count: 3 });
    const result = await deploy(rt, cfg, "app:v2", 2, deps);
    expect(result.status).toBe("succeeded");
    expect(images(rt)).toEqual(["app:v2", "app:v2", "app:v2"]);
    expect([...rt.replicas.values()].every((r) => r.image === "app:v2")).toBe(true);
  });

  it("never has fewer than the original number of replicas in rotation", async () => {
    const rt = new FakeRuntime({ image: "app:v1", release: 1, count: 3 });
    await deploy(rt, cfg, "app:v2", 2, deps);
    for (const snapshot of rt.upstreamHistory) expect(snapshot.length).toBeGreaterThanOrEqual(3);
  });

  it("rolls back when a new replica fails its health check", async () => {
    const rt = new FakeRuntime({ image: "app:v1", release: 1, count: 3 });
    const result = await deploy(rt, cfg, "app:broken", 2, deps);
    expect(result.status).toBe("rolled_back");
    expect(images(rt)).toEqual(["app:v1", "app:v1", "app:v1"]);
    expect([...rt.replicas.values()].filter((r) => r.image === "app:broken")).toHaveLength(0);
    for (const snapshot of rt.upstreamHistory) expect(snapshot.every((r) => r.image === "app:v1")).toBe(true);
  });

  it("restarts already-replaced old replicas when a later one fails", async () => {
    const rt = new FakeRuntime({ image: "app:v1", release: 1, count: 3 });
    // replica 0 healthy (2 probes), replica 1 never healthy, then restored olds healthy
    rt.probes = ["healthy", "healthy", ...Array(10).fill("unhealthy")];
    const result = await deploy(rt, cfg, "app:v2", 2, deps);
    expect(result.status).toBe("rolled_back");
    expect(images(rt)).toEqual(["app:v1", "app:v1", "app:v1"]);
    expect(rt.upstreams.every((r) => rt.replicas.get(r.id)?.running)).toBe(true);
    for (const snapshot of rt.upstreamHistory) expect(snapshot.length).toBeGreaterThanOrEqual(3);
  });

  it("fails fast when a container exits on startup", async () => {
    const rt = new FakeRuntime({ image: "app:v1", release: 1, count: 3 });
    const result = await deploy(rt, cfg, "app:crash", 2, deps);
    expect(result).toMatchObject({ status: "rolled_back", reason: expect.stringContaining("exited") });
  });

  it("needs consecutive healthy probes (a flapping replica resets the streak)", async () => {
    const rt = new FakeRuntime();
    rt.probes = ["healthy", "unhealthy", "healthy", "healthy", "healthy", "healthy", "healthy", "healthy"];
    const one = parseConfig(`{app: app, image: x, replicas: 1, port: 1, publicPort: 2, healthCheck: {intervalMs: 10, timeoutMs: 100}}`);
    await deploy(rt, one, "app:v1", 1, deps);
    expect(rt.probes).toHaveLength(4); // 4 probes used: H, U, H, H
  });

  it("scales up and down", async () => {
    const rt = new FakeRuntime({ image: "app:v1", release: 1, count: 2 });
    await deploy(rt, cfg, "app:v2", 2, deps);
    expect(rt.upstreams).toHaveLength(3);
    const two = { ...cfg, replicas: 2 };
    await deploy(rt, two, "app:v3", 3, deps);
    expect(images(rt)).toEqual(["app:v3", "app:v3"]);
    expect(rt.replicas.size).toBe(2);
  });

  it("does not swallow unexpected runtime errors", async () => {
    const rt = new FakeRuntime();
    rt.startReplica = async () => {
      throw new Error("docker daemon unreachable");
    };
    await expect(deploy(rt, cfg, "app:v1", 1, deps)).rejects.toThrow("docker daemon unreachable");
  });
});
