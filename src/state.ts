import { mkdir, open, readFile, rm, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

export interface ReleaseRecord {
  release: number;
  image: string;
  status: "succeeded" | "rolled_back" | "error";
  reason?: string;
  startedAt: string;
  durationMs: number;
}

// Deploy history and the deploy lock live in <stateDir>/<app>/.
export class StateStore {
  private readonly dir: string;

  constructor(stateDir: string, app: string) {
    this.dir = join(stateDir, app);
  }

  async history(): Promise<ReleaseRecord[]> {
    try {
      return JSON.parse(await readFile(join(this.dir, "history.json"), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async nextRelease(): Promise<number> {
    const records = await this.history();
    return (records.at(-1)?.release ?? 0) + 1;
  }

  async append(record: ReleaseRecord): Promise<void> {
    const records = [...(await this.history()), record];
    await mkdir(this.dir, { recursive: true });
    // Write-then-rename so a crash mid-write never leaves a half-written file.
    const tmp = join(this.dir, "history.json.tmp");
    await writeFile(tmp, JSON.stringify(records, null, 2));
    await rename(tmp, join(this.dir, "history.json"));
  }

  // Only one deploy per app at a time. "wx" makes creating the lock file
  // atomic: if two processes race, exactly one open() succeeds. A lock left by
  // a process that has since died is detected by its PID and taken over.
  async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, "deploy.lock");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(path, "wx");
        await handle.writeFile(String(process.pid));
        await handle.close();
        return () => rm(path, { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const pid = Number(await readFile(path, "utf8").catch(() => "0"));
        if (pid && isAlive(pid)) throw new Error(`Another deploy is running (pid ${pid})`);
        await rm(path, { force: true }); // stale lock
      }
    }
    throw new Error("Could not acquire deploy lock");
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check only
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
