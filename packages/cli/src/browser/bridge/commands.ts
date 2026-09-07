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
import { fmt, icons } from "../../colors.js";
import { spawn } from "../../proc.js";
import {
  bridgeHostLogPath, bridgeStatePath, bridgeWsUrl, ensureBridgeConfig, ensureBridgeHost, probeHost, readBridgeState,
  rotateBridgeToken, runBridgeHost, stopBridgeHost, waitForExtension, type BridgeHostStatus,
} from "./host.js";
import { bridgePairingUrl } from "./protocol.js";
import { connectRealBridge, explicitTarget, extensionReady, setStickyTarget, stickyTarget } from "./real.js";

const OK = `${fmt.success(icons.check)}`;
const BAD = `${fmt.error(icons.cross)}`;
const WARN = `${fmt.warning("!")}`;

function die(msg: string, hint?: string): never {
  console.error(`${BAD} ${msg}`);
  if (hint) console.error(`  ${fmt.muted(hint)}`);
  process.exit(1);
}

/**
 * Hand a URL to the human's Chrome without waiting for it. Only macOS has a
 * launcher that targets an app by name; elsewhere the caller prints the URL.
 * The URL carries the pairing token, so it goes to osascript on stdin, never
 * in an argument: on macOS every user can read every other user's process
 * arguments. osascript exits as soon as Chrome has the request, so a missing
 * Chrome (or a denied automation prompt) surfaces nowhere but the printed
 * fallback, which is why the fallback is always printed.
 */
export function openInChrome(url: string, app = "Google Chrome"): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const child = spawn("osascript", ["-"], { stdio: ["pipe", "ignore", "ignore"], detached: true });
    child.on("error", () => {});
    const quote = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
    child.stdin?.end(`tell application ${quote(app)} to open location ${quote(url)}\n`);
    child.unref();
    return !!child.pid;
  } catch {
    return false;
  }
}

export interface BridgeCommandDeps {
  /** The calling codecast session's owner key; sticky targets are per session. */
  me: () => string | null;
}

/** The two flags every drivable command takes. --clone overrides a sticky real. */
export function targetFlags(cmd: Command): Command {
  return cmd
    .option("--real", "Act on your real Chrome through the cast bridge extension")
    .option("--clone", "Act on the agent browser (overrides `target real`)");
}

/** One line for a connected extension, the same wherever it is reported. */
function connectedLine(s: BridgeHostStatus): string {
  return `${OK} extension connected${s.extensionVersion ? ` (v${s.extensionVersion}, protocol ${s.extensionProtocol})` : ""}`;
}

/** How long `setup` waits for the extension after handing Chrome the pairing URL. */
const PAIRING_WAIT_MS = 10_000;

export function registerBridgeCommands(br: Command, deps: BridgeCommandDeps): void {
  const { me } = deps;

  br.command("target [mode]")
    .description("Which browser the verbs act on: clone (the agent browser, default) or real (the human's own Chrome through the extension; a session acts only on tabs it opened)")
    .action(async (mode?: string) => {
      if (!mode) {
        const cur = stickyTarget(me());
        const why = explicitTarget(me())
          ? " (chosen for this session)"
          : extensionReady()
            ? " (default: the codecast extension is connected, so sessions use your Chrome)"
            : " (default: the codecast extension is not connected, so sessions use the agent browser)";
        console.log(`target: ${fmt.highlight(cur)}${fmt.muted(why)}`);
        console.log(fmt.muted("  change with `cast browser target real|clone`; any command takes --real/--clone to override"));
        return;
      }
      if (mode !== "real" && mode !== "clone") die(`unknown target '${mode}'`, "use `real` or `clone`");
      setStickyTarget(me(), mode);
      console.log(`${OK} verbs now act on the ${mode === "real" ? "real Chrome (extension bridge)" : "agent browser"}${me() ? " for this session" : ""}`);
      if (mode === "real" && !readBridgeState()?.token) {
        console.log(`${WARN} the bridge is not set up yet — run \`cast browser extension setup\``);
      }
    });

  const ext = br
    .command("extension")
    .description("The bridge into the human's real Chrome: setup pairs the extension once, status, revoke");

  // The token is printed only on request. These commands run inside agent
  // sessions whose output syncs off the machine, and the redactor cannot
  // tell a bridge token from any other hex; the pairing URL carries it too.
  ext
    .command("setup")
    .description("Start the bridge host and hand the extension its token: opens the extension's options in Chrome with the token filled in")
    .option("--json", "Machine-readable output (does not open Chrome)")
    .option("--show-token", "Print the token and the pairing URL, for entering into the extension by hand")
    .action(async (o: { json?: boolean; showToken?: boolean }) => {
      ensureBridgeConfig();
      let state;
      try {
        state = await ensureBridgeHost();
      } catch (err) {
        die((err as Error).message);
      }
      const url = bridgePairingUrl(state);
      const secret = o.showToken ? { token: state.token, url } : {};
      if (o.json) {
        console.log(JSON.stringify({ port: state.port, tokenFile: bridgeStatePath(), ...secret }));
        return;
      }
      // The extension has a fixed ID, so its options page has a fixed URL:
      // opened with the token in the fragment, the page saves it and
      // connects. Nothing here can see whether Chrome showed that page or an
      // error (the extension is not loaded yet), so the host is asked: the
      // extension connecting is the one proof the pairing worked, and only
      // when it does not arrive do the install steps belong on screen.
      console.log(`${OK} bridge host listening on 127.0.0.1:${state.port}`);
      const opened = openInChrome(url);
      if (opened) {
        console.log(fmt.muted("  handed the pairing to Chrome, waiting for the extension to connect…"));
        const status = await waitForExtension(state, PAIRING_WAIT_MS);
        if (status.extensionConnected) {
          console.log(connectedLine(status));
          console.log(fmt.muted("  sessions on this machine now use your Chrome by default; `cast browser target clone` opts one out"));
          return;
        }
        console.log(`${WARN} the extension did not connect within ${PAIRING_WAIT_MS / 1000}s`);
      }
      console.log("");
      console.log(opened
        ? "  If Chrome showed an error page instead of the extension's options, install it (one time):"
        : "  Install the extension (one time):");
      console.log(`    1. Open ${fmt.highlight("chrome://extensions")} in your real Chrome, turn on Developer mode`);
      console.log(`    2. ${fmt.highlight("Load unpacked")} → select the repo's ${fmt.highlight("packages/browser-extension")} directory`);
      if (o.showToken) {
        console.log(`    3. ${opened ? "Run this command again, or open" : "Open"} this URL in that Chrome:`);
        console.log(`         ${fmt.highlight(url)}`);
        console.log(`       or open the extension's ${fmt.highlight("options")} and enter:`);
        console.log(`         token  ${fmt.highlight(state.token)}`);
        console.log(`         port   ${fmt.highlight(String(state.port))}`);
      } else {
        console.log(`    3. ${opened ? "Run this command again" : "Run this command with --show-token for the pairing URL"}`);
        console.log(`       ${fmt.muted(`the token lives in ${bridgeStatePath()}; --show-token prints it for entering by hand`)}`);
      }
      console.log(`    4. Check with ${fmt.highlight("cast browser extension status")}`);
      console.log("");
      console.log(fmt.muted("  The token grants full control of that Chrome to local processes that hold it."));
      console.log(fmt.muted("  Revoke any time with `cast browser extension revoke`; it rotates the token."));
    });

  ext
    .command("status")
    .description("Is the host up, and is the extension connected")
    .action(async () => {
      const state = readBridgeState();
      if (!state?.token) {
        console.log(`${fmt.muted(icons.dot)} not set up — \`cast browser extension setup\``);
        return;
      }
      // The extension can only prove itself to a running host, so a host that
      // is not running is started and given a moment to be found, the same as
      // for a verb (real.ts connectRealBridge): "host not running" would be a
      // fact about this process, not an answer about the extension.
      let bridge;
      let s;
      try {
        ({ bridge, status: s } = await connectRealBridge());
      } catch (err) {
        die((err as Error).message);
      }
      console.log(`${OK} host up on 127.0.0.1:${state.port}${bridge.started ? " (started just now; its log is " + bridgeHostLogPath() + ")" : ""}`);
      if (s.extensionConnected) {
        console.log(connectedLine(s));
      } else if (state.extensionSeenAt) {
        console.log(`${WARN} extension not connected — it was paired before, so check Chrome is running with the extension enabled (reload it at chrome://extensions), or re-run \`cast browser extension setup\``);
      } else {
        console.log(`${WARN} extension not connected — run \`cast browser extension setup\`; it hands the extension the current token`);
      }
      console.log(fmt.muted(`  CDP endpoint for any engine: ${bridgeWsUrl(bridge).replace(bridge.token, "<token>")} (token in ${bridgeStatePath()})`));
    });

  ext
    .command("revoke")
    .description("Rotate the token and disconnect the extension; nothing drives the real Chrome until setup hands it the new token")
    .action(async () => {
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
      console.log(`${OK} token rotated${stopped ? " and the old host stopped" : ""} — the extension is cut off`);
      console.log(fmt.muted("  to re-enable: `cast browser extension setup` hands the extension the new token"));
    });

  // ensureBridgeHost (host.ts) respawns `cast browser bridge-host` detached,
  // so this must exist on whichever driver is registered.
  br.command("bridge-host", { hidden: true })
    .description("Run the bridge host in the foreground (internal; auto-started detached)")
    .action(async () => {
      await runBridgeHost();
    });
}
