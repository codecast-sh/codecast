/**
 * The laptop side of the laptop Chrome link (decision sd-2645): each managed
 * cloud host that is up gets ONE ssh connection from this laptop carrying a
 * reverse forward of the bridge port, so `cast browser` on the host reaches
 * this laptop's bridge, and through it the human's Chrome, at its own
 * 127.0.0.1:<same port>. The host side is browser/bridge/laptopLink.ts.
 *
 * Why its own connection and not `ssh -O forward -R` on the sshBase master:
 * ensureUp evicts that master whenever it looks wedged and ControlPersist
 * ends it two minutes after its last channel, either of which would take the
 * forward with it; and the host's idle watchdog can only discount a
 * connection that runs a sleeper it can name. So this is a held connection
 * like the agent bridge (cloud/agentBridge.ts, heldConnection.ts): the remote
 * side writes the link file from the first stdin line (the token never sits
 * in an argv on either machine), then blocks in `cat` under argv0
 * `cast-browser-link`, which watchdog version 4 subtracts, and removes the
 * file when the connection ends, unless a newer link has replaced it. A line
 * the laptop writes after the first says why it closed the link on purpose
 * (revoked), and the remote side keeps it for the host's sessions to read.
 *
 * The daemon holds a link to every host whose watchdog is version 4. A host
 * at version 3 gets just its watchdog file rewritten on the first tick that
 * finds it up (rewriteHostIdleWatchdog); an older one needs `cast hosts
 * provision`.
 *
 * The token is minted per host each time the link opens (bridge/hostClients.ts)
 * and only its hash stays here. The machine-wide bridge token never leaves
 * this laptop. A host shared with teammates never gets a link: its other
 * users' sessions would be driving this human's Chrome.
 */

import * as os from "node:os";
import { spawn, type ChildProcess } from "../proc.js";
import { patchHost, readHosts, reachableRemoteHost, sshReachable, toRemoteHost, type CloudHost } from "../browser/cloudHost.js";
import type { RemoteHost } from "../remote/session-move.js";
import { bridgeAddressStale, heldSshArgs } from "./agentBridge.js";
import { HeldConnections } from "./heldConnection.js";
import { mintHostClientToken, readBridgeState, revokeHostClient, type BridgeState } from "../browser/bridge/host.js";
import { hashHostToken } from "../browser/bridge/hostClients.js";
import { LAPTOP_LINK_CLOSED_FILE, LAPTOP_LINK_FILE, type LaptopLink, type LaptopLinkClosed } from "../browser/bridge/laptopLink.js";

/** The idle watchdog version that subtracts the link's own connection. */
export const BROWSER_LINK_MIN_WATCHDOG = 4;
/** The oldest watchdog that rewriting its file alone brings up to date: from version 3 a host has the threshold file, the probe and sshfs. */
const IDLE_WATCHDOG_REWRITE_FROM = 3;
export const BROWSER_LINK_ARGV0 = "cast-browser-link";
/** The remote side's exit when it cannot write the link file. */
export const BROWSER_LINK_REFUSED_EXIT = 4;
export const BROWSER_LINK_TICK_MS = 60_000;

const LINK = `~/.codecast/browser/${LAPTOP_LINK_FILE}`;
const CLOSED = `~/.codecast/browser/${LAPTOP_LINK_CLOSED_FILE}`;

export const BROWSER_LINK_REMOTE =
  `umask 077; mkdir -p ~/.codecast/browser || exit ${BROWSER_LINK_REFUSED_EXIT}; ` +
  `IFS= read -r L || exit ${BROWSER_LINK_REFUSED_EXIT}; ` +
  `rm -f ${CLOSED}; ` +
  `printf '%s\\n' "$L" > ${LINK}.tmp && mv -f ${LINK}.tmp ${LINK} || exit ${BROWSER_LINK_REFUSED_EXIT}; ` +
  `(exec -a ${BROWSER_LINK_ARGV0} cat > ${CLOSED}.$$); ` +
  `if [ "$(cat ${LINK} 2>/dev/null)" = "$L" ]; then rm -f ${LINK}; [ -s ${CLOSED}.$$ ] && mv -f ${CLOSED}.$$ ${CLOSED}; fi; ` +
  `rm -f ${CLOSED}.$$; exit 0`;

/** The ssh argv for one link: the reverse forward, failing loudly when the host's port is taken. */
export function browserLinkArgs(host: RemoteHost, bridgePort: number): string[] {
  return heldSshArgs(host, BROWSER_LINK_REMOTE, {
    extra: ["-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:${bridgePort}:127.0.0.1:${bridgePort}`],
  });
}

/**
 * Why this laptop holds no link to the host, or null when it should. The
 * human opts a host out with `cast browser extension revoke --host`, which
 * records `laptopBrowser: false`; `cast browser extension link --host` turns
 * it back on.
 */
export function browserLinkRefusal(cloud: CloudHost, bridge: BridgeState | null, opts: { explicit?: boolean } = {}): string | null {
  if (cloud.shared) return "the host is shared with teammates: their sessions would drive this human's Chrome";
  if (cloud.laptopBrowser === false) return "turned off for this host (cast browser extension link --host to turn it on)";
  if (!bridge?.token || !bridge.extensionSeenAt) return "this laptop's Chrome extension was never paired (cast browser extension setup)";
  if (!opts.explicit && (cloud.watchdogVersion ?? 0) < BROWSER_LINK_MIN_WATCHDOG) {
    return `the host's idle watchdog (version ${cloud.watchdogVersion ?? 1}) would count the link as activity; \`cast hosts provision ${cloud.id}\` installs version ${BROWSER_LINK_MIN_WATCHDOG}`;
  }
  return null;
}

const laptopName = (): string => os.hostname().replace(/\.local$/, "");

/**
 * Open one link: mint the host's token, start the connection, hand the
 * remote side the link file on stdin. The child's stdin stays open; ending
 * it (or the connection) ends the link.
 */
export function openBrowserLink(
  cloud: CloudHost,
  remote: RemoteHost,
  deps: { spawn?: typeof spawn; bridge?: BridgeState | null; laptop?: string } = {},
): { child: ChildProcess; tokenHash: string } {
  const bridge = deps.bridge ?? readBridgeState();
  if (!bridge?.token) throw new Error("this laptop's bridge is not set up");
  const laptop = deps.laptop ?? laptopName();
  const token = mintHostClientToken(cloud.id, `${cloud.id}${remote.address ? ` (${remote.address})` : ""}`);
  const link: LaptopLink = { v: 1, port: bridge.port, token, hostId: cloud.id, laptop, linkedAt: Date.now() };
  const child = (deps.spawn ?? spawn)("ssh", browserLinkArgs(remote, bridge.port), { stdio: ["pipe", "ignore", "pipe"], env: process.env });
  child.stdin?.on("error", () => {});
  child.stdin?.write(`${JSON.stringify(link)}\n`);
  return { child, tokenHash: hashHostToken(token) };
}

/** End a link on purpose: EOF ends the remote `cat` (and removes the file); the kill is the backstop. */
export function stopBrowserLink(child: ChildProcess, graceMs = 5_000): void {
  try { child.stdin?.end(); } catch { /* gone */ }
  const timer = setTimeout(() => { try { child.kill(); } catch { /* exited */ } }, graceMs);
  child.once("exit", () => clearTimeout(timer));
}

/** Before closing a link on purpose, tell the host why, so its sessions can say so. */
export function tellLinkClosing(child: ChildProcess, closed: LaptopLinkClosed): void {
  try { child.stdin?.write(`${JSON.stringify(closed)}\n`); } catch { /* gone */ }
}

export const browserLinkRefusalForExit = (code: number | null): string | null =>
  code === BROWSER_LINK_REFUSED_EXIT ? "the host could not write its link file (~/.codecast/browser): not retried until the link is turned on again" : null;

/**
 * The links this process holds, one per host. The daemon keeps one for its
 * life and ticks it (BROWSER_LINK_TICK_MS); `cast browser extension link`
 * keeps one in the foreground, so the whole path runs without touching the
 * live daemon. A link that ends, for any reason, takes its token with it:
 * the next link mints a fresh one, and a host whose laptop went away holds
 * nothing that would open the bridge again.
 */
export class BrowserLinks {
  private readonly held: HeldConnections;
  private inFlight = false;
  /** The token each live link minted, so closing it revokes that token at once. */
  private readonly tokens = new Map<string, string>();
  /** Hosts whose watchdog rewrite was tried by this process: one try each, so a failing host costs one ssh. */
  private readonly rewriteTried = new Set<string>();

  constructor(private readonly o: {
    log: (m: string, level?: "warn") => void;
    only?: string;
    explicit?: boolean;
    spawn?: typeof spawn;
    rewriteWatchdog?: (remote: RemoteHost) => Promise<{ version: number } | { failed: string }>;
  }) {
    this.held = new HeldConnections({
      tag: "[BROWSER-LINK]",
      log: o.log,
      refusal: (code) => browserLinkRefusalForExit(code),
      stop: (child) => stopBrowserLink(child),
    });
  }

  /** Hosts with a live link right now. */
  live(): string[] { return [...this.held.entries()].map(([id]) => id); }

  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const bridge = readBridgeState();
      const hosts = readHosts().filter((h) => !this.o.only || h.id === this.o.only);
      for (const [id, c] of [...this.held.entries()]) {
        const h = hosts.find((x) => x.id === id);
        const why = h ? browserLinkRefusal(h, bridge, this.o) : "the host was removed";
        if (why) {
          if (h?.laptopBrowser === false) tellLinkClosing(c.child, { v: 1, reason: "revoked", laptop: laptopName(), hostId: id, at: Date.now() });
          this.held.close(id, why);
          this.held.forget(id);
          continue;
        }
        if (h!.address && bridgeAddressStale(h!, c.address, toRemoteHost(h!).address)) this.held.close(id, `its address changed ${c.address} -> ${h!.address}`);
      }
      for (let h of hosts) {
        if (!h.address || !this.held.canOpen(h.id)) continue;
        const why = browserLinkRefusal(h, bridge, this.o);
        const rewrite = why !== null && this.watchdogRewritable(h, bridge);
        if (why && !rewrite) continue;
        // Probed, never woken: a sleeping host has no session to serve.
        const remote = await reachableRemoteHost(h, { toRemoteHost, sshReachable });
        if (!remote) continue;
        if (rewrite) {
          const upgraded = await this.rewriteWatchdog(h, remote);
          if (!upgraded) continue;
          h = upgraded;
        }
        const { child, tokenHash } = openBrowserLink(h, remote, { bridge, spawn: this.o.spawn });
        // Only this link's token: a newer link to the same host has its own.
        this.tokens.set(h.id, tokenHash);
        child.once("exit", () => { revokeHostClient(h.id, tokenHash); });
        this.held.hold(h.id, `Chrome link to ${h.id}`, remote.address, child);
        this.o.log(`[BROWSER-LINK] ${h.id} (${remote.address}) reaches this laptop's Chrome at its 127.0.0.1:${bridge!.port}`);
      }
    } catch (err) {
      this.o.log(`[BROWSER-LINK] maintenance failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
    } finally {
      this.inFlight = false;
    }
  }

  /** A host refused only for its watchdog version, whose watchdog file alone can be brought up to date. */
  private watchdogRewritable(h: CloudHost, bridge: BridgeState | null): boolean {
    const v = h.watchdogVersion ?? 0;
    return h.platform === "linux" && v >= IDLE_WATCHDOG_REWRITE_FROM && v < BROWSER_LINK_MIN_WATCHDOG
      && !this.rewriteTried.has(h.id) && browserLinkRefusal(h, bridge, { explicit: true }) === null;
  }

  private async rewriteWatchdog(h: CloudHost, remote: RemoteHost): Promise<CloudHost | null> {
    this.rewriteTried.add(h.id);
    const rewrite = this.o.rewriteWatchdog ?? (async (r: RemoteHost) => (await import("../browser/provisionLinux.js")).rewriteHostIdleWatchdog(r));
    const r = await rewrite(remote);
    if ("failed" in r) {
      this.o.log(`[BROWSER-LINK] no link to ${h.id}: its idle watchdog (version ${h.watchdogVersion}) could not be updated: ${r.failed}; \`cast hosts provision ${h.id}\` updates it`, "warn");
      return null;
    }
    this.o.log(`[BROWSER-LINK] ${h.id}'s idle watchdog updated to version ${r.version}, which ignores the link`);
    return patchHost(h.id, { watchdogVersion: r.version }) ?? { ...h, watchdogVersion: r.version };
  }

  /** Close every link (daemon shutdown, Ctrl-C on the foreground command). */
  closeAll(why: string): void {
    for (const [id] of [...this.held.entries()]) {
      this.held.close(id, why);
      // Now, not on the child's exit: a process ending right after this
      // would leave the token valid behind it.
      const hash = this.tokens.get(id);
      if (hash) revokeHostClient(id, hash);
    }
  }
}

/**
 * What the laptop daemon runs: one BrowserLinks for its life, ticked every
 * BROWSER_LINK_TICK_MS after a first tick at `firstTickMs`. The caller closes
 * it with closeAll on shutdown.
 */
export function startBrowserLinks(o: { log: (m: string, level?: "warn") => void; firstTickMs: number }): BrowserLinks {
  const links = new BrowserLinks({ log: o.log });
  setTimeout(() => { void links.tick(); }, o.firstTickMs);
  setInterval(() => { void links.tick(); }, BROWSER_LINK_TICK_MS);
  return links;
}
