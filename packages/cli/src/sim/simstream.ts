/**
 * The simulator's screen as a live stream, and a channel for a person's
 * touches: what the simulator pane in the app watches and drives
 * (sim/watch.ts serves it on the browser watch socket and relay).
 *
 * The work is done by a small native helper (simstream.m) that this machine
 * builds once against the FBSimulatorControl frameworks axe installs. It
 * talks to the simulator in process, so frames come at up to 15 a second and
 * only when the screen changed, and a touch lands at once. A `cast sim tap`
 * or a fresh `axe` process takes ~400 ms each, which is fine for an agent
 * and wrong for a person dragging a finger.
 *
 * When the helper cannot be built (no clang, an axe whose frameworks moved),
 * frames come from `axe stream-video` instead: about 3 a second, and no input,
 * so the pane watches but cannot drive.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "../proc.js";
import { axeBin } from "./simctl.js";
import helperSource from "./simstream.m" with { type: "text" };

export interface SimScreen {
  widthPx: number;
  heightPx: number;
  /** Pixels per point: 3 on most iPhones, 2 on iPads and the SE. */
  scale: number;
}

export interface SimFrame {
  /** JPEG, base64. */
  data: string;
  width: number;
  height: number;
}

export interface SimStreamOptions {
  fps: number;
  /** 0..1 */
  quality: number;
  maxDim: number;
}

export interface SimStreamHandlers {
  onFrame(frame: SimFrame): void;
  /** Once the helper attached: the screen size, for turning 0..1 into points. */
  onScreen?(screen: SimScreen): void;
  /** The stream ended: the simulator shut down, or the helper died. */
  onExit(reason: string): void;
}

export interface SimStream {
  /** True when touches, keys and buttons can be sent. */
  readonly interactive: boolean;
  /** One helper command line (see simstream.m). Dropped when not interactive. */
  send(line: string): void;
  /** Back to full frame rate now: something is about to change. */
  wake(): void;
  stop(): void;
}

/** The axe install's frameworks, by following the axe binary to its libexec. */
export function axeFrameworksDir(bin = axeBin()): string | null {
  if (!bin) return null;
  try {
    const dir = path.join(path.dirname(fs.realpathSync(bin)), "Frameworks");
    return fs.existsSync(path.join(dir, "FBSimulatorControl.framework")) ? dir : null;
  } catch {
    return null;
  }
}

/** Where this source, built against this axe, lives. A new CLI or a new axe builds a new one. */
export function helperPath(frameworks: string, home = os.homedir()): string {
  const hash = crypto.createHash("sha256").update(helperSource).update(frameworks).digest("hex").slice(0, 12);
  return path.join(home, ".codecast", "sim", "bin", `simstream-${hash}`);
}

/**
 * The compiler arguments. Each framework is linked by its Versions/A binary:
 * Homebrew rewrites the install name of the top-level copy, which breaks its
 * signature, and macOS kills a process that maps a page of it.
 */
export function buildArgs(frameworks: string, source: string, out: string): string[] {
  const fw = (name: string) => path.join(frameworks, `${name}.framework`, "Versions", "A", name);
  return [
    "clang", "-fobjc-arc", "-fmodules", "-O2", "-F", frameworks,
    "-framework", "Foundation", "-framework", "ImageIO", "-framework", "CoreGraphics",
    fw("FBControlCore"), fw("FBSimulatorControl"),
    `-Wl,-rpath,${frameworks}`, source, "-o", out,
  ];
}

let building: Promise<string | null> | null = null;

/** The helper binary, built on first use; null when it cannot be built here. */
export function ensureHelper(log: (m: string) => void = () => {}): Promise<string | null> {
  return (building ??= (async () => {
    const frameworks = axeFrameworksDir();
    if (!frameworks) return null;
    const bin = helperPath(frameworks);
    if (fs.existsSync(bin)) return bin;
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    const tmp = `${bin}.${process.pid}.tmp`;
    const src = `${tmp}.m`;
    fs.writeFileSync(src, helperSource);
    const ok = await new Promise<boolean>((resolve) => {
      execFile("xcrun", buildArgs(frameworks, src, tmp), { timeout: 120_000 }, (err, _out, stderr) => {
        if (err) log(`[SIM-STREAM] helper build failed: ${String(stderr || err.message).trim().split("\n").slice(-3).join(" | ")}`);
        resolve(!err);
      });
    });
    fs.rmSync(src, { force: true });
    if (!ok) {
      fs.rmSync(tmp, { force: true });
      return null;
    }
    fs.renameSync(tmp, bin);
    log(`[SIM-STREAM] built ${bin}`);
    return bin;
  })().then((bin) => {
    // A failed build is retried by the next stream, not remembered forever.
    if (!bin) building = null;
    return bin;
  }));
}

/** Split the helper's stdout into frames: 12-byte header, then the JPEG. */
export function helperFrameReader(onFrame: (f: SimFrame) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 12) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 12 + len) break;
      onFrame({ data: buf.subarray(12, 12 + len).toString("base64"), width: buf.readUInt32BE(4), height: buf.readUInt32BE(8) });
      buf = buf.subarray(12 + len);
    }
  };
}

/** Split `axe stream-video --format mjpeg` (multipart, a Content-Length per part) into frames. */
export function mjpegFrameReader(onFrame: (f: SimFrame) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);
  const header = /Content-Length: (\d+)\r\n\r\n/;
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const text = buf.subarray(0, Math.min(buf.length, 512)).toString("latin1");
      const m = header.exec(text);
      if (!m) {
        // Keep a tail long enough to hold a header split across chunks.
        if (buf.length > 4096) buf = buf.subarray(buf.length - 512);
        return;
      }
      const start = m.index + m[0].length;
      const len = Number(m[1]);
      if (buf.length < start + len) return;
      const jpeg = buf.subarray(start, start + len);
      const size = jpegSize(jpeg);
      onFrame({ data: jpeg.toString("base64"), width: size?.width ?? 0, height: size?.height ?? 0 });
      buf = buf.subarray(start + len);
    }
  };
}

/** A JPEG's pixel size, from its first start-of-frame marker. */
export function jpegSize(jpeg: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) return null;
    const marker = jpeg[i + 1];
    const len = jpeg.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** The helper's `screen <wpx> <hpx> <scale>` line. */
export function parseScreenLine(line: string): SimScreen | null {
  const m = /simstream: screen (\d+) (\d+) ([\d.]+)/.exec(line);
  if (!m) return null;
  const screen = { widthPx: Number(m[1]), heightPx: Number(m[2]), scale: Number(m[3]) };
  return screen.widthPx > 0 && screen.heightPx > 0 && screen.scale > 0 ? screen : null;
}

/** The helper's last diagnostic, for why a stream ended. */
function lastLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("objc[")).pop()?.replace(/^simstream: /, "") ?? "";
}

export async function startSimStream(
  udid: string,
  opts: SimStreamOptions,
  handlers: SimStreamHandlers,
  log: (m: string) => void = () => {},
): Promise<SimStream> {
  const helper = await ensureHelper(log);
  let child: ChildProcess;
  let interactive = false;
  let stopped = false;
  let stderrTail = "";
  if (helper) {
    child = spawn(helper, [udid, String(opts.fps), String(opts.quality), String(opts.maxDim)], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout!.on("data", helperFrameReader(handlers.onFrame));
    interactive = true;
  } else {
    const axe = axeBin();
    if (!axe) throw new Error("axe is not installed");
    const scale = Math.min(1, Math.max(0.1, opts.maxDim / 2600));
    child = spawn(axe, ["stream-video", "--udid", udid, "--format", "mjpeg", "--fps", String(Math.min(opts.fps, 10)), "--quality", String(Math.round(opts.quality * 100)), "--scale", scale.toFixed(2)], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", mjpegFrameReader(handlers.onFrame));
  }
  child.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    stderrTail = (stderrTail + text).slice(-2000);
    for (const line of text.split("\n")) {
      const screen = parseScreenLine(line);
      if (screen) handlers.onScreen?.(screen);
    }
  });
  child.on("exit", (code, signal) => {
    if (stopped) return;
    stopped = true;
    handlers.onExit(lastLine(stderrTail) || `stream exited (${signal ?? code})`);
  });
  child.on("error", (err) => {
    if (stopped) return;
    stopped = true;
    handlers.onExit(err.message);
  });
  // A write after the helper died is an EPIPE on the socket, not a crash.
  child.stdin?.on("error", () => {});
  const write = (line: string) => {
    if (!stopped && child.stdin?.writable) child.stdin.write(`${line}\n`);
  };
  return {
    interactive,
    send(line) {
      if (interactive) write(line);
    },
    wake() {
      write("wake");
    },
    stop() {
      if (stopped) return;
      stopped = true;
      child.stdin?.end();
      child.kill("SIGTERM");
    },
  };
}
