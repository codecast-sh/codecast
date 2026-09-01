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
import {
  bridgeStatus, bridgeWsUrl, ensureBridgeConfig, ensureBridgeHost, isHostAlive, readBridgeState,
  rotateBridgeToken, runBridgeHost, stopBridgeHost,
} from "./host.js";
import { setStickyTarget, stickyTarget } from "./real.js";

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

/** The two flags every drivable command takes. --clone overrides a sticky real. */
export function targetFlags(cmd: Command): Command {
  return cmd
    .option("--real", "Act on your real Chrome through the cast bridge extension")
    .option("--clone", "Act on the managed cloned browser (overrides `target real`)");
}

export function registerBridgeCommands(br: Command, deps: BridgeCommandDeps): void {
  const { me } = deps;

  br.command("target [mode]")
    .description("Default browser for verbs: clone (managed copy) or real (your Chrome via the extension)")
    .action(async (mode?: string) => {
      if (!mode) {
        const cur = stickyTarget(me());
        console.log(`target: ${fmt.highlight(cur)}${cur === "clone" ? fmt.muted(" (default)") : ""}`);
        console.log(fmt.muted("  change with `cast browser target real|clone`; any command takes --real/--clone to override"));
        return;
      }
      if (mode !== "real" && mode !== "clone") die(`unknown target '${mode}'`, "use `real` or `clone`");
      setStickyTarget(me(), mode);
      console.log(`${OK} verbs now act on the ${mode === "real" ? "real Chrome (extension bridge)" : "managed clone"}${me() ? " for this session" : ""}`);
      if (mode === "real" && !readBridgeState()?.token) {
        console.log(`${WARN} the bridge is not set up yet — run \`cast browser extension setup\``);
      }
    });

  const ext = br
    .command("extension")
    .description("The bridge into your real Chrome: setup, status, revoke");

  ext
    .command("setup")
    .description("Start the bridge host and print the token to paste into the extension")
    .option("--json", "Machine-readable output")
    .action(async (o: { json?: boolean }) => {
      ensureBridgeConfig();
      let state;
      try {
        state = await ensureBridgeHost();
      } catch (err) {
        die((err as Error).message);
      }
      if (o.json) {
        console.log(JSON.stringify({ port: state.port, token: state.token }));
        return;
      }
      console.log(`${OK} bridge host listening on 127.0.0.1:${state.port}`);
      console.log("");
      console.log("  Install the extension (one time):");
      console.log(`    1. Open ${fmt.highlight("chrome://extensions")} in your real Chrome, turn on Developer mode`);
      console.log(`    2. ${fmt.highlight("Load unpacked")} → select the repo's ${fmt.highlight("packages/browser-extension")} directory`);
      console.log(`    3. Open the extension's ${fmt.highlight("options")} and paste:`);
      console.log(`         token  ${fmt.highlight(state.token)}`);
      console.log(`         port   ${fmt.highlight(String(state.port))}`);
      console.log(`    4. Check with ${fmt.highlight("cast browser extension status")}`);
      console.log("");
      console.log(fmt.muted("  The token grants full control of that Chrome to local processes that hold it."));
      console.log(fmt.muted("  Revoke any time with `cast browser extension revoke`."));
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
      if (!(await isHostAlive(state.port))) {
        console.log(`${WARN} bridge host is not running on 127.0.0.1:${state.port} (it auto-starts on first use)`);
        return;
      }
      let s;
      try {
        s = await bridgeStatus(state);
      } catch (err) {
        die((err as Error).message);
      }
      console.log(`${OK} host up on 127.0.0.1:${state.port}`);
      if (s.extensionConnected) {
        console.log(`${OK} extension connected${s.extensionVersion ? ` (v${s.extensionVersion}, protocol ${s.extensionProtocol})` : ""}`);
      } else {
        console.log(`${WARN} extension not connected — open its options in Chrome and check token/port`);
      }
      console.log(fmt.muted(`  CDP endpoint for any engine: ${bridgeWsUrl(state)}`));
    });

  ext
    .command("revoke")
    .description("Rotate the token and disconnect the extension — nothing can drive the real Chrome until the new token is pasted")
    .action(async () => {
      const next = rotateBridgeToken();
      const stopped = stopBridgeHost();
      if (stopped) {
        // Give the old host a beat to free the port before the next auto-start.
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline && (await isHostAlive(next.port, 300))) {
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      console.log(`${OK} token rotated${stopped ? " and the old host stopped" : ""} — the extension is cut off`);
      console.log(fmt.muted("  to re-enable: `cast browser extension setup`, then paste the new token in the extension's options"));
    });

  // ensureBridgeHost (host.ts) respawns `cast browser bridge-host` detached,
  // so this must exist on whichever driver is registered.
  br.command("bridge-host", { hidden: true })
    .description("Run the bridge host in the foreground (internal; auto-started detached)")
    .action(async () => {
      await runBridgeHost();
    });
}
