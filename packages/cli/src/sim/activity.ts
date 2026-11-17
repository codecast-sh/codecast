/**
 * What the agent just did to its simulator, for the pane that shows it.
 *
 * `cast sim tap`, `swipe`, `scroll`, `type` and `button` run in the agent's
 * own process, while the pane's stream runs in the daemon. The frames show the
 * result, never the touch, so each verb leaves its last action in a file
 * beside the device's lock and the stream (sim/watch.ts) turns it into the
 * cursor and caption the browser watch already draws. One small file per
 * device, overwritten each time: the viewer wants where the hand is now, not
 * a history.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { lockDir } from "./pool.js";

/** Points are the simulator's own coordinates, the ones `cast sim tap` takes. */
export type SimAction =
  | { kind: "tap"; x: number; y: number; at: number }
  | { kind: "swipe"; x: number; y: number; x2: number; y2: number; at: number }
  | { kind: "type"; text: string; at: number }
  | { kind: "button"; name: string; at: number };

/** Typed text is a caption, not a transcript (the browser watch's own cap). */
const TEXT_CAP = 200;

export function activityPath(udid: string, dir = lockDir()): string {
  return path.join(dir, `${udid}.action`);
}

type SimActionInput = SimAction extends infer A ? (A extends SimAction ? Omit<A, "at"> : never) : never;

/** Record the agent's action. Never fails the verb that called it. */
export function noteSimAction(udid: string, action: SimActionInput, dir = lockDir(), now = Date.now()): void {
  try {
    const a = { ...action, at: now } as SimAction;
    if (a.kind === "type") a.text = a.text.slice(-TEXT_CAP);
    fs.mkdirSync(dir, { recursive: true });
    const file = activityPath(udid, dir);
    const tmp = `${file}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(a));
    fs.renameSync(tmp, file);
  } catch {}
}

/** The last recorded action, or null when there is none or it is unreadable. */
export function readSimAction(udid: string, dir = lockDir()): SimAction | null {
  try {
    const a = JSON.parse(fs.readFileSync(activityPath(udid, dir), "utf-8"));
    if (!a || typeof a.at !== "number") return null;
    const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
    switch (a.kind) {
      case "tap":
        return num(a.x) && num(a.y) ? a : null;
      case "swipe":
        return num(a.x) && num(a.y) && num(a.x2) && num(a.y2) ? a : null;
      case "type":
        return typeof a.text === "string" ? a : null;
      case "button":
        return typeof a.name === "string" ? a : null;
    }
  } catch {}
  return null;
}
