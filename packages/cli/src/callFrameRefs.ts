/**
 * Frames of a call an agent looks at sync as references, never as pictures.
 *
 * `cast call snap` writes a frame into the owner-only scratch directory,
 * because a frame of a private call is as private as the call. The next step
 * it documents is for the agent to Read the PNG, and Claude Code writes what
 * it read into the transcript as an image block. The parser lifts every such
 * image onto the message and the sync uploads it, so without this module the
 * frame of a private huddle (a guest's face, a teammate's screen) would land
 * on a session row that a team feed or a public share link can read, outside
 * canReadCall, and would survive the recording's deletion.
 *
 * So every frame snap writes is remembered here with the reference it cites
 * (`cl-42@12:34`), and before a message syncs (SyncService.offloadImages, the
 * one door every agent's images pass through) an image that is one of those
 * frames is replaced by the reference: the text `Frame of the call: cl-42@…`
 * on its tool result, which the web renders as that frame under the call's
 * own access rule, and which shows nothing once the recording is gone.
 *
 * Which image is a frame: its path when the image names one (a Codex image,
 * an inline marker), else the path of the Read whose result it is (the tool
 * call travels on an earlier message, so its path is remembered across
 * batches), else the original file's size and dimensions, which Claude Code
 * records beside a Read image (`toolUseResult.file`). The last one covers a
 * daemon that restarted between the Read and its result, which leaves no
 * memory of the call.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { callFrameSeenRef, callFrameSeenText } from "@codecast/shared/contracts";
import { codecastDir, homeDir } from "./codecastDir.js";

export type CallFrameEntry = {
  ref: string;
  recording_id: string;
  bytes: number;
  width: number | null;
  height: number | null;
  at: number;
};

type Index = { v: 1; frames: Record<string, CallFrameEntry> };

/** How long a frame is remembered. A frame read later than this (one kept
 *  under -o for weeks) syncs as the picture it is. */
export const CALL_FRAME_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** The most frames remembered; the oldest go first. */
const MAX_FRAMES = 4000;
/** The most Read calls remembered between a call and its result. */
const MAX_READS = 1000;

function indexPath(): string {
  return path.join(codecastDir(), "call-frames.json");
}

let cache: { file: string; mtimeMs: number; size: number; index: Index } | null = null;

function load(): Index {
  const file = indexPath();
  try {
    const st = fs.statSync(file);
    if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.index;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const index: Index = parsed?.v === 1 && parsed.frames && typeof parsed.frames === "object" ? parsed : { v: 1, frames: {} };
    cache = { file, mtimeMs: st.mtimeMs, size: st.size, index };
    return index;
  } catch {
    return { v: 1, frames: {} };
  }
}

function normalize(p: string): string {
  return path.resolve(p.startsWith("~/") ? path.join(homeDir(), p.slice(2)) : p);
}

/** Remember the frames a snap wrote (every tile too), with the reference each
 *  cites. Best effort: a frame not remembered syncs as before, so a failure
 *  here never fails the snap. */
export function rememberCallFrames(
  frames: ReadonlyArray<{ path: string; ref: string; recording_id: string; width?: number | null; height?: number | null; tiles?: ReadonlyArray<{ path: string; width: number; height: number }> }>,
  now = Date.now(),
): void {
  const index = load();
  const next: Record<string, CallFrameEntry> = {};
  for (const [p, e] of Object.entries(index.frames)) if (now - e.at < CALL_FRAME_KEEP_MS) next[p] = e;
  const add = (file: string, ref: string, recording_id: string, width: number | null, height: number | null) => {
    try {
      const abs = normalize(file);
      next[abs] = { ref, recording_id, bytes: fs.statSync(abs).size, width, height, at: now };
    } catch {
      // A frame that is not on disk cannot be read either.
    }
  };
  for (const f of frames) {
    add(f.path, f.ref, f.recording_id, f.width ?? null, f.height ?? null);
    for (const t of f.tiles ?? []) add(t.path, f.ref, f.recording_id, t.width, t.height);
  }
  const kept = Object.entries(next).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_FRAMES);
  const out: Index = { v: 1, frames: Object.fromEntries(kept) };
  const file = indexPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
  fs.renameSync(tmp, file);
  cache = null;
}

/** The frame at this path, if a snap wrote it. */
export function callFrameAtPath(p: string | null | undefined): CallFrameEntry | null {
  if (!p) return null;
  return load().frames[normalize(p)] ?? null;
}

/** The frame whose file had this size (and these dimensions, when known):
 *  what Claude Code records about the file a Read image came from. */
export function callFrameBySource(source: { bytes: number; width?: number; height?: number } | null | undefined): CallFrameEntry | null {
  if (!source || !(source.bytes > 0)) return null;
  for (const e of Object.values(load().frames)) {
    if (e.bytes !== source.bytes) continue;
    if (source.width != null && e.width != null && source.width !== e.width) continue;
    if (source.height != null && e.height != null && source.height !== e.height) continue;
    return e;
  }
  return null;
}

// The path each recent Read asked for, by tool_use id: the call rides the
// assistant message, its image the next user message, often the next batch.
const readPaths = new Map<string, string>();

function noteReads(toolCalls: unknown): void {
  if (!Array.isArray(toolCalls)) return;
  for (const call of toolCalls) {
    if (!call || typeof call !== "object" || typeof (call as any).id !== "string") continue;
    let input: any = (call as any).input;
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        continue;
      }
    }
    const file = input?.file_path ?? input?.path;
    if (typeof file !== "string" || !file) continue;
    readPaths.delete((call as any).id);
    readPaths.set((call as any).id, file);
    while (readPaths.size > MAX_READS) readPaths.delete(readPaths.keys().next().value!);
  }
}

type FrameImage = {
  localPath?: string;
  toolUseId?: string;
  storageId?: string;
  source?: { bytes: number; width?: number; height?: number };
};

type FrameMessage = {
  role?: string;
  content?: string;
  toolCalls?: unknown;
  toolResults?: Array<{ toolUseId: string; content: string }>;
  images?: FrameImage[];
};

/** Where a moment's reference goes: the tool result the image answered, else
 *  the message's own text. Said once however many images named it. */
function cite(msg: FrameMessage, toolUseId: string | undefined, ref: string): void {
  const line = callFrameSeenText(ref);
  const result = toolUseId ? msg.toolResults?.find((r) => r.toolUseId === toolUseId) : undefined;
  if (result) {
    if (callFrameSeenRef(result.content) === ref) return;
    result.content = result.content ? `${result.content}\n${line}` : line;
    return;
  }
  if (msg.content?.includes(line)) return;
  msg.content = msg.content ? `${msg.content}\n${line}` : line;
}

/**
 * Replace every image that is a remembered call frame with its reference, in
 * place. Returns how many were replaced. Idempotent: an image already
 * uploaded is left alone, and a replaced one is gone.
 */
export function referenceCallFrames(messages: ReadonlyArray<FrameMessage>): number {
  for (const msg of messages) noteReads(msg.toolCalls);
  let replaced = 0;
  for (const msg of messages) {
    if (!msg.images?.length) continue;
    // A person's own turn is theirs as typed: an image they attached stays,
    // and its words are never rewritten (the server matches a turn to its
    // pending row by them). What an agent looked at is what this is for: an
    // image a tool returned (Claude's ride the user-role message that
    // carries the tool results), or any image on an agent's own message.
    const typed = msg.role === "user" || msg.role === "human";
    const kept: FrameImage[] = [];
    for (const img of msg.images) {
      const fromTool = !!img.toolUseId && !!msg.toolResults?.some((r) => r.toolUseId === img.toolUseId);
      const hit = img.storageId || (typed && !fromTool)
        ? null
        : callFrameAtPath(img.localPath) ?? callFrameAtPath(img.toolUseId ? readPaths.get(img.toolUseId) : undefined) ?? callFrameBySource(img.source);
      if (!hit) {
        kept.push(img);
        continue;
      }
      cite(msg, img.toolUseId, hit.ref);
      replaced++;
    }
    msg.images = kept.length ? kept : undefined;
  }
  return replaced;
}

/** Test seam: forget the Read memory and the cached index. */
export function resetCallFrameMemory(): void {
  readPaths.clear();
  cache = null;
}
