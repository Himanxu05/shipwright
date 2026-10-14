// HAProxy load balancer, driven through its Runtime API (an admin socket).
//
// Why not nginx: nginx changes upstreams by reloading, and on reload the old
// worker processes close idle keep-alive connections from clients. A client
// that sends a request on one of those connections at that moment gets a
// reset. Measured: 1 failed request per reload. HAProxy can change a
// backend's servers at runtime without a reload, so client connections are
// never closed.
//
// The backend has a fixed pool of server "slots" (s1..s40), all disabled at
// start. Putting a replica into rotation = point a free slot at its IP and
// set it ready. Taking one out = set its slot to "drain" (no new requests,
// in-flight ones finish), and on the next update to "maint" (free again).

export const BACKEND = "app";
export const SLOTS = 40;
export const ADMIN_SOCKET = "/tmp/admin.sock";

export function renderHaproxyConfig(healthPath: string, port: number): string {
  return `global
  stats socket ${ADMIN_SOCKET} mode 600 level admin

defaults
  mode http
  timeout connect 2s
  timeout client 30s
  timeout server 30s
  timeout http-keep-alive 10s
  # If a connection to a replica fails, retry on another one.
  retries 3
  option redispatch
  retry-on conn-failure empty-response

frontend web
  bind :80
  default_backend ${BACKEND}

backend ${BACKEND}
  balance roundrobin
  option httpchk GET ${healthPath}
  server-template s 1-${SLOTS} 127.0.0.1:${port} check inter 1s fall 2 rise 1 disabled
`;
}

export type SlotState = "active" | "drain" | "maint";
export interface Slot {
  name: string;
  addr: string; // IP only
  state: SlotState;
}

// srv_admin_state bits (HAProxy src/server.h). The human-readable status in
// `show stat` is not enough: a draining server whose health check fails is
// shown as "DOWN", not "DRAIN".
const ADMF_MAINT = 0x01 | 0x02 | 0x20 | 0x40; // forced, inherited, resolution, hostname maintenance
const ADMF_DRAIN = 0x08 | 0x10; // forced or inherited drain

// Parse `show servers state <backend>` into the backend's slots.
export function parseSlots(output: string): Slot[] {
  const lines = output.trim().split("\n");
  const headerAt = lines.findIndex((l) => l.startsWith("#"));
  const header = lines[headerAt]!.replace(/^# /, "").split(" ");
  const col = (name: string) => header.indexOf(name);
  const [be, sv, addr, admin] = [col("be_name"), col("srv_name"), col("srv_addr"), col("srv_admin_state")];
  return lines
    .slice(headerAt + 1)
    .map((line) => line.split(" "))
    .filter((f) => f[be] === BACKEND)
    .map((f) => {
      const flags = Number(f[admin]);
      const state: SlotState = flags & ADMF_MAINT ? "maint" : flags & ADMF_DRAIN ? "drain" : "active";
      return { name: f[sv]!, addr: f[addr]!, state };
    });
}

// Work out the Runtime API commands that make the set of active slots equal
// `desired` (replica IPs). Pure, so it is unit-tested without HAProxy.
export function planUpstreams(slots: Slot[], desired: string[], port: number): string[] {
  const want = new Set(desired);
  const placed = new Set<string>();
  const commands: string[] = [];
  const set = (slot: Slot, what: string) => commands.push(`set server ${BACKEND}/${slot.name} ${what}`);

  for (const slot of slots) {
    if (slot.state !== "maint" && want.has(slot.addr) && !placed.has(slot.addr)) {
      placed.add(slot.addr);
      if (slot.state === "drain") set(slot, "state ready");
    } else if (slot.state === "active") {
      set(slot, "state drain");
    } else if (slot.state === "drain") {
      set(slot, "state maint");
    }
  }

  // Only reuse slots that were already free, never one drained a moment ago.
  const free = slots.filter((s) => s.state === "maint");
  for (const ip of desired) {
    if (placed.has(ip)) continue;
    const slot = free.shift();
    if (!slot) throw new Error(`No free load balancer slots (max ${SLOTS})`);
    set(slot, `addr ${ip} port ${port}`);
    set(slot, "state ready");
    placed.add(ip);
  }
  return commands;
}
