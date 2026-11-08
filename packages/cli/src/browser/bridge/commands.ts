/**
 * The `cast browser` commands that manage the real-Chrome bridge: `target`
 * (which browser verbs act on by default), `extension setup|status|revoke`
 * (the host and its token), and the hidden `bridge-host` entry the host
 * process is started through.
 *
 * Registered from BOTH drivers, the engine path (cliEngine.ts) and the
 * built-in driver (cli.ts), so there is one definition of each. Before this
 * lived here the engine path returned before these were registered, and
 * `cast browser extension status` answered "unknown command" on every machine
 * with the engine installed.
 */

import type { Command } from "commander";
import { agentSetupLines } from "@codecast/shared/contracts";
import { fmt, icons } from "../../colors.js";
import { realChromePid } from "../localChrome.js";
import type { StartOptions } from "../managedBrowser.js";
import {
  bridgeHostLogPath, bridgeStatePath, bridgeStatus, bridgeWsUrl, ensureBridgeConfig, ensureBridgeHost, probeHost, readBridgeState,
  reloadExtension, revokeHostClient, rotateBridgeToken, runBridgeHost, stopBridgeHost, waitForExtension, waitForPairedProfile, writeBridgeState, type BridgeHostStatus, type BridgeState,
} from "./host.js";
import { findProfile, mintPairingCode, PAIRING_CODE_TTL_MS, readPairing, revokeAllProfiles, revokeProfile } from "./pairing.js";
import { describeProfile, extensionProfiles, matchProfile, pickBridgeProfile, type ExtensionProfiles } from "./chromeProfiles.js";
import type { RealProfile } from "../profile.js";
import { BRIDGE_EXTENSION_ID, BRIDGE_STORE_URL, bridgePairingUrl } from "./protocol.js";
import { connectRealBridge, hostBrowserChoice, hostOwnsBrowser, isRealMode, requireRealBridge, setStickyTarget, stickyTarget } from "./real.js";
import { CHROME_LAUNCHER_NAME, installChromeLauncher, openInRealChrome, REAL_CHROME_LAUNCH_ARGS, restartRealChrome, settlePairingPage } from "./realChrome.js";
import { ownedDesktopPane, PANE_HOW_TO } from "../desktopPane.js";

const OK = `${fmt.success(icons.check)}`;
const BAD = `${fmt.error(icons.cross)}`;
const WARN = `${fmt.warning("!")}`;

function die(msg: string, hint?: string): never {
  console.error(`${BAD} ${msg}`);
  if (hint) console.error(`  ${fmt.muted(hint)}`);
  process.exit(1);
}

export interface BridgeCommandDeps {
  /** The calling codecast session's owner key; sticky targets are per session. */
  me: () => string | null;
}

export function targetFlags(cmd: Command): Command {
  return cmd
    .option("--real", "Use the human's Chrome through the extension (default)")
    .option("--pane", "Use the desktop app's browser pane opened for this session (`target pane` makes it stick)")
    .option("--browser <id>", "The connected Chrome profile to open this session's tabs in (`cast browser extension status` lists ids); the session stays in it");
}

export const BROWSER_START_HELP = `
Normal use: cast browser start connects to the human's Chrome through the extension.
Missing pairing or a disconnected extension reports a recovery step and never
launches a separate browser. Check the connection with cast browser extension status.`;

export async function prepareRealBrowserStart(
  opts: Partial<StartOptions> & { real?: boolean; clone?: boolean },
  sessionKey: string | null,
): Promise<boolean> {
  if (!isRealMode(opts, sessionKey)) return false;
  const launchOptions = Object.entries(opts).filter(([key, value]) => key !== "real" && key !== "clone" && value !== undefined && value !== false);
  if (launchOptions.length) {
    throw new Error("browser launch options are unavailable in ordinary commands. Use `cast browser start` to connect to the human's Chrome.");
  }
  await requireRealBridge();
  console.log(`${OK} connected to the human's Chrome through the extension`);
  return true;
}

/** The agent's next step and the marker that puts the setup card under this command. */
function printSetupCard(): void {
  for (const line of agentSetupLines("browser")) console.log(line);
}

/** A remote host's browser is its own Chrome, which every verb starts on demand: nothing to pair. */
function printHostBrowser(): void {
  console.log(`target: ${fmt.highlight("host")}${fmt.muted(" (this host's own Chrome, on the screen the session's browser view and `cast hosts vnc` show)")}`);
  const choice = hostBrowserChoice();
  if (choice?.mode === "host") console.log(`${WARN} ${choice.laptop ? `${choice.laptop}'s Chrome` : "the laptop's Chrome"} is not in use: ${choice.reason}`);
  console.log(fmt.muted("  no extension needed: `cast browser open <url>` starts it; `cast browser sync <site>` carries a login in from the owner's laptop"));
}

/** On a cloud host driving its laptop's Chrome: which laptop, and is the extension there. */
function printLaptopBrowser(): boolean {
  const choice = hostBrowserChoice();
  if (choice?.mode !== "laptop") return false;
  console.log(`target: ${fmt.highlight(`${choice.laptop}'s Chrome`)}${fmt.muted(` (the laptop's own Chrome, through its link on 127.0.0.1:${choice.bridge.port})`)}`);
  console.log(connectedLine(choice.status));
  console.log(fmt.muted("  agent tabs open in the laptop Chrome's group for this session; when the laptop is away this host falls back to its own Chrome"));
  return true;
}

/**
 * A host from a cast before build stamps (hostBuild.ts) answers /status with
 * no build. No newer CLI replaces it on its own, since it has no /retire to
 * drain on, so it keeps running the old host (none of the host guardrails)
 * until it is stopped. Says so, with the step; null for a stamped host.
 */
export function unstampedHostLine(s: Pick<BridgeHostStatus, "build">, hostPid: number | undefined): string | null {
  if (s.build) return null;
  const stop = hostPid ? `\`kill ${hostPid}\`` : "stop the `cast browser bridge-host` process";
  return `${WARN} the bridge host is from an older cast and is not replaced on its own: ${stop}, and the next \`cast browser\` command starts this one (the extension reconnects by itself, no re-pairing)`;
}

/** One line for a connected extension, the same wherever it is reported. */
function connectedLine(s: BridgeHostStatus): string {
  const skew = s.protocol !== undefined && s.extensionProtocol !== undefined && s.protocol !== s.extensionProtocol
    ? ` — the host speaks protocol ${s.protocol}; the extension updates from the Chrome Web Store once its review passes`
    : "";
  return `${OK} extension connected${s.extensionVersion ? ` (v${s.extensionVersion}, protocol ${s.extensionProtocol})` : ""}${skew}`;
}

/**
 * Rotate the token and stop the host holding the old one, waiting until the
 * port is free. Every extension still on the shared token is cut off.
 */
async function rotateAndStopHost(): Promise<{ next: BridgeState; stopped: boolean }> {
  const next = rotateBridgeToken();
  const stopped = stopBridgeHost();
  if (stopped) {
    // Give the old host a beat to free the port before the next auto-start.
    // It holds the old token, so "alive" is not the question; "gone" is.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && (await probeHost(next, 300)) !== "down") {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return { next, stopped };
}

/** The profile lines `setup` and `status` share: which profile agents use, and where else the extension is. */
function printProfileLines(found: ExtensionProfiles, chosen: RealProfile | null, pinned: boolean): void {
  if (!found.known || !chosen) return;
  console.log(`  default Chrome profile: ${fmt.highlight(describeProfile(chosen))}`);
  const others = found.withExtension.filter((p) => p.dir !== chosen.dir);
  if (!others.length) return;
  console.log(fmt.muted(`  also installed in ${others.map(describeProfile).join(", ")}${pinned ? "; new sessions use the profile above unless they pass --browser <id>" : ""}`));
  console.log(fmt.muted(pinned
    ? `  pair another profile, or make it the default: cast browser extension setup --profile "<name>"`
    : `  no default yet: cast browser extension setup [--profile "<name>"] pairs a profile and makes it the default`));
}

/** One line per connected profile, the default first-marked: what `status` shows. */
function printConnectedProfiles(s: BridgeHostStatus): void {
  const profiles = s.profiles ?? [];
  if (profiles.length < 1) return;
  for (const p of profiles) {
    const tags = [p.default ? "default" : null, p.legacy ? "shared token, pre-profile extension" : null, p.sessions ? `${p.sessions} session${p.sessions === 1 ? "" : "s"}` : null].filter(Boolean);
    console.log(`  ${p.default ? fmt.success(icons.check) : fmt.muted(icons.dot)} ${fmt.highlight(p.id)}  ${p.name}${p.dir ? fmt.muted(` (${p.dir})`) : ""}${p.version ? fmt.muted(` v${p.version}`) : ""}${tags.length ? fmt.muted(`  ${tags.join(", ")}`) : ""}`);
  }
  if (profiles.length > 1) console.log(fmt.muted("  a session opens tabs in the default unless it passes `--browser <id>` on open; it stays in its profile"));
}

/**
 * How long `setup` waits for the extension after handing Chrome the pairing
 * URL. A new token asks the human for one click on the options page, so this
 * is a person's reaction time, not a socket's.
 */
const PAIRING_WAIT_MS = 30_000;

export function registerBridgeCommands(br: Command, deps: BridgeCommandDeps): void {
  const { me } = deps;

  br.command("target [mode]")
    .description("Show the browser; ordinary commands always use the human's Chrome")
    .action(async (mode?: string) => {
      if (hostOwnsBrowser()) {
        if (mode) die("This machine is a remote host with no human's Chrome: every session here uses the host's own Chrome.");
        printHostBrowser();
        return;
      }
      if (!mode) {
        const cur = stickyTarget(me());
        if (cur === "pane") {
          const owned = await ownedDesktopPane(me());
          console.log(`target: ${fmt.highlight("pane")}${fmt.muted(owned ? ` (the desktop app's pane showing ${owned.pane.url ?? "about:blank"})` : " (the desktop app's pane; none is open for this session right now)")}`);
          console.log(fmt.muted("  `cast browser target real` returns this session to the human's Chrome"));
          return;
        }
        console.log(`target: ${fmt.highlight(cur)}${fmt.muted(cur === "real" ? " (the human's Chrome; connection not checked)" : " (advanced command; this invocation only)")}`);
        console.log(fmt.muted("  `cast browser extension status` checks the live connection"));
        return;
      }
      if (mode === "pane") {
        // Sticky whether or not a pane is open yet: the human may open the
        // offer after the agent chose, and the choice should already be made.
        setStickyTarget(me(), "pane");
        const owned = await ownedDesktopPane(me());
        console.log(`${OK} ordinary commands drive the desktop app's pane opened for this session`);
        if (owned) console.log(fmt.muted(`  showing ${owned.pane.url ?? "about:blank"} on the app's CDP port ${owned.registry.port}`));
        else console.log(`${WARN} no pane is open for this session yet — ${PANE_HOW_TO}`);
        return;
      }
      if (mode !== "real") die("Ordinary commands cannot select a separate browser. The human's Chrome is always the default.");
      setStickyTarget(me(), mode);
      console.log(`${OK} ordinary commands use the human's Chrome through the extension`);
      if (mode === "real" && !readBridgeState()?.token) {
        console.log(`${WARN} the bridge is not set up yet — run \`cast browser extension setup\``);
        console.log(`  Install Codecast from ${fmt.highlight(BRIDGE_STORE_URL)} first.`);
      }
    });

  const ext = br
    .command("extension")
    .description("The bridge into the human's real Chrome: setup pairs the extension once, status, revoke");

  // The pairing code is printed only on request. These commands run inside
  // agent sessions whose output syncs off the machine; the code works once
  // and expires in ten minutes, but it is still a key to this Chrome until
  // then.
  ext
    .command("setup")
    .description("Start the bridge host and pair a Chrome profile: opens the extension's options in Chrome with a one-time code filled in. The profile paired last is the one new sessions use")
    .option("--json", "Machine-readable output (does not open Chrome)")
    .option("--show-code", "Print a one-time pairing code and the pairing URL, for entering into the extension by hand")
    .option("--profile <name>", "The Chrome profile to pair and make the default, by name, email or directory (default: the one paired before, else the last used one with the extension)")
    .action(async (o: { json?: boolean; showCode?: boolean; profile?: string }) => {
      const config = ensureBridgeConfig();
      // Which profile gets the pairing. Chrome opens a URL in its last-used
      // profile unless told otherwise, and the extension's page in a profile
      // without the extension is `chrome-extension://invalid`.
      const found = extensionProfiles();
      let chosen: RealProfile | null = null;
      if (o.profile) {
        if (!found.known) die("Chrome's profile list could not be read on this machine, so --profile cannot be matched.");
        const match = matchProfile(found.all, o.profile);
        if (!match) die(`no Chrome profile matches "${o.profile}"`, `profiles: ${found.all.map(describeProfile).join(", ")}`);
        chosen = match;
      } else {
        chosen = pickBridgeProfile(found, config.profile);
      }
      const installedInChosen = !!chosen && found.withExtension.some((p) => p.dir === chosen!.dir);
      if (found.known && !installedInChosen && !o.json) {
        // Nothing to pair with: the extension's page would only be an error.
        // The store page, in the profile that should get it, is the next step.
        const where = chosen ?? found.all.find((p) => p.lastUsed) ?? found.all[0];
        const opened = openInRealChrome(BRIDGE_STORE_URL, where ? [`--profile-directory=${where.dir}`] : []);
        console.log(`${WARN} Codecast is not installed in ${chosen ? `Chrome profile ${describeProfile(chosen)}` : "any Chrome profile"}`);
        console.log(`  ${opened ? "Opened" : "Open"} ${fmt.highlight(BRIDGE_STORE_URL)}${opened && where ? ` in ${describeProfile(where)}` : ""}`);
        console.log(`  Install it in the profile agents should work in, then run ${fmt.highlight(o.profile ? `cast browser extension setup --profile "${o.profile}"` : "cast browser extension setup")} again.`);
        if (found.withExtension.length) console.log(fmt.muted(`  installed in: ${found.withExtension.map(describeProfile).join(", ")}`));
        return;
      }
      let state;
      try {
        state = await ensureBridgeHost();
      } catch (err) {
        die((err as Error).message);
      }
      // Pairing several profiles is fine: each keeps its own key and they
      // all stay connected. What setup pins is the DEFAULT, the profile new
      // sessions open their tabs in. A chosen profile that is already
      // connected only needs that pin.
      const before = await bridgeStatus(state).catch(() => null);
      const live = chosen ? before?.profiles?.find((p) => p.dir === chosen!.dir) : undefined;
      if (live && !o.showCode && !o.json) {
        writeBridgeState({ ...(readBridgeState() ?? state), profile: chosen!.dir });
        console.log(`${OK} ${fmt.highlight(live.id)} is paired and connected; new sessions use it by default`);
        printProfileLines(found, chosen, true);
        return;
      }
      const code = mintPairingCode(chosen ? { dir: chosen.dir, name: chosen.name } : null);
      const url = bridgePairingUrl({ code, port: state.port });
      if (o.json) {
        console.log(JSON.stringify({
          port: state.port, tokenFile: bridgeStatePath(), extensionId: BRIDGE_EXTENSION_ID, storeUrl: BRIDGE_STORE_URL,
          ...(found.known ? { profile: installedInChosen ? chosen!.dir : null, profilesWithExtension: found.withExtension.map((p) => p.dir) } : {}),
          ...(o.showCode ? { code, url, expiresInSeconds: PAIRING_CODE_TTL_MS / 1000 } : {}),
        }));
        return;
      }
      // The extension has a fixed ID, so its options page has a fixed URL:
      // opened with the code in the fragment, the page offers it for one
      // click and the worker exchanges it for this profile's key. Nothing
      // here can see whether Chrome showed that page or an error (the
      // extension is not loaded yet), so the host is asked: the profile
      // connecting is the one proof the pairing worked, and only when it
      // does not arrive do the install steps belong on screen.
      console.log(`${OK} bridge host listening on 127.0.0.1:${state.port}`);
      console.log(`  Chrome extension: ${fmt.highlight(BRIDGE_STORE_URL)}`);
      printProfileLines(found, chosen, true);
      const known = new Set((before?.profiles ?? []).map((p) => `${p.id}:${p.connectedAt}`));
      // The page opened in Chrome also carries the shared token for an extension from before codes (protocol.ts bridgePairingUrl); what is printed never does.
      const opened = !o.showCode && openInRealChrome(bridgePairingUrl({ code, port: state.port, legacyToken: state.token }), chosen ? [`--profile-directory=${chosen.dir}`] : []);
      if (opened) {
        console.log(fmt.muted("  opened the pairing in your Chrome; it asks for one click there. Waiting for the profile to connect…"));
        const paired = await waitForPairedProfile(state, PAIRING_WAIT_MS, (p) => (chosen ? p.dir === chosen.dir : !known.has(`${p.id}:${p.connectedAt}`))).catch((err) => {
          settlePairingPage(false);
          throw err;
        });
        settlePairingPage(!!paired);
        if (paired) {
          if (chosen) writeBridgeState({ ...(readBridgeState() ?? state), profile: chosen.dir });
          console.log(`${OK} paired ${fmt.highlight(paired.id)}${paired.version ? ` (v${paired.version}, protocol ${paired.protocol})` : ""}; new sessions use it by default`);
          console.log(fmt.muted("  sessions use your Chrome by default; no separate browser is started"));
          return;
        }
        console.log(`${WARN} the profile did not connect within ${PAIRING_WAIT_MS / 1000}s`);
      }
      console.log("");
      console.log(opened
        ? "  If Chrome showed an error page instead of the extension's options, install it (one time), or reload it at chrome://extensions if it predates this pairing flow:"
        : o.showCode ? "  Pair by hand:" : "  Install the extension (one time):");
      console.log(`    1. Install Codecast from the Chrome Web Store: ${fmt.highlight(BRIDGE_STORE_URL)}`);
      console.log(`    2. ${chosen ? `Install it in ${describeProfile(chosen)}, the profile this pairs.` : "Use the same Chrome profile you want your agents to work in."} Chrome keeps the extension up to date.`);
      if (o.showCode) {
        console.log(`    3. Open this URL in that Chrome, or open the extension's ${fmt.highlight("options")} and enter the code under "Pair by hand":`);
        console.log(`         ${fmt.highlight(url)}`);
        console.log(`         code   ${fmt.highlight(code)}  (works once, for ${PAIRING_CODE_TTL_MS / 60_000} minutes)`);
        console.log(`         port   ${fmt.highlight(String(state.port))}`);
      } else {
        console.log(`    3. ${opened ? "Run this command again" : "Run this command with --show-code for a one-time code to enter by hand"}`);
      }
      console.log(`    4. Check with ${fmt.highlight("cast browser extension status")}`);
      console.log("");
      console.log(fmt.muted("  A paired profile's key grants full control of that Chrome to local processes that hold the bridge token."));
      console.log(fmt.muted("  Revoke one profile with `cast browser extension revoke --profile <id>`, or everything with `cast browser extension revoke`."));
    });

  ext
    .command("status")
    .description("Is the host up, and is the extension connected")
    .option("--json", "Machine-readable: { paired, connected, chrome_running }")
    .action(async (o: { json?: boolean }) => {
      const state = readBridgeState();
      if (o.json) {
        // Read by the setup card's check (agentToolSetup.ts) on every poll, so
        // it repairs nothing: no Chrome launch, no wake tab.
        let connected = hostBrowserChoice()?.mode === "laptop";
        let detail: string | undefined;
        if (state?.token && !connected) {
          try {
            connected = (await connectRealBridge(undefined, { repair: false })).status.extensionConnected;
          } catch (err) {
            detail = (err as Error).message;
          }
        }
        const paired = !!state?.extensionSeenAt || connected;
        console.log(JSON.stringify({ paired, connected, chrome_running: !!realChromePid(), ...(detail ? { detail } : {}) }));
        return;
      }
      if (printLaptopBrowser()) return;
      if (hostOwnsBrowser()) {
        printHostBrowser();
        return;
      }
      if (!state?.token) {
        console.log(`${fmt.muted(icons.dot)} not set up — \`cast browser extension setup\``);
        console.log(`  Install Codecast from ${fmt.highlight(BRIDGE_STORE_URL)} first.`);
        printSetupCard();
        return;
      }
      // The extension can only prove itself to a running host, so a host that
      // is not running is started and given a moment to be found, the same as
      // for a verb (real.ts connectRealBridge): "host not running" would be a
      // fact about this process, not an answer about the extension.
      // Reports only: a status call never starts Chrome or opens a wake tab.
      // Sessions poll this, and a repair that opens a tab per poll is a
      // regression the human sees; the verbs repair, on their own schedule.
      let bridge;
      let s;
      try {
        ({ bridge, status: s } = await connectRealBridge(undefined, { repair: false }));
      } catch (err) {
        die((err as Error).message);
      }
      console.log(`${OK} host up on 127.0.0.1:${state.port}${bridge.started ? " (started just now; its log is " + bridgeHostLogPath() + ")" : ""}`);
      const unstamped = unstampedHostLine(s, readBridgeState()?.hostPid);
      if (unstamped) console.log(unstamped);
      const chrome = realChromePid();
      console.log(chrome ? `${OK} Chrome running (pid ${chrome})` : `${WARN} Chrome is not running on the default profile`);
      if (s.extensionConnected) {
        console.log(connectedLine(s));
        printConnectedProfiles(s);
        const found = extensionProfiles();
        const chosen = pickBridgeProfile(found, state.profile);
        printProfileLines(found, chosen, !!chosen && chosen.dir === state.profile);
      } else if (state.extensionSeenAt) {
        console.log(`${WARN} extension not connected — it was paired before, so check Chrome is running with the extension enabled (reload it at chrome://extensions), or re-run \`cast browser extension setup\``);
      } else {
        console.log(`${WARN} extension not connected — run \`cast browser extension setup\`; it hands the extension the current token`);
      }
      if (!s.extensionConnected) {
        console.log(`  Install Codecast from ${fmt.highlight(BRIDGE_STORE_URL)} if it is not installed yet.`);
        printSetupCard();
      }
      console.log(fmt.muted(`  CDP endpoint for any engine: ${bridgeWsUrl(bridge).replace(bridge.token, "<token>")} (token in ${bridgeStatePath()})`));
    });

  ext
    .command("reload")
    .description("Reload the extension in Chrome (an unpacked load picks up edited files only on a reload) and wait for it to reconnect — interrupts every session's in-flight browser command; they reattach on their next verb")
    .action(async () => {
      let bridge;
      try {
        ({ bridge } = await connectRealBridge());
      } catch (err) {
        die((err as Error).message);
      }
      try {
        await reloadExtension(bridge);
      } catch (err) {
        die((err as Error).message);
      }
      // The reload drops the socket; give the new worker a moment to be gone
      // before waiting for it back, or the old connection reads as "still up".
      await new Promise((r) => setTimeout(r, 500));
      const s = await waitForExtension(bridge, 15_000);
      if (!s.extensionConnected) die("the extension reloaded but has not reconnected within 15s — check it at chrome://extensions");
      console.log(`${OK} extension reloaded`);
      console.log(connectedLine(s));
    });

  ext
    .command("link")
    .description("Let a cloud host's sessions drive this laptop's Chrome while both are up (the default); --foreground holds the link here until Ctrl-C instead of leaving it to the daemon")
    .requiredOption("--host <id>", "The cloud host (cast hosts ls)")
    .option("--foreground", "Hold the link in this process, ignoring the host's watchdog version")
    .action(async (o: { host: string; foreground?: boolean }) => {
      const { resolveCloudHost, patchHost } = await import("../cloudHost.js");
      const { BrowserLinks, browserLinkRefusal, BROWSER_LINK_TICK_MS } = await import("../../cloud/browserLink.js");
      const host = (() => { try { return resolveCloudHost(o.host); } catch (err) { return die((err as Error).message); } })();
      patchHost(host.id, { laptopBrowser: true });
      const why = browserLinkRefusal({ ...host, laptopBrowser: true }, readBridgeState(), { explicit: o.foreground });
      if (why) die(`no link to ${host.id}: ${why}`);
      if (!o.foreground) {
        console.log(`${OK} ${host.id} will drive this laptop's Chrome while both are up; the daemon opens the link within a minute`);
        return;
      }
      if ((host.watchdogVersion ?? 0) < 4) console.log(`${WARN} ${host.id}'s idle watchdog counts this link as activity: the host stays awake while it is held`);
      const links = new BrowserLinks({ only: host.id, explicit: true, log: (m) => console.log(fmt.muted(`  ${m}`)) });
      const stop = () => { links.closeAll("stopped from the terminal"); setTimeout(() => process.exit(0), 1_500); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await links.tick();
      if (!links.live().length) die(`${host.id} did not answer ssh; nothing was linked`);
      console.log(`${OK} ${host.id} reaches this laptop's Chrome; Ctrl-C ends the link`);
      setInterval(() => { void links.tick(); }, Math.min(BROWSER_LINK_TICK_MS, 15_000));
      await new Promise(() => {});
    });

  ext
    .command("revoke")
    .description("Rotate the token, forget every paired Chrome profile and disconnect them; nothing drives the real Chrome until setup pairs one again. With --profile, cut off one Chrome profile only; with --host, one cloud host")
    .option("--host <id>", "Revoke only this cloud host's token and stop linking it")
    .option("--profile <id>", "Revoke only this Chrome profile's key (`cast browser extension status` lists ids); every other profile keeps working")
    .action(async (o: { host?: string; profile?: string }) => {
      if (o.profile) {
        const hit = findProfile(o.profile);
        if (!hit) {
          const ids = Object.values(readPairing().profiles).map((r) => r.id);
          const s = readBridgeState();
          const legacy = s?.token ? (await connectRealBridge(undefined, { repair: false }).catch(() => null))?.status.profiles?.find((p) => p.legacy && p.id === o.profile) : undefined;
          if (legacy) die(`${o.profile} is still on the machine's shared token (an extension from before per-profile keys), which cannot be revoked alone`, "update the extension and it moves to its own key on its next connect; or `cast browser extension revoke` cuts off every profile");
          die(`no paired Chrome profile "${o.profile}"`, ids.length ? `paired: ${ids.join(", ")}` : "none is paired with its own key yet");
        }
        revokeProfile(hit.key);
        console.log(`${OK} ${fmt.highlight(hit.record.id)} is cut off; its connection closes within seconds and every other profile keeps working`);
        console.log(fmt.muted(`  to pair it again: cast browser extension setup${hit.record.dir ? ` --profile "${hit.record.dir}"` : ""}`));
        return;
      }
      if (o.host) {
        const { patchHost, readHosts } = await import("../cloudHost.js");
        const known = readHosts().some((h) => h.id === o.host);
        const revoked = revokeHostClient(o.host);
        if (known) patchHost(o.host, { laptopBrowser: false });
        if (!known && !revoked) die(`no cloud host ${o.host} holds a token here (cast hosts ls)`);
        console.log(`${OK} ${o.host} is cut off from this laptop's Chrome${revoked ? "; its live connections close within seconds" : ""}`);
        console.log(fmt.muted(`  to re-enable: cast browser extension link --host ${o.host}`));
        return;
      }
      revokeAllProfiles();
      const { stopped } = await rotateAndStopHost();
      console.log(`${OK} token rotated and every profile's key forgotten${stopped ? "; the old host stopped" : ""} — every Chrome profile is cut off`);
      console.log(fmt.muted("  to re-enable: `cast browser extension setup` pairs a profile with a one-time code"));
    });

  // ensureBridgeHost (host.ts) respawns `cast browser bridge-host` detached,
  // so this must exist on whichever driver is registered.
  const chrome = br
    .command("chrome")
    .description("The human's Chrome as a process: restart it with the switches that keep agent tabs and the extension at normal priority and drop the debugging bar, or install a Dock launcher that always passes them");

  chrome
    .command("restart")
    .description(`Quit Chrome gracefully (tabs restore) and start it with ${REAL_CHROME_LAUNCH_ARGS.join(" ")}; the switches last until Chrome next quits`)
    .action(async () => {
      const r = await restartRealChrome({ note: (line) => console.log(fmt.muted(`  ${line}`)) });
      if (!r.restarted) die(r.reason ?? "Chrome did not restart");
      console.log(`${OK} Chrome restarted (pid ${r.pid}) with ${REAL_CHROME_LAUNCH_ARGS.join(" ")}`);
      console.log(fmt.muted("  the extension reconnects on its own; `cast browser extension status` shows it"));
    });

  chrome
    .command("launcher")
    .description(`Install "${CHROME_LAUNCHER_NAME}.app" in ~/Applications: opens Chrome with the switches, for the Dock`)
    .action(() => {
      const r = installChromeLauncher();
      console.log(`${OK} installed ${r.app}${r.iconCopied ? "" : " (Chrome's icon was not found; the launcher has none)"}`);
      console.log(fmt.muted("  drag it to the Dock in place of Chrome; it opens the real Chrome with the switches when Chrome is not running"));
    });

  br.command("bridge-host", { hidden: true })
    .description("Run the bridge host in the foreground (internal; auto-started detached)")
    .action(async () => {
      await runBridgeHost();
    });
}
