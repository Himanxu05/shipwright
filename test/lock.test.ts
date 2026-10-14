import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state.js";

const fresh = async () => {
  const dir = await mkdtemp(join(tmpdir(), "shipwright-"));
  return { dir, store: new StateStore(dir, "app") };
};

describe("StateStore", () => {
  it("allows only one deploy lock at a time", async () => {
    const { store } = await fresh();
    const unlock = await store.acquireLock();
    await expect(store.acquireLock()).rejects.toThrow(/Another deploy is running/);
    await unlock();
    const again = await store.acquireLock();
    await again();
  });

  it("takes over a lock left by a dead process", async () => {
    const { dir, store } = await fresh();
    await mkdir(join(dir, "app"), { recursive: true });
    await writeFile(join(dir, "app", "deploy.lock"), "999999"); // no such pid
    const unlock = await store.acquireLock();
    await unlock();
  });

  it("numbers releases from history", async () => {
    const { store } = await fresh();
    expect(await store.nextRelease()).toBe(1);
    await store.append({ release: 1, image: "a", status: "succeeded", startedAt: "", durationMs: 1 });
    await store.append({ release: 2, image: "b", status: "rolled_back", startedAt: "", durationMs: 1 });
    expect(await store.nextRelease()).toBe(3);
    expect((await store.history()).map((r) => r.image)).toEqual(["a", "b"]);
  });
});
