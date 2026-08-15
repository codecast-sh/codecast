/**
 * `cast browser` on top of the agent-browser engine.
 *
 * The shape here is deliberately thin. Almost every verb is a passthrough: we
 * apply codecast's session and profile, hand the rest of the command line
 * straight to the engine, and print what it prints. That buys the engine's
 * whole surface — fifty-odd verbs including React introspection, Web Vitals,
 * HAR capture, accessibility audits and video — without us restating any of it,
 * and without a translation layer to drift out of date.
 *
 * Only three things are genuinely ours, and they are the reason this wrapper
 * exists rather than telling agents to run agent-browser directly:
 *
 *   - **Screenshots land in the conversation.** `shot` writes the file, then
 *     prints the marker the transcript parser turns into an inline image. No
 *     third-party tool can do this; it is the whole reason a human sees what
 *     the agent saw.
 *   - **The profile is codecast's.** Agents inherit the human's logins from a
 *     read-only copy of their real Chrome profile, chosen once and remembered.
 *   - **Sessions are codecast sessions.** Each agent drives an isolated browser
 *     session keyed to its codecast session, so parallel agents cannot navigate
 *     or close each other's tabs.
 *
 * Verb names stay ours even where the engine's differ (`shot`, not
 * `screenshot`; `do`, not `batch`), because those names are already written
 * into every CLAUDE.md on the machine. The mapping is one table below.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import {
  ENGINE_PACKAGE, engineSession, engineVersion, ensureEngine, findEngine, runEngine,
} from "./engine.js";
import { browserHome, formatBytes, listRealProfiles } from "./profile.js";
import { inlineImageMarker } from "../inlineImage.js";
import { uploadOne } from "../imageCommand.js";
import { MAX_IMAGE_SIZE } from "../syncService.js";
import type { PublishDeps } from "../publish.js";
import { fmt, icons } from "../colors.js";

const OK = `${fmt.success(icons.check)}`;
const BAD = `${fmt.error(icons.cross)}`;

function die(msg: string, hint?: string): never {
  console.error(`${BAD} ${msg}`);
  if (hint) console.error(`  ${fmt.muted(hint)}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Which Chrome profile agents inherit logins from
// ---------------------------------------------------------------------------

function profileConfigPath(): string {
  return path.join(browserHome(), "profile.json");
}

/**
 * The Chrome profile agents drive under.
 *
 * Remembered rather than asked for every time, and defaulting to the one the
 * human used last — an agent that opens a page should already be signed in to
 * whatever they are signed in to, without being told which profile that is.
 */
export function currentProfile(): string | null {
  try {
    return JSON.parse(fs.readFileSync(profileConfigPath(), "utf-8")).profile ?? null;
  } catch {
    return listRealProfiles().find((p) => p.lastUsed)?.dir ?? null;
  }
}

export function setProfile(dir: string | null): void {
  fs.mkdirSync(browserHome(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(profileConfigPath(), JSON.stringify({ profile: dir }, null, 2), { mode: 0o600 });
}

/** Options every engine call carries: this session, and the chosen profile. */
function ctx(): { session: string; profile: string | null } {
  return { session: engineSession(), profile: currentProfile() };
}

// ---------------------------------------------------------------------------
// Passthrough verbs
// ---------------------------------------------------------------------------

/**
 * Our verb → the engine's verb, for the handful that differ, plus a one-line
 * description so `cast browser --help` still reads like our tool. Anything not
 * listed is still reachable: `cast browser raw <args…>`.
 */
const PASSTHROUGH: Array<{ verb: string; engine?: string; args: string; desc: string }> = [
  { verb: "open", args: "[args...]", desc: "Navigate to a URL" },
  { verb: "snapshot", args: "[args...]", desc: "The page as an accessibility tree with refs to act on" },
  { verb: "click", args: "[args...]", desc: "Click an element (@ref or selector)" },
  { verb: "type", args: "[args...]", desc: "Type into an element" },
  { verb: "fill", args: "[args...]", desc: "Clear a field and fill it" },
  { verb: "press", args: "[args...]", desc: 'Press a key ("Enter", "Control+a")' },
  { verb: "hover", args: "[args...]", desc: "Hover an element, revealing menus" },
  { verb: "focus", args: "[args...]", desc: "Focus an element without clicking" },
  { verb: "select", args: "[args...]", desc: "Choose an option in a dropdown" },
  { verb: "scroll", args: "[args...]", desc: "Scroll the page (up/down/left/right)" },
  { verb: "upload", args: "[args...]", desc: "Attach files to a file input" },
  { verb: "download", args: "[args...]", desc: "Download a file by clicking an element" },
  { verb: "drag", args: "[args...]", desc: "Drag one element onto another" },
  { verb: "wait", args: "[args...]", desc: "Wait for an element, or a number of ms" },
  { verb: "eval", args: "[args...]", desc: "Run JavaScript in the page" },
  { verb: "text", engine: "read", args: "[args...]", desc: "The page's visible text, for reading" },
  { verb: "get", args: "[args...]", desc: "Read text, html, value, attr, box or styles" },
  { verb: "back", args: "[args...]", desc: "Go back in history" },
  { verb: "forward", args: "[args...]", desc: "Go forward in history" },
  { verb: "reload", args: "[args...]", desc: "Reload the page" },
  { verb: "do", engine: "batch", args: "[args...]", desc: "Run several steps in one invocation" },
  { verb: "tab", args: "[args...]", desc: "Tabs: list, new, close, switch" },
  { verb: "console", args: "[args...]", desc: "What the page logged" },
  { verb: "errors", args: "[args...]", desc: "Uncaught errors on the page" },
  { verb: "network", args: "[args...]", desc: "Requests, routing and HAR capture" },
  { verb: "cookies", args: "[args...]", desc: "Read and write cookies" },
  { verb: "storage", args: "[args...]", desc: "Local and session storage" },
  { verb: "inspect", args: "[args...]", desc: "Inspect an element in detail" },
  { verb: "react", args: "[args...]", desc: "React tree, renders and Suspense boundaries" },
  { verb: "vitals", args: "[args...]", desc: "Web Vitals for the current page" },
  { verb: "a11y", args: "[args...]", desc: "Accessibility audit (axe-core)" },
  { verb: "trace", args: "[args...]", desc: "Record a DevTools trace" },
  { verb: "record", args: "[args...]", desc: "Record video of the session" },
  { verb: "skills", args: "[args...]", desc: "The engine's own usage guides" },
];

/** Our preset sizes, kept so the names in CLAUDE.md keep meaning the same
 *  thing regardless of which engine is driving. */
const VIEWPORTS: Record<string, [number, number]> = {
  desktop: [1440, 900],
  laptop: [1280, 800],
  wide: [1920, 1080],
  tablet: [820, 1180],
  mobile: [390, 844],
  "mobile-small": [320, 568],
};
const MOBILE_PRESETS = new Set(["tablet", "mobile", "mobile-small"]);

/** Forward a command line to the engine and exit with its status. */
function passthrough(engineVerb: string, args: string[]): never {
  const { session, profile } = ctx();
  const res = runEngine([engineVerb, ...args], { session, profile, inherit: true });
  process.exit(res.status);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerEngineCommands(br: Command, deps: PublishDeps): void {
  for (const p of PASSTHROUGH) {
    br.command(`${p.verb} ${p.args}`)
      .description(p.desc)
      .allowUnknownOption(true)
      .helpOption(false)
      .action((args: string[] = []) => passthrough(p.engine ?? p.verb, args));
  }

  // Escape hatch: the engine gains verbs faster than this table does, and an
  // agent should never be blocked because we have not listed one yet.
  br.command("raw [args...]")
    .description("Pass a command straight to the browser engine")
    .allowUnknownOption(true)
    .helpOption(false)
    .action((args: string[] = []) => {
      if (!args.length) die("raw needs a command", "e.g. cast browser raw profiler start");
      passthrough(args[0], args.slice(1));
    });

  // -------------------------------------------------------------- screenshots

  br.command("shot [pathArg]")
    .description("Screenshot the page — appears inline in this conversation")
    .option("--full", "Whole scroll height, not just the viewport")
    .option("--share", "Also upload it and print a link you can paste elsewhere")
    .option("--alt <text>", "Caption for the shared image — say what it shows")
    .option("--no-inline", "Do not show the image in the conversation")
    .allowUnknownOption(true)
    .action(async (pathArg: string | undefined, o: any, cmd: any) => {
      const out = pathArg ?? path.join(os.tmpdir(), `cast-shot-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(out), { recursive: true });

      const extra: string[] = [];
      if (o.full) extra.push("--full-page");
      // Anything we do not recognise belongs to the engine, not to us.
      for (const a of cmd.args ?? []) if (typeof a === "string" && a.startsWith("--")) extra.push(a);

      const { session, profile } = ctx();
      const res = runEngine(["screenshot", out, ...extra], { session, profile });
      if (res.status !== 0) {
        die((res.stderr || res.stdout).trim().split("\n")[0] || "the screenshot failed");
      }
      if (!fs.existsSync(out)) die(`the engine reported success but wrote no file at ${out}`);

      const bytes = fs.statSync(out).size;
      console.log(`${OK} ${out} (${formatBytes(bytes)})`);

      // The codecast-specific half: put the picture in the conversation, under
      // the command that took it, the way an extension screenshot appears.
      if (o.inline !== false && bytes <= MAX_IMAGE_SIZE) {
        console.log(inlineImageMarker(path.resolve(out)));
      } else if (o.inline !== false) {
        console.log(
          fmt.muted(`  (too large to show inline at ${formatBytes(bytes)} — pass --share for a link)`),
        );
      }

      if (o.share) {
        const img = await uploadOne(deps, out, o.alt || "screenshot");
        console.log(img.markdown);
      }
    });

  // ------------------------------------------------------- compatibility verbs
  //
  // These four are in every CLAUDE.md already installed on every machine, so
  // they have to keep working whichever engine is driving. The engine spells
  // some of them differently and does not have `find` at all; that is our
  // problem to absorb, not something to push onto agents by rewriting prose
  // they have already read into their context.

  br.command("tabs")
    .description("List open tabs")
    .action(() => passthrough("tab", ["list"]));

  br.command("find <text>")
    .description("Find elements whose visible name matches")
    .action((text: string) => {
      // The engine has no `find`. A snapshot already carries every ref with its
      // accessible name, so matching here costs one call and keeps the verb.
      const { session, profile } = ctx();
      const res = runEngine(["snapshot"], { session, profile });
      if (res.status !== 0) die((res.stderr || res.stdout).trim().split("\n")[0] || "could not read the page");
      const q = text.toLowerCase();
      const lines = res.stdout.split("\n").filter((l) => l.includes("[ref="));
      // Exact name first: "Save" must not be ambiguous just because "Save
      // draft" also contains it.
      const named = (l: string) => (l.match(/"([^"]*)"/) ?? [, ""])[1]!.toLowerCase();
      const exact = lines.filter((l) => named(l) === q);
      const hits = exact.length ? exact : lines.filter((l) => l.toLowerCase().includes(q));
      if (!hits.length) {
        console.log(`no element matching ${JSON.stringify(text)} (${lines.length} refs on the page)`);
        process.exit(1);
      }
      for (const h of hits.slice(0, 25)) console.log(h.trim());
      if (hits.length > 25) console.log(fmt.muted(`  … and ${hits.length - 25} more`));
    });

  br.command("viewport [size]")
    .description("Resize the page, or emulate a device: desktop, laptop, wide, tablet, mobile, mobile-small")
    .option("--reset", "Back to the default size")
    .action((size: string | undefined, o: { reset?: boolean }) => {
      const { session, profile } = ctx();
      if (o.reset || size === "reset") {
        runEngine(["set", "viewport", "1440", "900"], { session, profile });
        return console.log(`${OK} viewport reset`);
      }
      if (!size) {
        const res = runEngine(["eval", "JSON.stringify([innerWidth,innerHeight,devicePixelRatio])"], { session, profile });
        console.log(res.stdout.trim());
        console.log(fmt.muted(`  presets: ${Object.keys(VIEWPORTS).join(", ")}  ·  or a size like 1024x768`));
        return;
      }
      const preset = VIEWPORTS[size];
      const explicit = /^(\d+)x(\d+)$/.exec(size);
      if (!preset && !explicit) {
        die(`unknown size '${size}'`, `use a preset (${Object.keys(VIEWPORTS).join(", ")}) or WxH like 1024x768`);
      }
      const [w, h] = preset ?? [parseInt(explicit![1], 10), parseInt(explicit![2], 10)];
      const res = runEngine(["set", "viewport", String(w), String(h)], { session, profile });
      if (res.status !== 0) die((res.stderr || res.stdout).trim().split("\n")[0] || "could not resize");
      console.log(`${OK} ${size} — ${w}x${h}`);
      if (preset && MOBILE_PRESETS.has(size)) {
        // Say it plainly: a "mobile" page that is secretly non-touch can show a
        // hover menu no real phone would ever render.
        console.log(fmt.muted("  (size only — touch is not emulated, so hover-only menus still open)"));
      }
    });

  br.command("dialogs")
    .description("Modal dialogs the page tried to open")
    .action(() => {
      console.log(
        fmt.muted("alert / confirm / beforeunload are dismissed automatically, so a dialog cannot freeze the tab.\n") +
          fmt.muted("Anything the page logged around one shows in `cast browser console`."),
      );
    });

  // ---------------------------------------------------------------- lifecycle

  br.command("start")
    .description("Get the browser ready (installs the engine on first use)")
    .option("--profile <dir>", "Chrome profile to inherit logins from")
    .option("--fresh", "Start signed out of everything")
    .option("--headless", "Run without a visible window")
    .action((o: { profile?: string; fresh?: boolean; headless?: boolean }) => {
      let install;
      try {
        install = ensureEngine();
      } catch (err) {
        die((err as Error).message);
      }
      if (install.installed) console.log(`${OK} browser engine installed (${ENGINE_PACKAGE})`);

      if (o.fresh) {
        setProfile(null);
        console.log(`${OK} using a fresh profile — signed out of everything`);
      } else if (o.profile) {
        const known = listRealProfiles().find((p) => p.dir === o.profile);
        setProfile(o.profile);
        console.log(`${OK} using ${fmt.highlight(known?.name ?? o.profile)}${known?.email ? fmt.muted(` <${known.email}>`) : ""}`);
      }

      const { session, profile } = ctx();
      const res = runEngine(["open", "about:blank"], { session, profile, headless: o.headless });
      if (res.status !== 0) {
        die((res.stderr || res.stdout).trim().split("\n")[0] || "the browser did not start");
      }
      console.log(`${OK} browser ready — session ${fmt.muted(session)}`);
      if (profile) {
        console.log(
          fmt.muted("  It reads a COPY of your Chrome profile, so it is signed in to what you are signed in to,\n") +
            fmt.muted("  and never writes to your real browser. `cast browser start --fresh` gives a signed-out one."),
        );
      }
      console.log(fmt.muted("  next: cast browser open <url>"));
    });

  br.command("status")
    .description("What the browser is doing")
    .action(() => {
      const binary = findEngine();
      if (!binary) {
        console.log(`${fmt.muted(icons.dot)} not set up yet — run \`cast browser start\``);
        return;
      }
      const { session, profile } = ctx();
      console.log(`${OK} engine ${ENGINE_PACKAGE} ${engineVersion() ?? "?"}  ${fmt.muted(binary)}`);
      console.log(`  session: ${session}`);
      console.log(`  profile: ${profile ? `${profile} (logins inherited)` : "fresh — signed out"}`);
      const res = runEngine(["tab", "list"], { session, profile });
      if (res.status === 0 && res.stdout.trim()) {
        console.log(`  tabs:`);
        for (const line of res.stdout.trim().split("\n")) console.log(`    ${line}`);
      }
    });

  br.command("stop")
    .description("Close this session's browser")
    .option("--all", "Close every session's browser, including other agents'")
    .action((o: { all?: boolean }) => {
      const { session, profile } = ctx();
      const res = runEngine(["close", ...(o.all ? ["--all"] : [])], { session, profile });
      console.log(
        res.status === 0
          ? `${OK} ${o.all ? "closed every session" : "closed this session's browser"}`
          : `${BAD} ${(res.stderr || res.stdout).trim().split("\n")[0]}`,
      );
    });

  br.command("profiles")
    .description("Chrome profiles on this machine, and which one agents use")
    .action(() => {
      const profiles = listRealProfiles();
      if (!profiles.length) die("no Chrome profiles found on this machine");
      const active = currentProfile();
      for (const p of profiles) {
        const mark = p.dir === active ? fmt.success("*") : " ";
        const tag = p.lastUsed ? fmt.muted(" (you used this last)") : "";
        console.log(`${mark} ${p.dir.padEnd(12)} ${fmt.highlight(p.name)}${p.email ? fmt.muted(` <${p.email}>`) : ""}${tag}`);
      }
      console.log(fmt.muted(`\n  * = what agents use. Change it with: cast browser start --profile "<dir>"`));
    });
}
