/**
 * Viewport arguments and multi-viewport capture.
 *
 * `cast browser viewport <size>` and `cast browser shot --viewports a,b` accept
 * the same vocabulary — a preset name from DEVICES or an explicit WxH — so the
 * parsing lives here once, next to the capture loop that guarantees the tab is
 * put back the way it was found.
 *
 * The capture loop is written against `ViewportCapture`, a five-method
 * capability, not against a CDP connection: `cast browser` runs on more than
 * one engine (the built-in CDP driver, agent-browser), and the comparison row
 * has to come out identical on each. Every engine supplies one adapter —
 * `pageViewportCapture` is the built-in driver's — and the shot command never
 * sees the difference.
 */

import * as os from "node:os";
import * as path from "node:path";
import {
  clearViewport, DEVICES, evaluate, screenshot, setViewport, type DeviceProfile, type ShotOptions,
} from "./actions.js";
import { settle, type PageSession } from "./instance.js";
import { writeShotFile } from "./shotFile.js";
import { uploadOne } from "../imageCommand.js";
import { inlineImageMarker } from "../inlineImage.js";
import type { PublishDeps } from "../publish.js";

/** A parsed viewport argument: the profile plus the name to label output with. */
export interface NamedViewport {
  name: string;
  device: DeviceProfile;
}

/**
 * Resolve one viewport argument — a preset name or `WxH` — or null if it is
 * neither. An explicit size emulates a plain desktop screen at that size.
 */
export function parseViewport(size: string): NamedViewport | null {
  const preset = DEVICES[size];
  if (preset) return { name: size, device: preset };
  const explicit = /^(\d+)x(\d+)$/.exec(size);
  if (!explicit) return null;
  return {
    name: size,
    device: { width: parseInt(explicit[1], 10), height: parseInt(explicit[2], 10), scale: 1, mobile: false },
  };
}

/** The hint printed when an argument parses as neither preset nor size. */
export function viewportChoices(): string {
  return `${Object.keys(DEVICES).join(", ")}, or WxH like 1024x768`;
}

/**
 * Parse a comma-separated `--viewports` list. Throws with the offending entry
 * so the caller can die() with it; duplicates are dropped, order kept.
 */
export function parseViewportList(raw: string): NamedViewport[] {
  const out: NamedViewport[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const vp = parseViewport(part);
    if (!vp) throw new Error(`unknown viewport '${part}'`);
    if (seen.has(vp.name)) continue;
    seen.add(vp.name);
    out.push(vp);
  }
  if (!out.length) throw new Error("no viewports given");
  return out;
}

/** What a preset is called in the picture: "mobile 390×844", or the bare size. */
export function viewportLabel(vp: NamedViewport): string {
  const size = `${vp.device.width}×${vp.device.height}`;
  return vp.name === `${vp.device.width}x${vp.device.height}` ? vp.name : `${vp.name} ${size}`;
}

/**
 * The page-side capability the capture loop needs from an engine. Kept to what
 * the loop actually calls so a new engine has five methods to supply, not a
 * CDP connection to fake.
 */
export interface ViewportCapture {
  setViewport(d: DeviceProfile): Promise<void>;
  clearViewport(): Promise<void>;
  /** Wait for layout to reflow at the new metrics. Best effort. */
  settle(): Promise<void>;
  /** Run JavaScript in the page; used only to stamp the label chip. */
  evaluate(js: string): Promise<unknown>;
  screenshot(opts: Pick<ShotOptions, "fullPage" | "format">): Promise<Buffer>;
}

/** The built-in CDP driver's adapter. */
export function pageViewportCapture(page: PageSession): ViewportCapture {
  return {
    setViewport: (d) => setViewport(page, d),
    clearViewport: () => clearViewport(page),
    settle: () => settle(page, { timeoutMs: 5000 }).then(() => undefined),
    evaluate: (js) => evaluate(page, js),
    screenshot: (opts) => screenshot(page, opts),
  };
}

const BADGE_ID = "__cast_viewport_badge";

/**
 * The inline-image channel carries a path but no caption, so the viewport's
 * name goes into the pixels: a small chip in the corner, present only for the
 * capture. `null` removes it. Failures are ignored — a page that refuses script
 * still gets its screenshot, just unlabelled.
 */
async function stampLabel(cap: ViewportCapture, label: string | null): Promise<void> {
  await cap
    .evaluate(
      `(() => {
        document.getElementById(${JSON.stringify(BADGE_ID)})?.remove();
        const label = ${JSON.stringify(label)};
        if (label === null) return;
        const d = document.createElement("div");
        d.id = ${JSON.stringify(BADGE_ID)};
        d.textContent = label;
        d.style.cssText = "position:fixed;top:8px;right:8px;z-index:2147483647;background:rgba(0,0,0,0.72);color:#fff;font:600 12px/1.8 system-ui,sans-serif;padding:0 10px;border-radius:999px;pointer-events:none";
        document.documentElement.appendChild(d);
      })()`,
    )
    .catch(() => {});
}

export interface ViewportShot {
  vp: NamedViewport;
  label: string;
  bytes: Buffer;
}

/**
 * Run `capture` once per viewport, then put the tab back: to `restore` when the
 * tab had a pinned emulation before this command, otherwise to the real window.
 * Restoration runs even when a capture throws — a shot command must never leave
 * the shared tab stuck at mobile width for the next agent.
 */
export async function eachViewport(
  cap: ViewportCapture,
  viewports: NamedViewport[],
  restore: DeviceProfile | undefined,
  capture: (vp: NamedViewport) => Promise<void>,
): Promise<void> {
  try {
    for (const vp of viewports) {
      await cap.setViewport(vp.device);
      await capture(vp);
    }
  } finally {
    if (restore) await cap.setViewport(restore).catch(() => {});
    else await cap.clearViewport().catch(() => {});
  }
}

/**
 * Screenshot the page at each viewport, labelled, and hand back the bytes in
 * order. This is the whole of `shot --viewports` above the file system: an
 * engine adapter that supplies a `ViewportCapture` gets the identical row.
 */
export async function captureAtViewports(
  cap: ViewportCapture,
  viewports: NamedViewport[],
  restore: DeviceProfile | undefined,
  opts: Pick<ShotOptions, "fullPage" | "format">,
): Promise<ViewportShot[]> {
  const shots: ViewportShot[] = [];
  await eachViewport(cap, viewports, restore, async (vp) => {
    await cap.settle().catch(() => {});
    const label = viewportLabel(vp);
    await stampLabel(cap, label);
    try {
      shots.push({ vp, label, bytes: await cap.screenshot(opts) });
    } finally {
      await stampLabel(cap, null);
    }
  });
  return shots;
}

// ---------------------------------------------------------------------------
// The command, above the capability
// ---------------------------------------------------------------------------

export interface ViewportRowOptions {
  out?: string;
  full?: boolean;
  jpeg?: boolean;
  share?: boolean;
  alt?: string;
  inline?: boolean;
}

/** A bad `--viewports` argument, with the hint the CLI should print under it. */
export class ViewportArgError extends Error {
  constructor(message: string, public readonly hint: string) {
    super(message);
  }
}

/**
 * The whole of `shot --viewports`, for any engine that can supply a
 * `ViewportCapture`: parse the list, capture at each viewport, write one file
 * per shot, and print the inline markers as consecutive lines so the thread
 * renders them as one side-by-side comparison row.
 *
 * `restore` is the emulation the tab had before this command (the built-in
 * driver pins one per tab); undefined means "back to the real window".
 */
export async function runViewportRow(
  cap: ViewportCapture,
  rawList: string,
  restore: DeviceProfile | undefined,
  o: ViewportRowOptions,
  deps: PublishDeps,
): Promise<void> {
  let list: NamedViewport[];
  try {
    list = parseViewportList(rawList);
  } catch (err) {
    throw new ViewportArgError((err as Error).message, `use presets (${viewportChoices()}), comma-separated`);
  }
  // The engine's shot has no --jpeg flag; there the format rides on the --out
  // extension. Honour that here so `--out row.jpg` means JPEG on every engine,
  // instead of PNG bytes under a .jpg name.
  const jpeg = o.jpeg ?? (o.out ? /\.jpe?g$/i.test(path.extname(o.out)) : false);
  const shots = await captureAtViewports(cap, list, restore, { fullPage: o.full, format: jpeg ? "jpeg" : "png" });
  const stamp = Date.now();
  const ext = jpeg ? "jpg" : "png";
  const markers: string[] = [];
  const shared: string[] = [];
  for (const { vp, bytes } of shots) {
    // `--out row.png` fans out to row-desktop.png, row-mobile.png, …
    const out = o.out
      ? path.join(path.dirname(o.out), `${path.basename(o.out, path.extname(o.out))}-${vp.name}${path.extname(o.out) || `.${ext}`}`)
      : path.join(os.tmpdir(), `cast-shot-${stamp}-${vp.name}.${ext}`);
    const abs = writeShotFile(bytes, out, { ...o, jpeg });
    if (abs) markers.push(inlineImageMarker(abs));
    // --share has a real caption channel, so the viewport name goes there too.
    if (o.share) shared.push((await uploadOne(deps, out, o.alt ? `${o.alt} — ${vp.name}` : vp.name)).markdown);
  }
  // Consecutive lines, no blank line between: the images land in one
  // paragraph, which the web renders as a side-by-side row.
  if (markers.length) console.log(markers.join("\n"));
  if (shared.length) console.log(shared.join(" "));
}
