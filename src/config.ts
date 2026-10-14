import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";

const schema = z.object({
  app: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes"),
  image: z.string().min(1),
  replicas: z.number().int().min(1).max(20).default(2),
  port: z.number().int().positive(), // port the app listens on inside its container
  publicPort: z.number().int().positive(), // port the load balancer publishes on the host
  env: z.record(z.string(), z.string()).default({}),
  healthCheck: z
    .object({
      path: z.string().startsWith("/").default("/health"),
      intervalMs: z.number().int().positive().default(500),
      timeoutMs: z.number().int().positive().default(30_000),
      // Consecutive successful probes needed before a replica takes traffic.
      healthyThreshold: z.number().int().positive().default(2),
    })
    .prefault({}),
  // How long the load balancer keeps sending in-flight requests to an old
  // replica after it is removed, before the replica gets SIGTERM.
  drainMs: z.number().int().nonnegative().default(2_000),
  stopTimeoutSec: z.number().int().positive().default(10),
});

export type Config = z.infer<typeof schema>;

export function parseConfig(text: string): Config {
  return schema.parse(parse(text));
}

export async function loadConfig(path: string): Promise<Config> {
  return parseConfig(await readFile(path, "utf8"));
}
