import type { Config } from "./config.js";
import type { Replica } from "./runtime.js";

// Render the load balancer config. Replicas are addressed by container name,
// which Docker's embedded DNS resolves on the app's private network.
export function renderNginx(cfg: Config, replicas: Replica[]): string {
  if (replicas.length === 0) {
    return `server {\n  listen 80;\n  location / { return 503; }\n}\n`;
  }
  const servers = replicas.map((r) => `  server ${r.name}:${cfg.port} max_fails=1 fail_timeout=5s;`).join("\n");
  return `upstream ${cfg.app} {
${servers}
  keepalive 16;
}

server {
  listen 80;
  location / {
    proxy_pass http://${cfg.app};
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # If a replica refuses or drops a connection mid-switch, retry on another one.
    proxy_next_upstream error timeout http_502 http_503;
    proxy_next_upstream_tries 3;
    proxy_connect_timeout 2s;
  }
}
`;
}
