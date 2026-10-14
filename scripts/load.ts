// Send requests to the load balancer with fixed concurrency until stopped,
// then report how many failed. Used to check that deploys are zero-downtime.
//
//   tsx scripts/load.ts http://localhost:8090 20     (Ctrl-C to stop and print)

export interface LoadReport {
  total: number;
  failed: number;
  byVersion: Record<string, number>;
  errors: Record<string, number>;
  p50Ms: number;
  p99Ms: number;
  rps: number;
}

export function startLoad(url: string, concurrency: number): { stop: () => Promise<LoadReport> } {
  let running = true;
  const latencies: number[] = [];
  const byVersion: Record<string, number> = {};
  const errors: Record<string, number> = {};
  let failed = 0;
  const started = performance.now();

  const worker = async () => {
    while (running) {
      const t0 = performance.now();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        const body = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { version } = JSON.parse(body) as { version: string };
        byVersion[version] = (byVersion[version] ?? 0) + 1;
      } catch (err) {
        failed++;
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        const key = cause ? `${(err as Error).message}: ${cause.code ?? cause.message}` : (err as Error).message;
        errors[key] = (errors[key] ?? 0) + 1;
      }
      latencies.push(performance.now() - t0);
    }
  };
  const workers = Array.from({ length: concurrency }, worker);

  return {
    async stop() {
      running = false;
      await Promise.all(workers);
      const seconds = (performance.now() - started) / 1000;
      const sorted = latencies.toSorted((a, b) => a - b);
      const pct = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
      return {
        total: latencies.length,
        failed,
        byVersion,
        errors,
        p50Ms: pct(0.5),
        p99Ms: pct(0.99),
        rps: Math.round(latencies.length / seconds),
      };
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const load = startLoad(process.argv[2] ?? "http://localhost:8090", Number(process.argv[3] ?? 20));
  process.on("SIGINT", async () => {
    console.log(JSON.stringify(await load.stop(), null, 2));
    process.exit(0);
  });
}
