/**
 * `cast browser` — drive a real Chrome from the command line.
 *
 * Why a CLI and not an MCP server: codecast agents run under four different
 * harnesses (Claude Code, Codex, Cursor, opencode) and the one thing all of
 * them have is a shell. A CLI verb works everywhere the moment the snippet
 * lands in CLAUDE.md, with no per-harness server configuration, and it composes
 * with the rest of `cast`.
 *
 * The process model that follows from that: every invocation is a new process
 * that re-attaches to a browser which outlives it. Nothing may be held in
 * memory between calls — the tab pointer lives in a state file, and the console
 * recorder lives inside the page.
 *
 * Output is written for a reader who has one screen of context: each action
 * reports what it did and what changed, so an agent does not have to spend a
 * second call asking.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import { CdpConnection, listTargets, type CdpTarget } from "./cdp.js";
import {
  attachToTarget, clearState, freePort, isLive, killStrayChrome, launchManagedChrome,
  readState, resolveTarget, setActiveTarget, settle, stopInstance, writeState,
  type InstanceState, type PageSession,
} from "./instance.js";
import {
  browserHome, clonePath, cloneProfile, formatBytes, listRealProfiles, type ChromeChannel,
} from "./profile.js";
import { matchRefs, snapshotPage } from "./snapshot.js";
import {
  click, clickAt, evaluate, focus, hover, locate, pressKey, screenshot,
  scroll, selectOption, type, uploadFiles,
} from "./actions.js";
import { armRecorder, clearRecording, readRecording } from "./observe.js";
import { uploadOne } from "../imageCommand.js";
import type { PublishDeps } from "../publish.js";
import { fmt, icons } from "../colors.js";

// colors.ts exposes semantic helpers, not raw colour names.
const OK = `${fmt.success(icons.check)}`;
const BAD = `${fmt.error(icons.cross)}`;
const WARN = `${fmt.warning("!")}`;

const DEFAULT_CLONE = "default";

function die(msg: string, hint?: string): never {
  console.error(`${BAD} ${msg}`);
  if (hint) console.error(`  ${fmt.muted(hint)}`);
  process.exit(1);
}

/** Every acting command needs a live browser and an attached tab. */
async function withPage<T>(
  opts: { tab?: string },
  fn: (page: PageSession, state: InstanceState, conn: CdpConnection) => Promise<T>,
): Promise<T> {
  const state = readState();
  if (!(await isLive(state))) {
    die(
      "no managed browser is running",
      "start one with `cast browser start` (it clones your Chrome profile, so you stay logged in)",
    );
  }
  const s = state!;
  const conn = await CdpConnection.fromPort(s.port);
  try {
    const target = await resolveTarget(s.port, s, opts.tab);
    const page = await attachToTarget(conn, target.targetId);
    setActiveTarget(s, target.targetId);
    // Re-arm every time: the previous process's registration died with its
    // session, so without this any navigation this command triggers would land
    // on a page with no console capture at all.
    await armRecorder(page);
    return await fn(page, s, conn);
  } catch (err) {
    // A stack trace tells an agent nothing it can act on; the message does.
    die((err as Error).message);
  } finally {
    conn.close();
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function describeTab(t: CdpTarget, active: boolean): string {
  const mark = active ? fmt.success("*") : " ";
  return `${mark} ${fmt.muted(shortId(t.targetId))}  ${(t.title || "(untitled)").slice(0, 50).padEnd(50)} ${fmt.muted(t.url.slice(0, 70))}`;
}

/** Print the page header every action shares, so the agent always knows where it is. */
function pageLine(url: string, title: string): string {
  return `${fmt.highlight(title || "(untitled)")}\n${fmt.muted(url)}`;
}

/**
 * `onReady` is called the first time a browser comes up on this machine. It is
 * how the CLAUDE.md section gets written: an agent cannot use a command it has
 * never been told about, and asking the human to run a separate install step
 * for something they have already started is a step that will be skipped.
 */
export function registerBrowserCommand(
  program: Command,
  deps: PublishDeps,
  onReady: () => void = () => {},
): void {
  const br = program
    .command("browser")
    .alias("br")
    .description("Drive a real Chrome: snapshot pages, click, type, screenshot, read console");

  // ---------------------------------------------------------------- lifecycle

  br.command("profiles")
    .description("List the Chrome profiles on this machine")
    .option("--channel <name>", "chrome | canary | chromium", "chrome")
    .action((o: { channel: ChromeChannel }) => {
      const profiles = listRealProfiles(o.channel);
      if (!profiles.length) die(`no Chrome profiles found for channel '${o.channel}'`);
      for (const p of profiles) {
        const tag = p.lastUsed ? fmt.success(" (last used)") : "";
        console.log(`  ${p.dir.padEnd(12)} ${fmt.highlight(p.name)}${p.email ? fmt.muted(` <${p.email}>`) : ""}${tag}`);
      }
      console.log(fmt.muted(`\nclone one with: cast browser start --profile "<dir>"`));
    });

  br.command("start")
    .description("Launch the managed browser (clones a Chrome profile so logins carry over)")
    .option("--profile <dir>", "Chrome profile directory to clone (see `cast browser profiles`)")
    .option("--channel <name>", "chrome | canary | chromium", "chrome")
    .option("--headless", "Run without a visible window")
    .option("--fresh", "Start from an empty profile — no cookies, no logins")
    .option("--resync", "Re-copy the profile even if a clone already exists")
    .option("--size <WxH>", "Window size", "1440x900")
    .action(async (o: { profile?: string; channel: ChromeChannel; headless?: boolean; fresh?: boolean; resync?: boolean; size: string }) => {
      const existing = readState();
      if (await isLive(existing)) {
        console.log(`${OK} already running on port ${existing!.port} (pid ${existing!.pid})`);
        console.log(fmt.muted("  `cast browser stop` first if you want a different profile"));
        return;
      }

      const userDataDir = clonePath(DEFAULT_CLONE);
      let sourceProfile: string | null = null;

      if (o.fresh) {
        fs.rmSync(userDataDir, { recursive: true, force: true });
        fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
        console.log(`${OK} fresh profile (logged out of everything)`);
      } else {
        const profiles = listRealProfiles(o.channel);
        const pick = o.profile ?? profiles.find((p) => p.lastUsed)?.dir ?? "Default";
        const known = profiles.find((p) => p.dir === pick);
        sourceProfile = pick;
        const needsClone = o.resync || !fs.existsSync(path.join(userDataDir, "Default", "Cookies"));
        if (needsClone) {
          console.log(`  cloning ${fmt.highlight(known?.name ?? pick)}${known?.email ? fmt.muted(` <${known.email}>`) : ""}…`);
          const res = cloneProfile({ sourceDir: pick, destRoot: userDataDir, channel: o.channel });
          console.log(`${OK} cloned ${res.files} items, ${formatBytes(res.bytes)}`);
          if (!res.cookiesFound) {
            console.log(
              `${WARN} no cookie store was copied — the browser will start logged out.\n` +
                `  ${fmt.muted("Chrome may have been mid-write; try `cast browser start --resync` with Chrome closed.")}`,
            );
          }
        } else {
          console.log(`  reusing existing clone ${fmt.muted(userDataDir)} ${fmt.muted("(--resync to refresh logins)")}`);
        }
      }

      // An abandoned Chrome still holding this profile would swallow the launch.
      const strays = killStrayChrome(userDataDir);
      if (strays) {
        console.log(fmt.muted(`  cleared ${strays} stray Chrome process(es) holding the profile`));
        await new Promise((r) => setTimeout(r, 1500));
      }

      const [w, h] = o.size.split("x").map((n) => parseInt(n, 10));
      const port = await freePort();
      let pid: number;
      try {
        pid = await launchManagedChrome({
          userDataDir,
          port,
          headless: o.headless,
          channel: o.channel,
          windowSize: { width: w || 1440, height: h || 900 },
        });
      } catch (err) {
        die((err as Error).message);
      }

      const state: InstanceState = {
        pid, port, userDataDir,
        headless: !!o.headless,
        sourceProfile,
        channel: o.channel,
        startedAt: Date.now(),
        activeTargetId: null,
      };
      writeState(state);
      onReady();
      console.log(`${OK} browser up — pid ${pid}, CDP 127.0.0.1:${port}${o.headless ? ", headless" : ""}`);
      if (!o.fresh) {
        console.log(
          fmt.muted("  This is a COPY of your profile. The agent's browsing never touches your real Chrome,\n") +
            fmt.muted("  and the copy holds live session cookies — `cast browser stop --wipe` removes it."),
        );
      }
      console.log(fmt.muted("  next: cast browser open <url>"));
    });

  br.command("status")
    .description("Is the managed browser running, and on what")
    .action(async () => {
      const state = readState();
      if (!state) return console.log(`${fmt.muted(icons.dot)} not started — \`cast browser start\``);
      const live = await isLive(state);
      if (!live) {
        console.log(`${WARN} recorded instance (pid ${state.pid}) is gone — \`cast browser start\` to relaunch`);
        return;
      }
      const mins = Math.round((Date.now() - state.startedAt) / 60000);
      console.log(`${OK} running  pid ${state.pid}  port ${state.port}  up ${mins}m${state.headless ? "  headless" : ""}`);
      console.log(`  profile: ${state.sourceProfile ? `clone of ${state.sourceProfile}` : "fresh"}  ${fmt.muted(state.userDataDir)}`);
      const targets = await listTargets(state.port);
      console.log(`  ${targets.length} tab(s):`);
      for (const t of targets) console.log(`  ${describeTab(t, t.targetId === state.activeTargetId)}`);
    });

  br.command("stop")
    .description("Shut the managed browser down")
    .option("--wipe", "Also delete the cloned profile and its cookies")
    .action(async (o: { wipe?: boolean }) => {
      const state = readState();
      if (!state) return console.log("nothing to stop");
      await stopInstance(state);
      clearState();
      console.log(`${OK} stopped`);
      if (o.wipe) {
        fs.rmSync(path.join(browserHome(), "profiles"), { recursive: true, force: true });
        console.log(`${OK} wiped the cloned profile`);
      }
    });

  // ------------------------------------------------------------- navigation

  br.command("open <url>")
    .description("Open a URL (starts the browser if needed)")
    .option("--new-tab", "Open in a new tab instead of the current one")
    .option("--no-wait", "Return without waiting for the page to settle")
    .action(async (url: string, o: { newTab?: boolean; wait: boolean }) => {
      if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;

      let state = readState();
      if (!(await isLive(state))) {
        die("no managed browser is running", "run `cast browser start` first");
      }
      const s = state!;
      const conn = await CdpConnection.fromPort(s.port);
      try {
        let targetId: string;
        const targets = await listTargets(s.port);
        const blank = targets.find((t) => t.url === "about:blank");
        if (o.newTab || (!targets.length && !blank)) {
          const res = await conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
          targetId = res.targetId;
        } else if (s.activeTargetId && targets.some((t) => t.targetId === s.activeTargetId)) {
          targetId = s.activeTargetId;
        } else {
          targetId = (blank ?? targets[targets.length - 1]).targetId;
        }

        const page = await attachToTarget(conn, targetId);
        // Arm BEFORE navigating so the recorder sees the page's own boot logs —
        // the errors an agent is usually looking for happen during startup.
        await armRecorder(page);
        await conn.send("Page.navigate", { url }, page.sessionId);
        setActiveTarget(s, targetId);

        if (o.wait !== false) {
          const r = await settle(page);
          if (!r.settled) console.log(fmt.muted(`  (did not fully settle: ${r.reason})`));
        }
        const snap = await snapshotPage(page, { maxChars: 1 });
        console.log(pageLine(snap.url, snap.title));
        console.log(fmt.muted(`  tab ${shortId(targetId)} — next: cast browser snapshot`));
      } finally {
        conn.close();
      }
    });

  for (const [name, desc, method] of [
    ["back", "Go back in history", "back"],
    ["forward", "Go forward in history", "forward"],
  ] as const) {
    br.command(name)
      .description(desc)
      .option("--tab <id>", "Act on a specific tab")
      .action(async (o: { tab?: string }) => {
        await withPage(o, async (page) => {
          const hist = await page.conn.send<any>("Page.getNavigationHistory", {}, page.sessionId);
          const idx = method === "back" ? hist.currentIndex - 1 : hist.currentIndex + 1;
          const entry = hist.entries[idx];
          if (!entry) die(`nothing to go ${method === "back" ? "back" : "forward"} to`);
          await page.conn.send("Page.navigateToHistoryEntry", { entryId: entry.id }, page.sessionId);
          await settle(page);
          const snap = await snapshotPage(page, { maxChars: 1 });
          console.log(pageLine(snap.url, snap.title));
        });
      });
  }

  br.command("reload")
    .description("Reload the page")
    .option("--hard", "Bypass the cache")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (o: { hard?: boolean; tab?: string }) => {
      await withPage(o, async (page) => {
        await page.conn.send("Page.reload", { ignoreCache: !!o.hard }, page.sessionId);
        await settle(page);
        const snap = await snapshotPage(page, { maxChars: 1 });
        console.log(pageLine(snap.url, snap.title));
      });
    });

  // ------------------------------------------------------------------- tabs

  br.command("tabs")
    .description("List open tabs")
    .action(async () => {
      const state = readState();
      if (!(await isLive(state))) die("no managed browser is running");
      const targets = await listTargets(state!.port);
      for (const t of targets) console.log(describeTab(t, t.targetId === state!.activeTargetId));
    });

  br.command("tab <id>")
    .description("Switch the active tab (id prefix or a substring of its URL)")
    .action(async (id: string) => {
      const state = readState();
      if (!(await isLive(state))) die("no managed browser is running");
      const target = await resolveTarget(state!.port, state!, id);
      setActiveTarget(state!, target.targetId);
      // Bring it to the front so a watching human sees what the agent sees.
      const conn = await CdpConnection.fromPort(state!.port);
      try {
        const page = await attachToTarget(conn, target.targetId);
        await conn.send("Page.bringToFront", {}, page.sessionId).catch(() => {});
      } finally {
        conn.close();
      }
      console.log(`${OK} active tab: ${target.title || target.url}`);
    });

  br.command("close")
    .description("Close a tab")
    .option("--tab <id>", "Which tab (default: the active one)")
    .action(async (o: { tab?: string }) => {
      const state = readState();
      if (!(await isLive(state))) die("no managed browser is running");
      const target = await resolveTarget(state!.port, state!, o.tab);
      const conn = await CdpConnection.fromPort(state!.port);
      try {
        await conn.send("Target.closeTarget", { targetId: target.targetId });
      } finally {
        conn.close();
      }
      if (state!.activeTargetId === target.targetId) writeState({ ...state!, activeTargetId: null });
      console.log(`${OK} closed ${target.title || target.url}`);
    });

  // -------------------------------------------------------------- perception

  br.command("snapshot")
    .alias("snap")
    .description("Print the page as an accessibility tree with #eNN refs to act on")
    .option("--interactive", "Only clickable/typable elements — much cheaper")
    .option("--max-chars <n>", "Truncate beyond this many characters", "40000")
    .option("--no-frames", "Skip child frames")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (o: { interactive?: boolean; maxChars: string; frames: boolean; tab?: string }) => {
      await withPage(o, async (page) => {
        const snap = await snapshotPage(page, {
          interactiveOnly: o.interactive,
          maxChars: parseInt(o.maxChars, 10),
          frames: o.frames,
        });
        console.log(pageLine(snap.url, snap.title));
        console.log("");
        console.log(snap.text || fmt.muted("(nothing in the accessibility tree — the page may still be loading)"));
        if (snap.truncated) {
          console.log(fmt.muted(`\n… truncated at ${o.maxChars} chars. Narrow with --interactive, or raise --max-chars.`));
        }
        console.log(fmt.muted(`\n${snap.refs.length} refs · ${snap.nodes} nodes · ${snap.ms}ms`));
      });
    });

  br.command("find <text>")
    .description("Find refs whose accessible name matches")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (text: string, o: { tab?: string }) => {
      await withPage(o, async (page) => {
        const snap = await snapshotPage(page);
        const hits = matchRefs(snap.refs, text);
        if (!hits.length) {
          console.log(`no element matching ${JSON.stringify(text)} (${snap.refs.length} refs on the page)`);
          return;
        }
        for (const h of hits.slice(0, 25)) console.log(`  ${h.role} ${JSON.stringify(h.name)} #e${h.ref}`);
        if (hits.length > 25) console.log(fmt.muted(`  … and ${hits.length - 25} more`));
      });
    });

  br.command("text")
    .description("Print the page's visible text (for reading, not acting)")
    .option("--tab <id>", "Act on a specific tab")
    .option("--max-chars <n>", "Truncate beyond this", "20000")
    .action(async (o: { tab?: string; maxChars: string }) => {
      await withPage(o, async (page) => {
        const max = parseInt(o.maxChars, 10);
        const text = (await evaluate(page, `document.body ? document.body.innerText : ""`)) as string;
        console.log(text.slice(0, max));
        if (text.length > max) console.log(fmt.muted(`\n… ${text.length - max} more chars`));
      });
    });

  br.command("shot")
    .description("Screenshot the page")
    .option("--full", "Whole scroll height, not just the viewport")
    .option("--ref <n>", "Just this element")
    .option("--out <path>", "Where to write it")
    .option("--share", "Upload and print a URL that renders inline in the thread")
    .option("--jpeg", "JPEG instead of PNG — much smaller for photos")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (o: { full?: boolean; ref?: string; out?: string; share?: boolean; jpeg?: boolean; tab?: string }) => {
      await withPage(o, async (page) => {
        const buf = await screenshot(page, {
          fullPage: o.full,
          ref: o.ref ? parseInt(o.ref.replace(/^#?e/, ""), 10) : undefined,
          format: o.jpeg ? "jpeg" : "png",
        });
        const out =
          o.out ??
          path.join(os.tmpdir(), `cast-shot-${Date.now()}.${o.jpeg ? "jpg" : "png"}`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, buf);
        console.log(`${OK} ${out} (${formatBytes(buf.length)})`);
        if (o.share) {
          // Same upload path as `cast image`, so the URL renders inline for the
          // human instead of being a dead local path.
          const snap = await snapshotPage(page, { maxChars: 1 });
          const img = await uploadOne(deps, out, snap.title || "screenshot");
          console.log(img.markdown);
        }
      });
    });

  // ------------------------------------------------------------------ acting

  const refOf = (raw: string): number => {
    const n = parseInt(String(raw).replace(/^#?e/i, ""), 10);
    if (!Number.isFinite(n)) die(`'${raw}' is not a ref — refs look like #e1234 and come from \`cast browser snapshot\``);
    return n;
  };

  /** Report what an action changed, so the agent rarely needs a second call. */
  async function reportAfter(page: PageSession, before: { url: string; title: string }): Promise<void> {
    const r = await settle(page, { timeoutMs: 8000 });
    const snap = await snapshotPage(page, { maxChars: 1 });
    if (snap.url !== before.url) {
      console.log(`  → navigated to ${fmt.highlight(snap.title || snap.url)}`);
      console.log(`    ${fmt.muted(snap.url)}`);
    } else if (!r.settled) {
      console.log(fmt.muted(`  (page still busy: ${r.reason})`));
    }
  }

  br.command("click <ref>")
    .description("Click an element by ref")
    .option("--force", "Click even if something is on top of it")
    .option("--right", "Right click")
    .option("--double", "Double click")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (ref: string, o: { force?: boolean; right?: boolean; double?: boolean; tab?: string }) => {
      await withPage(o, async (page) => {
        const before = await snapshotPage(page, { maxChars: 1 });
        try {
          const pt = await click(page, refOf(ref), {
            force: o.force,
            button: o.right ? "right" : "left",
            clickCount: o.double ? 2 : 1,
          });
          console.log(`${OK} clicked #e${refOf(ref)} at ${Math.round(pt.x)},${Math.round(pt.y)}`);
        } catch (err) {
          die((err as Error).message);
        }
        await reportAfter(page, before);
      });
    });

  br.command("click-at <x> <y>")
    .description("Click raw viewport coordinates (escape hatch when no ref fits)")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (x: string, y: string, o: { tab?: string }) => {
      await withPage(o, async (page) => {
        const before = await snapshotPage(page, { maxChars: 1 });
        await clickAt(page, { x: parseFloat(x), y: parseFloat(y) });
        console.log(`${OK} clicked ${x},${y}`);
        await reportAfter(page, before);
      });
    });

  br.command("type <ref> <text>")
    .description("Type into a field")
    .option("--clear", "Replace what is there")
    .option("--submit", "Press Enter afterwards")
    .option("--per-key", "One key event per character — needed for autocompletes")
    .option("--delay <ms>", "Delay between keys with --per-key", "20")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (ref: string, text: string, o: any) => {
      await withPage(o, async (page) => {
        const before = await snapshotPage(page, { maxChars: 1 });
        try {
          await type(page, refOf(ref), text, {
            clear: o.clear, submit: o.submit, perKey: o.perKey, delayMs: parseInt(o.delay, 10),
          });
        } catch (err) {
          die((err as Error).message);
        }
        console.log(`${OK} typed ${JSON.stringify(text.slice(0, 60))} into #e${refOf(ref)}${o.submit ? " and submitted" : ""}`);
        await reportAfter(page, before);
      });
    });

  br.command("press <key>")
    .description('Press a key: Enter, Escape, Tab, ArrowDown, "cmd+a", "/"')
    .option("--tab <id>", "Act on a specific tab")
    .action(async (key: string, o: { tab?: string }) => {
      await withPage(o, async (page) => {
        const before = await snapshotPage(page, { maxChars: 1 });
        await pressKey(page, key);
        console.log(`${OK} pressed ${key}`);
        await reportAfter(page, before);
      });
    });

  br.command("hover <ref>")
    .description("Hover an element (reveals menus and tooltips)")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (ref: string, o: { tab?: string }) => {
      await withPage(o, async (page) => {
        const pt = await hover(page, refOf(ref));
        console.log(`${OK} hovered #e${refOf(ref)} at ${Math.round(pt.x)},${Math.round(pt.y)}`);
      });
    });

  br.command("focus <ref>")
    .description("Focus an element without clicking it")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (ref: string, o: { tab?: string }) => {
      await withPage(o, async (page) => {
        await focus(page, refOf(ref));
        console.log(`${OK} focused #e${refOf(ref)}`);
      });
    });

  br.command("select <ref> <value>")
    .description("Choose an option in a <select>")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (ref: string, value: string, o: { tab?: string }) => {
      await withPage(o, async (page) => {
        const before = await snapshotPage(page, { maxChars: 1 });
        try {
          await selectOption(page, refOf(ref), value);
        } catch (err) {
          die((err as Error).message);
        }
        console.log(`${OK} selected ${JSON.stringify(value)}`);
        await reportAfter(page, before);
      });
    });

  br.command("scroll [amount]")
    .description("Scroll the page (positive is down; default one screen)")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (amount: string | undefined, o: { tab?: string }) => {
      await withPage(o, async (page) => {
        const dy = amount ? parseFloat(amount) : 600;
        await scroll(page, dy);
        const pos = await evaluate(page, `JSON.stringify([Math.round(scrollY), Math.round(document.documentElement.scrollHeight - innerHeight)])`);
        const [y, max] = JSON.parse(pos as string);
        console.log(`${OK} scrolled ${dy > 0 ? "down" : "up"} — at ${y} of ${max}`);
      });
    });

  br.command("upload <ref> <files...>")
    .description("Attach files to a file input, with no OS picker")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (ref: string, files: string[], o: { tab?: string }) => {
      const abs = files.map((f) => path.resolve(f));
      for (const f of abs) if (!fs.existsSync(f)) die(`no such file: ${f}`);
      await withPage(o, async (page) => {
        await uploadFiles(page, refOf(ref), abs);
        console.log(`${OK} attached ${abs.length} file(s) to #e${refOf(ref)}`);
      });
    });

  br.command("eval <expression>")
    .description("Run JavaScript in the page and print the result")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (expression: string, o: { tab?: string }) => {
      await withPage(o, async (page) => {
        try {
          const v = await evaluate(page, expression);
          console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
        } catch (err) {
          die((err as Error).message);
        }
      });
    });

  br.command("wait")
    .description("Wait for the page to settle, or for text to appear")
    .option("--text <s>", "Wait until this text is on the page")
    .option("--ref <n>", "Wait until this element exists")
    .option("--ms <n>", "Just wait this long")
    .option("--timeout <ms>", "Give up after this", "15000")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (o: { text?: string; ref?: string; ms?: string; timeout: string; tab?: string }) => {
      await withPage(o, async (page) => {
        const timeout = parseInt(o.timeout, 10);
        if (o.ms) {
          await new Promise((r) => setTimeout(r, parseInt(o.ms!, 10)));
          return console.log(`${OK} waited ${o.ms}ms`);
        }
        if (o.text) {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const found = await evaluate(page, `!!document.body && document.body.innerText.includes(${JSON.stringify(o.text)})`);
            if (found) return console.log(`${OK} found ${JSON.stringify(o.text)}`);
            await new Promise((r) => setTimeout(r, 250));
          }
          die(`${JSON.stringify(o.text)} never appeared within ${timeout}ms`);
        }
        if (o.ref) {
          const deadline = Date.now() + timeout;
          const ref = refOf(o.ref);
          while (Date.now() < deadline) {
            try {
              await locate(page, ref);
              return console.log(`${OK} #e${ref} is present`);
            } catch {
              await new Promise((r) => setTimeout(r, 250));
            }
          }
          die(`#e${ref} never appeared within ${timeout}ms`);
        }
        const r = await settle(page, { timeoutMs: timeout });
        console.log(r.settled ? `${OK} settled` : `${WARN} still busy: ${r.reason}`);
      });
    });

  // -------------------------------------------------------------- diagnostics

  br.command("console")
    .description("What the page logged")
    .option("--errors", "Errors and warnings only")
    .option("--clear", "Empty the buffer instead of printing it")
    .option("-n <count>", "How many lines", "50")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (o: any) => {
      await withPage(o, async (page) => {
        if (o.clear) {
          await clearRecording(page);
          return console.log(`${OK} cleared`);
        }
        const rec = await readRecording(page);
        if (!rec.armed) {
          console.log(`${WARN} could not read this page's console (the recorder did not install).`);
          return;
        }
        if (rec.late) {
          console.log(
            fmt.muted("  (capture started after this page had already run — earlier logs are missing; `cast browser reload` catches the whole load)"),
          );
        }
        const wanted = o.errors ? rec.console.filter((c) => c.level === "error" || c.level === "warn") : rec.console;
        const n = parseInt(o.n, 10);
        for (const e of wanted.slice(-n)) {
          const tag = e.level === "error" ? fmt.error("ERR") : e.level === "warn" ? fmt.warning("WRN") : fmt.muted(e.level.toUpperCase().slice(0, 3));
          console.log(`${fmt.muted(`+${(e.t / 1000).toFixed(1)}s`)} ${tag} ${e.text}`);
        }
        for (const e of rec.errors.slice(-n)) {
          console.log(`${fmt.muted(`+${(e.t / 1000).toFixed(1)}s`)} ${fmt.error("UNCAUGHT")} ${e.text}`);
          if (e.stack) console.log(fmt.muted(e.stack.split("\n").slice(1, 4).map((l) => `    ${l.trim()}`).join("\n")));
        }
        if (!wanted.length && !rec.errors.length) console.log(fmt.muted("(nothing logged)"));
      });
    });

  br.command("network")
    .description("What the page requested")
    .option("--failed", "Only failures and 4xx/5xx")
    .option("-n <count>", "How many rows", "40")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (o: any) => {
      await withPage(o, async (page) => {
        const rec = await readRecording(page);
        if (!rec.armed) {
          console.log(`${WARN} could not read this page's network (the recorder did not install).`);
          return;
        }
        if (rec.late) {
          console.log(
            fmt.muted("  (capture started after this page had already run — earlier requests are missing; `cast browser reload` catches the whole load)"),
          );
        }
        let rows = rec.network;
        if (o.failed) rows = rows.filter((r) => r.error || (r.status !== null && (r.status === 0 || r.status >= 400)));
        const n = parseInt(o.n, 10);
        for (const r of rows.slice(-n)) {
          const status = r.error ? fmt.error("ERR") : r.status === null ? "  -" : String(r.status).padStart(3);
          const colored = !r.error && r.status !== null && r.status >= 400 ? fmt.error(status) : status;
          console.log(`${colored} ${r.method.padEnd(6)} ${String(r.ms).padStart(5)}ms ${r.url.slice(0, 110)}${r.error ? fmt.error(` ${r.error}`) : ""}`);
        }
        if (!rows.length) console.log(fmt.muted(o.failed ? "(no failed requests)" : "(no requests recorded)"));
      });
    });
}
