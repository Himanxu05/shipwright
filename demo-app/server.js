// Tiny demo service for trying Shipwright. No dependencies.
//   VERSION           reported in every response
//   BROKEN=1          /health always fails (to demo automatic rollback)
//   STARTUP_DELAY_MS  simulate a slow boot before listening
import { createServer } from "node:http";
import { hostname } from "node:os";

const version = process.env.VERSION ?? "dev";
const broken = process.env.BROKEN === "1";
const port = Number(process.env.PORT ?? 3000);

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(broken ? 500 : 200).end(broken ? "unhealthy" : "ok");
    return;
  }
  // A little work per request so in-flight requests overlap with shutdowns.
  setTimeout(() => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version, host: hostname() }));
  }, 20);
});

setTimeout(() => server.listen(port, () => console.log(`demo ${version} on :${port}`)), Number(process.env.STARTUP_DELAY_MS ?? 0));

// Graceful shutdown: stop accepting new connections, finish in-flight
// requests, close idle keep-alive connections, then exit.
process.on("SIGTERM", () => {
  console.log("SIGTERM: draining");
  server.close(() => process.exit(0));
  server.closeIdleConnections();
});
