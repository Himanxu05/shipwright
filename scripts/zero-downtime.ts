// Benchmark: deploy a new image while sending traffic, report failed requests.
//   tsx scripts/zero-downtime.ts shipwright-demo:v2 [concurrency]
import { spawn } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { startLoad } from "./load.js";

const [image = "shipwright-demo:v2", concurrency = "20"] = process.argv.slice(2);
const cfg = await loadConfig("shipwright.yaml");
const load = startLoad(`http://localhost:${cfg.publicPort}/`, Number(concurrency));
await new Promise((r) => setTimeout(r, 1000));
const t0 = Date.now();
// Async spawn: a sync exec would block this process's event loop and freeze the load generator.
const ok = await new Promise<boolean>((resolve) => {
  spawn("npx", ["tsx", "src/cli.ts", ...process.argv.slice(4), "deploy", "--image", image], { stdio: "inherit" }).on(
    "exit",
    (code) => resolve(code === 0),
  );
});
const deploySeconds = (Date.now() - t0) / 1000;
await new Promise((r) => setTimeout(r, 1000));
console.log(JSON.stringify({ image, deploySucceeded: ok, deploySeconds, ...(await load.stop()) }, null, 2));
