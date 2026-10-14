import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("fills in defaults", () => {
    const cfg = parseConfig("app: web\nimage: web:1\nport: 3000\npublicPort: 80\n");
    expect(cfg.replicas).toBe(2);
    expect(cfg.healthCheck).toEqual({ path: "/health", intervalMs: 500, timeoutMs: 30000, healthyThreshold: 2 });
    expect(cfg.drainMs).toBe(2000);
  });

  it("rejects invalid app names and replica counts", () => {
    expect(() => parseConfig("app: Web_App\nimage: x\nport: 1\npublicPort: 2\n")).toThrow();
    expect(() => parseConfig("app: web\nimage: x\nport: 1\npublicPort: 2\nreplicas: 0\n")).toThrow();
  });
});
