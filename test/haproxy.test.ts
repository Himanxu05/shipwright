import { describe, expect, it } from "vitest";
import { parseSlots, planUpstreams, type Slot } from "../src/haproxy.js";

// Real output captured from HAProxy 3.2 after a few deploys.
const SHOW_SERVERS_STATE = `1
# be_id be_name srv_id srv_name srv_addr srv_op_state srv_admin_state srv_uweight srv_iweight srv_time_since_last_change srv_check_status srv_check_result srv_check_health srv_check_state srv_agent_state bk_f_forced_id srv_f_forced_id srv_fqdn srv_port srvrecord srv_use_ssl srv_check_port srv_check_addr srv_agent_addr srv_agent_port
3 app 1 s1 172.20.0.3 0 12 1 1 36 7 2 0 6 0 0 0 - 3000 - 0 0 - - 0
3 app 2 s2 172.20.0.4 2 4 1 1 48 15 3 2 6 0 0 0 - 3000 - 0 0 - - 0
3 app 4 s4 172.20.0.6 0 5 1 1 42 15 3 0 14 0 0 0 - 3000 - 0 0 - - 0
3 app 6 s6 127.0.0.1 0 5 1 1 118 1 0 0 14 0 0 0 - 3000 - 0 0 - - 0
`;

const slot = (name: string, addr: string, state: Slot["state"]): Slot => ({ name, addr, state });

describe("parseSlots", () => {
  it("reads the admin-state bits, not the display status", () => {
    expect(parseSlots(SHOW_SERVERS_STATE)).toEqual([
      slot("s1", "172.20.0.3", "drain"), // admin 12 = drain; `show stat` would say DOWN
      slot("s2", "172.20.0.4", "active"),
      slot("s4", "172.20.0.6", "maint"),
      slot("s6", "127.0.0.1", "maint"),
    ]);
  });
});

describe("planUpstreams", () => {
  it("fills free slots for new replicas", () => {
    const slots = [slot("s1", "127.0.0.1", "maint"), slot("s2", "127.0.0.1", "maint")];
    expect(planUpstreams(slots, ["10.0.0.5"], 3000)).toEqual([
      "set server app/s1 addr 10.0.0.5 port 3000",
      "set server app/s1 state ready",
    ]);
  });

  it("drains replicas that are no longer wanted and frees drained ones", () => {
    const slots = [slot("s1", "10.0.0.1", "drain"), slot("s2", "10.0.0.2", "active"), slot("s3", "10.0.0.3", "active")];
    expect(planUpstreams(slots, ["10.0.0.3"], 3000)).toEqual([
      "set server app/s1 state maint",
      "set server app/s2 state drain",
    ]);
  });

  it("does not reuse a slot it just freed", () => {
    const slots = [slot("s1", "10.0.0.1", "drain"), slot("s2", "127.0.0.1", "maint")];
    const cmds = planUpstreams(slots, ["10.0.0.9"], 3000);
    expect(cmds).toContain("set server app/s2 addr 10.0.0.9 port 3000");
    expect(cmds).not.toContain("set server app/s1 state ready");
  });

  it("re-activates a draining slot when its IP is wanted again (IP reused by a new container)", () => {
    const slots = [slot("s1", "10.0.0.1", "drain")];
    expect(planUpstreams(slots, ["10.0.0.1"], 3000)).toEqual(["set server app/s1 state ready"]);
  });

  it("does nothing when already in the desired state", () => {
    const slots = [slot("s1", "10.0.0.1", "active"), slot("s2", "127.0.0.1", "maint")];
    expect(planUpstreams(slots, ["10.0.0.1"], 3000)).toEqual([]);
  });

  it("errors when the slot pool is exhausted", () => {
    expect(() => planUpstreams([slot("s1", "10.0.0.1", "active")], ["10.0.0.1", "10.0.0.2"], 3000)).toThrow(/No free/);
  });
});
