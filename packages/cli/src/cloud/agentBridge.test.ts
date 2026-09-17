import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { CloudHost } from "../browser/cloudHost";
import {
  AGENT_BRIDGE_ARGV0, AGENT_BRIDGE_HEALTHY_MS, AGENT_BRIDGE_MAX_BACKOFF_MS, AGENT_BRIDGE_REFUSED_EXIT, AGENT_BRIDGE_REMOTE,
  AGENT_BRIDGE_TICK_MS, HOST_AGENT_SOCK, agentBridgeArgs, hostAgentSocketEnv, nextBridgeBackoff, shouldRunBridge,
} from "./agentBridge";
import { sshBase } from "../remote/session-move";

const host = { address: "1.2.3.4", user: "ubuntu", keyPath: "/k", remoteBaseDir: "/home/ubuntu/work", homeDir: "/home/ubuntu" };
const cloud: CloudHost = { id: "i-1", provider: "aws", region: "us-west-2", user: "ubuntu", keyPath: "/k", address: "1.2.3.4", forwardAgent: true, watchdogVersion: 2 };

describe("agentBridgeArgs — one dedicated forwarding connection", () => {
  const args = agentBridgeArgs(host);
  const opts = args.filter((_, i) => args[i - 1] === "-o");

  test("forwards the agent on its OWN connection: no control master, no shared socket, -T, keepalives", () => {
    expect(opts).toContain("ForwardAgent=yes");
    expect(opts).toContain("ControlMaster=no");
    expect(opts).toContain("ControlPath=none");
    expect(opts).toContain("ServerAliveInterval=15");
    expect(opts).toContain("ServerAliveCountMax=3");
    expect(opts).toContain("BatchMode=yes");
    expect(opts).toContain("IdentitiesOnly=yes");
    expect(args).toContain("-T");
    expect(args.slice(0, 2)).toEqual(["-i", "/k"]);
    // The shared transfer socket that ensureUp evicts with `-O exit` must not appear.
    const shared = sshBase(host).find((a) => a.startsWith("ControlPath="))!;
    expect(shared).toMatch(/^ControlPath=.*cast-ssh-ubuntu-1\.2\.3\.4$/);
    expect(args).not.toContain(shared);
    expect(args.at(-2)).toBe("ubuntu@1.2.3.4");
    expect(args.at(-1)).toBe(AGENT_BRIDGE_REMOTE);
  });

  test("the remote side verifies the forwarded socket, exits 3 without one, links it, and blocks as cast-agent-bridge on stdin", () => {
    expect(AGENT_BRIDGE_REFUSED_EXIT).toBe(3);
    expect(AGENT_BRIDGE_REMOTE.startsWith('[ -S "$SSH_AUTH_SOCK" ] || exit 3; ')).toBe(true);
    expect(AGENT_BRIDGE_REMOTE).toContain('ln -sfn "$SSH_AUTH_SOCK" ~/.codecast/ssh-agent.sock');
    expect(AGENT_BRIDGE_REMOTE).toContain(`(exec -a ${AGENT_BRIDGE_ARGV0} cat >/dev/null)`);
    expect(AGENT_BRIDGE_REMOTE.endsWith("rm -f ~/.codecast/ssh-agent.sock")).toBe(true);
    expect(AGENT_BRIDGE_ARGV0).toBe("cast-agent-bridge");
    // No sleeper that survives a disconnect.
    expect(AGENT_BRIDGE_REMOTE).not.toContain("sleep");
  });
});

describe("shouldRunBridge", () => {
  test("only when on, reachable, with a laptop agent, on a watchdog that ignores the bridge", () => {
    expect(shouldRunBridge(cloud, true, "/tmp/agent.sock")).toBe(true);
    expect(shouldRunBridge({ ...cloud, forwardAgent: false }, true, "/tmp/agent.sock")).toBe(false);
    expect(shouldRunBridge({ ...cloud, forwardAgent: undefined }, true, "/tmp/agent.sock")).toBe(false);
    expect(shouldRunBridge(cloud, false, "/tmp/agent.sock")).toBe(false);
    expect(shouldRunBridge(cloud, true, undefined)).toBe(false);
    expect(shouldRunBridge(cloud, true, "")).toBe(false);
    expect(shouldRunBridge({ ...cloud, watchdogVersion: 1 }, true, "/tmp/agent.sock")).toBe(false);
    expect(shouldRunBridge({ ...cloud, watchdogVersion: undefined }, true, "/tmp/agent.sock")).toBe(false);
  });
});

describe("nextBridgeBackoff — a broken bridge cannot keep a box awake", () => {
  test("consecutive fast failures double from one tick to the five-minute cap", () => {
    const now = 1_000_000;
    const waits: number[] = [];
    let prev: ReturnType<typeof nextBridgeBackoff> | undefined;
    for (let i = 0; i < 6; i++) {
      prev = nextBridgeBackoff(prev, 500, now);
      waits.push(prev.notBefore - now);
    }
    expect(waits).toEqual([60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
    expect(prev!.failures).toBe(6);
    expect(AGENT_BRIDGE_MAX_BACKOFF_MS).toBe(5 * AGENT_BRIDGE_TICK_MS);
  });

  test("a bridge that lived past two ticks was working: its exit is the first failure again", () => {
    const now = 1_000_000;
    const deep = nextBridgeBackoff({ failures: 5, notBefore: 0 }, AGENT_BRIDGE_HEALTHY_MS, now);
    expect(deep).toEqual({ failures: 1, notBefore: now + AGENT_BRIDGE_TICK_MS });
    // One millisecond short of healthy still compounds.
    expect(nextBridgeBackoff({ failures: 2, notBefore: 0 }, AGENT_BRIDGE_HEALTHY_MS - 1, now).failures).toBe(3);
  });
});

describe("hostAgentSocketEnv — the launch-prefix token on the host", () => {
  let dir: string, server: net.Server | null, saved: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-bridge-"));
    server = null;
    saved = process.env.CODECAST_REMOTE_DEVICE;
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.CODECAST_REMOTE_DEVICE; else process.env.CODECAST_REMOTE_DEVICE = saved;
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function listen(sockPath: string): Promise<void> {
    server = net.createServer();
    return new Promise((r) => server!.listen(sockPath, () => r()));
  }

  test("'' unless CODECAST_REMOTE_DEVICE=1 and the symlink resolves to a live socket; '' for a dangling symlink; the default path is ~/.codecast/ssh-agent.sock", async () => {
    // The bridge leaves a SYMLINK to sshd's forwarded socket — stat must follow it.
    const real = path.join(dir, "agent.sock");
    const link = path.join(dir, "ssh-agent.sock");
    await listen(real);
    fs.symlinkSync(real, link);
    delete process.env.CODECAST_REMOTE_DEVICE;
    expect(hostAgentSocketEnv(link)).toBe("");
    process.env.CODECAST_REMOTE_DEVICE = "1";
    expect(hostAgentSocketEnv(link)).toBe(`SSH_AUTH_SOCK='${link}'`);
    expect(hostAgentSocketEnv(real)).toBe(`SSH_AUTH_SOCK='${real}'`);
    // Dangling (the bridge closed and sshd removed its socket): nothing exported.
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(hostAgentSocketEnv(link)).toBe("");
    expect(hostAgentSocketEnv(path.join(dir, "missing"))).toBe("");
    // A plain file at the path is not an agent either.
    fs.writeFileSync(path.join(dir, "file"), "");
    expect(hostAgentSocketEnv(path.join(dir, "file"))).toBe("");
    expect(HOST_AGENT_SOCK).toBe(path.join(os.homedir(), ".codecast", "ssh-agent.sock"));
  });
});
