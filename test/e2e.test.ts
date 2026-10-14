// End-to-end against a real Docker daemon. Needs the demo images:
//   npm run demo:images && npm run test:e2e
import { afterAll, describe, expect, it } from "vitest";
import { startLoad } from "../scripts/load.js";
import { parseConfig } from "../src/config.js";
import { deploy } from "../src/deployer.js";
import { DockerRuntime } from "../src/docker-runtime.js";

const cfg = parseConfig(`
app: e2e
image: shipwright-demo:v1
replicas: 3
port: 3000
publicPort: 18090
env: { STARTUP_DELAY_MS: "500" }
healthCheck: { intervalMs: 200, timeoutMs: 5000 }
drainMs: 1000
`);
const rt = new DockerRuntime();
const deps = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), log: () => {} };
const url = `http://localhost:${cfg.publicPort}/`;

afterAll(() => rt.destroy(cfg.app));

describe("shipwright on Docker", { timeout: 120_000 }, () => {
  it("deploys the first release", async () => {
    await rt.destroy(cfg.app);
    expect((await deploy(rt, cfg, "shipwright-demo:v1", 1, deps)).status).toBe("succeeded");
    const res = await fetch(url);
    expect(await res.json()).toMatchObject({ version: "v1" });
  });

  it("rolls out a new version under load without failed requests", async () => {
    const load = startLoad(url, 10);
    const result = await deploy(rt, cfg, "shipwright-demo:v2", 2, deps);
    const report = await load.stop();
    expect(result.status).toBe("succeeded");
    expect(report.failed).toBe(0);
    expect(report.total).toBeGreaterThan(100);
    expect(await (await fetch(url)).json()).toMatchObject({ version: "v2" });
    expect((await rt.listReplicas(cfg.app)).map((r) => r.image)).toEqual(Array(3).fill("shipwright-demo:v2"));
  });

  it("rolls back a release that fails its health check, still without failed requests", async () => {
    const load = startLoad(url, 10);
    const result = await deploy(rt, cfg, "shipwright-demo:v3-broken", 3, deps);
    const report = await load.stop();
    expect(result.status).toBe("rolled_back");
    expect(report.failed).toBe(0);
    expect(Object.keys(report.byVersion)).toEqual(["v2"]);
    const replicas = await rt.listReplicas(cfg.app);
    expect(replicas.every((r) => r.image === "shipwright-demo:v2" && r.running)).toBe(true);
  });
});
