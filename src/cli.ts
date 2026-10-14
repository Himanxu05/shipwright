#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, type Config } from "./config.js";
import { deploy } from "./deployer.js";
import { DockerRuntime } from "./docker-runtime.js";
import { StateStore } from "./state.js";

const program = new Command()
  .name("shipwright")
  .description("Zero-downtime rolling deploys for Docker containers behind nginx")
  .option("-f, --file <path>", "config file", "shipwright.yaml")
  .option("--state-dir <dir>", "where deploy history is kept", ".shipwright");

const runtime = new DockerRuntime();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${msg}`);

async function context() {
  const opts = program.opts<{ file: string; stateDir: string }>();
  const cfg = await loadConfig(opts.file);
  return { cfg, store: new StateStore(opts.stateDir, cfg.app) };
}

async function runDeploy(cfg: Config, store: StateStore, image: string): Promise<boolean> {
  const unlock = await store.acquireLock();
  const started = Date.now();
  const release = await store.nextRelease();
  try {
    const result = await deploy(runtime, cfg, image, release, { sleep, log });
    await store.append({
      release,
      image,
      status: result.status,
      reason: result.status === "rolled_back" ? result.reason : undefined,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
    });
    return result.status === "succeeded";
  } catch (err) {
    await store.append({
      release,
      image,
      status: "error",
      reason: (err as Error).message,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
    });
    throw err;
  } finally {
    await unlock();
  }
}

program
  .command("deploy")
  .description("roll out an image (defaults to the image in the config file)")
  .option("-i, --image <image>", "image to deploy")
  .action(async (opts: { image?: string }) => {
    const { cfg, store } = await context();
    const ok = await runDeploy(cfg, store, opts.image ?? cfg.image);
    process.exitCode = ok ? 0 : 1;
  });

program
  .command("rollback")
  .description("redeploy the image of the previous successful release")
  .action(async () => {
    const { cfg, store } = await context();
    const good = (await store.history()).filter((r) => r.status === "succeeded");
    const target = good.at(-2);
    if (!target) throw new Error("No earlier successful release to roll back to");
    log(`rolling back to release ${target.release} (${target.image})`);
    process.exitCode = (await runDeploy(cfg, store, target.image)) ? 0 : 1;
  });

program
  .command("status")
  .description("show running replicas")
  .action(async () => {
    const { cfg } = await context();
    const replicas = await runtime.listReplicas(cfg.app);
    console.table(
      replicas.map((r) => ({
        name: r.name,
        release: r.release,
        image: r.image,
        state: r.running ? "running" : "stopped",
        hostPort: r.hostPort,
      })),
    );
  });

program
  .command("history")
  .description("list past releases")
  .action(async () => {
    const { store } = await context();
    console.table(await store.history());
  });

program
  .command("destroy")
  .description("remove all containers and the network for this app")
  .action(async () => {
    const { cfg } = await context();
    await runtime.destroy(cfg.app);
    log(`removed ${cfg.app}`);
  });

program.parseAsync().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
