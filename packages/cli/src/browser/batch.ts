/**
 * Running several browser steps in one invocation.
 *
 * Measured on this machine: the CDP work behind a command is about 85ms, while
 * the command itself takes one to three seconds. Nearly all of that is process
 * startup — loading the whole `cast` CLI — paid again for every click in a six
 * step flow. Batching amortises it across the steps, which is the same reason
 * the Chrome extension offers a batch tool.
 *
 * The steps reuse the ordinary action functions rather than re-implementing
 * them, so a batched click and a `cast browser click` are the same code with
 * the same occlusion checks and the same errors.
 *
 * A batch stops at the first failing step by default. Later steps almost always
 * depend on earlier ones — a click on a ref from a snapshot that never
 * happened is not worth attempting, and carrying on would bury the real error
 * under a pile of consequential ones.
 */

import type { PageSession } from "./instance.js";
import { settle } from "./instance.js";
import { isMutatingStep } from "./autoShot.js";
import { snapshotPage, matchRefs, type Snapshot } from "./snapshot.js";
import {
  clearViewport, click, clickAt, DEVICES, evaluate, focus, hover, locate, pressKey,
  scroll, selectOption, setViewport, type, type DeviceProfile,
} from "./actions.js";

export interface StepResult {
  step: string;
  ok: boolean;
  /** One line describing what happened, in the same voice as the CLI. */
  output: string;
  /** Set when the step failed. */
  error?: string;
}

/**
 * Split a step into arguments, honouring quotes so a typed string may contain
 * spaces: `type #e7 "hello world" --submit`.
 */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && line[i + 1] === quote) cur += line[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

const refOf = (raw: string): number => {
  const n = parseInt(String(raw).replace(/^#?e/i, ""), 10);
  if (!Number.isFinite(n)) throw new Error(`'${raw}' is not a ref — refs look like #e1234 and come from a snapshot`);
  return n;
};

/** Steps that need the page to have finished changing before the next one runs. */
const SETTLES = new Set(["open", "click", "type", "press", "select", "reload", "back"]);

export interface BatchContext {
  page: PageSession;
  /** Ref of the last `find` hit, so a following step can act on it by name. */
  lastFound?: number;
  /** The most recent snapshot, so `find` can resolve a name to a ref. */
  lastSnapshot?: Snapshot;
  /** Screenshots written during the batch, for the caller to report. */
  shots: string[];
  /** Viewport a step emulated, so the caller can persist it for later commands. */
  viewport?: DeviceProfile;
  /** Takes a screenshot and returns where it was written. */
  capture: (args: string[]) => Promise<string>;
  /** Navigates and reports the page it landed on. */
  navigate: (url: string) => Promise<string>;
  /**
   * Runs after each settling step; returns a note to append to that step's
   * output, or null. The CLI uses it to audit where in-page actions landed.
   */
  afterSettle?: () => Promise<string | null>;
  /** Called after each page-changing step (autoShot.ts). Absent = off. */
  autoShot?: () => Promise<void>;
}

/**
 * Run one step. Throws on failure; the caller decides whether to stop.
 *
 * `find` is the interesting one: it resolves a visible name to a ref and
 * remembers it, so a batch can be written entirely in the names a human sees —
 * `find "Sign in"` then `click` — without the round trip that would otherwise
 * be needed to read a ref out of a snapshot.
 */
export async function runStep(ctx: BatchContext, args: string[], raw?: string): Promise<string> {
  const [verb, ...rest] = args;
  const page = ctx.page;
  const flag = (name: string) => rest.includes(`--${name}`);
  const positional = rest.filter((a) => !a.startsWith("--"));

  switch (verb) {
    case "open":
    case "goto": {
      if (!positional[0]) throw new Error("open needs a url");
      return ctx.navigate(positional[0]);
    }

    case "snapshot":
    case "snap": {
      const snap = await snapshotPage(page, { interactiveOnly: flag("interactive") });
      ctx.lastSnapshot = snap;
      return snap.text || "(nothing in the accessibility tree)";
    }

    case "find": {
      const query = positional[0];
      if (!query) throw new Error("find needs some text to look for");
      const snap = ctx.lastSnapshot ?? (await snapshotPage(page));
      ctx.lastSnapshot = snap;
      const hits = matchRefs(snap.refs, query);
      if (!hits.length) throw new Error(`no element matching ${JSON.stringify(query)}`);
      // Remember the best hit so a bare `click` can use it.
      ctx.lastFound = hits[0].ref;
      return hits.map((h) => `${h.role} ${JSON.stringify(h.name)} #e${h.ref}`).slice(0, 10).join("\n");
    }

    case "click": {
      const ref = positional[0] ? refOf(positional[0]) : ctx.lastFound;
      if (ref === undefined) throw new Error("click needs a ref, or a `find` before it");
      const pt = await click(page, ref, { force: flag("force"), clickCount: flag("double") ? 2 : 1 });
      return `clicked #e${ref} at ${Math.round(pt.x)},${Math.round(pt.y)}`;
    }

    case "type": {
      const ref = positional[0]?.startsWith("#") ? refOf(positional.shift()!) : ctx.lastFound;
      if (ref === undefined) throw new Error("type needs a ref, or a `find` before it");
      const text = positional[0] ?? "";
      await type(page, ref, text, { clear: flag("clear"), submit: flag("submit"), perKey: flag("per-key") });
      return `typed ${JSON.stringify(text.slice(0, 60))}${flag("submit") ? " and submitted" : ""}`;
    }

    case "press": {
      if (!positional[0]) throw new Error("press needs a key");
      await pressKey(page, positional[0]);
      return `pressed ${positional[0]}`;
    }

    case "scroll": {
      const amount = positional[0] ? Math.abs(parseFloat(positional[0])) : 600;
      const dy = flag("up") || (positional[0] ?? "").startsWith("-") ? -amount : amount;
      const r = await scroll(page, dy);
      return r.moved ? `scrolled ${dy > 0 ? "down" : "up"} — at ${r.y} of ${r.max}` : `did not move (at ${r.y} of ${r.max})`;
    }

    case "hover": {
      const ref = positional[0] ? refOf(positional[0]) : ctx.lastFound;
      if (ref === undefined) throw new Error("hover needs a ref");
      await hover(page, ref);
      return `hovered #e${ref}`;
    }

    case "focus": {
      const ref = positional[0] ? refOf(positional[0]) : ctx.lastFound;
      if (ref === undefined) throw new Error("focus needs a ref");
      await focus(page, ref);
      return `focused #e${ref}`;
    }

    case "select": {
      const ref = refOf(positional[0]);
      await selectOption(page, ref, positional[1] ?? "");
      return `selected ${JSON.stringify(positional[1] ?? "")}`;
    }

    case "viewport": {
      const name = positional[0];
      if (!name || name === "reset") {
        await clearViewport(page);
        return "viewport reset to the real window";
      }
      const explicit = /^(\d+)x(\d+)$/.exec(name);
      const device = DEVICES[name] ?? (explicit
        ? { width: parseInt(explicit[1], 10), height: parseInt(explicit[2], 10), scale: 1, mobile: false }
        : null);
      if (!device) throw new Error(`unknown viewport '${name}' — presets: ${Object.keys(DEVICES).join(", ")}, or WxH`);
      await setViewport(page, device);
      ctx.viewport = device;
      return `${name} — ${device.width}x${device.height} @${device.scale}x${device.mobile ? ", touch" : ""}`;
    }

    case "reload": {
      await page.conn.send("Page.reload", { ignoreCache: flag("hard") }, page.sessionId);
      return "reloaded";
    }

    case "eval": {
      // Take the rest of the LINE, not the re-joined tokens: JavaScript is full
      // of quotes, and tokenizing strips them — `eval alert('hi')` would arrive
      // as `alert(hi)` and fail to parse. Everything after the verb is code.
      const source = raw ? raw.replace(/^\s*eval\s+/, "") : positional.join(" ");
      const v = await evaluate(page, source);
      return typeof v === "string" ? v : JSON.stringify(v);
    }

    case "text": {
      const t = (await evaluate(page, `document.body ? document.body.innerText : ""`)) as string;
      return t.slice(0, 20000);
    }

    case "wait": {
      const idx = rest.indexOf("--text");
      if (idx >= 0) {
        const want = rest[idx + 1] ?? "";
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          if (await evaluate(page, `!!document.body && document.body.innerText.includes(${JSON.stringify(want)})`)) {
            return `found ${JSON.stringify(want)}`;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error(`${JSON.stringify(want)} never appeared`);
      }
      const ms = positional[0] ? parseInt(positional[0], 10) : 0;
      if (ms) {
        await new Promise((r) => setTimeout(r, ms));
        return `waited ${ms}ms`;
      }
      const r = await settle(page);
      return r.settled ? "settled" : `still busy: ${r.reason}`;
    }

    case "shot":
    case "screenshot": {
      const out = await ctx.capture(rest);
      ctx.shots.push(out);
      return out;
    }

    default:
      throw new Error(`unknown step '${verb}'`);
  }
}

/** Run every step in order, stopping at the first failure unless told not to. */
export async function runBatch(
  ctx: BatchContext,
  steps: string[],
  opts: { keepGoing?: boolean } = {},
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) {
    const args = tokenize(step);
    if (!args.length || args[0].startsWith("#")) continue; // blank line or comment
    try {
      const output = await runStep(ctx, args, step);
      results.push({ step, ok: true, output });
      // Settling is a courtesy to the NEXT step, not part of this one. Letting
      // it throw here would record the same step twice — once as the success it
      // was, then again as a failure — and abort a batch whose step worked.
      if (SETTLES.has(args[0])) {
        await settle(ctx.page, { timeoutMs: 8000 }).catch(() => {});
        const note = await ctx.afterSettle?.().catch(() => null);
        if (note) results[results.length - 1].output += `\n! ${note}`;
      }
      // After the settle, so the auto shot sees the page the step produced,
      // not the loading state in between.
      if (ctx.autoShot && isMutatingStep(args[0], args)) {
        await ctx.autoShot();
      }
    } catch (err) {
      results.push({ step, ok: false, output: "", error: (err as Error).message });
      if (!opts.keepGoing) break;
    }
  }
  return results;
}
