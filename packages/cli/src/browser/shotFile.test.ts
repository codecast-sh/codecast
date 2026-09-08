/**
 * Screenshots on disk: where they go, who can read them, and how `--json`
 * describes one (ct-49556).
 *
 * The mode is the security claim — a capture shows whatever the page showed,
 * and it used to land in a world-readable /tmp. The size reader is what lets
 * `shot --json` report width and height without a second round trip to the
 * browser, and without ever putting the image itself in the output.
 *
 * CODECAST_DIR is redirected throughout, so nothing here touches the real
 * ~/.codecast.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultShotPath, imageSize, shotJson, writeShotFile } from "./shotFile.js";
import { TEMP_FILE_MODE } from "../tempFiles.js";

let home: string;
let priorDir: string | undefined;

beforeEach(() => {
  priorDir = process.env.CODECAST_DIR;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-shotfile-test-"));
  process.env.CODECAST_DIR = path.join(home, ".codecast");
});

afterEach(() => {
  if (priorDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = priorDir;
  fs.rmSync(home, { recursive: true, force: true });
});

/** A 2x3 PNG, header only — enough for the size reader, which never decodes. */
function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe("defaultShotPath", () => {
  test("lands in our own 0700 directory, not /tmp", () => {
    const file = defaultShotPath("png");
    expect(file.startsWith(path.join(process.env.CODECAST_DIR!, "tmp", "shots"))).toBe(true);
    // The old default dropped the file straight into the shared temp dir.
    expect(path.dirname(file)).not.toBe(os.tmpdir());
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  test("the extension follows the format", () => {
    expect(defaultShotPath("jpg").endsWith(".jpg")).toBe(true);
    expect(defaultShotPath("png").endsWith(".png")).toBe(true);
  });
});

describe("writeShotFile", () => {
  test("writes the picture owner-only", () => {
    const out = defaultShotPath("png");
    writeShotFile(png(4, 2), out, { inline: false, quiet: true });
    expect(fs.statSync(out).mode & 0o777).toBe(TEMP_FILE_MODE);
  });

  test("tightens a file that already existed with a looser mode", () => {
    const out = defaultShotPath("png");
    fs.writeFileSync(out, "stale");
    fs.chmodSync(out, 0o666);
    writeShotFile(png(4, 2), out, { inline: false, quiet: true });
    expect(fs.statSync(out).mode & 0o777).toBe(TEMP_FILE_MODE);
  });
});

describe("imageSize", () => {
  test("reads a PNG header", () => {
    expect(imageSize(png(1440, 900))).toEqual({ width: 1440, height: 900 });
  });

  test("reads a JPEG frame header", () => {
    // SOI, one APP0 segment to skip, then SOF0 carrying 300x200.
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xc8, 0x01, 0x2c]),
      Buffer.alloc(16),
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 300, height: 200 });
  });

  test("says nothing rather than guessing at bytes it cannot read", () => {
    expect(imageSize(Buffer.from("not an image"))).toBeNull();
  });
});

describe("shot --json", () => {
  test("the file and its size, with an absolute path", () => {
    const out = defaultShotPath("png");
    expect(shotJson({ file: out, bytes: 4096, size: { width: 2880, height: 1800 }, scale: 2 })).toEqual({
      path: path.resolve(out),
      width: 2880,
      height: 1800,
      scale: 2,
      bytes: 4096,
    });
  });

  test("a size or scale we could not read is null, not a guess", () => {
    const json = shotJson({ file: "shot.png", bytes: 0, size: null, scale: null });
    expect(json.width).toBeNull();
    expect(json.height).toBeNull();
    expect(json.scale).toBeNull();
  });

  test("annotations and a shared URL appear only when there are any", () => {
    const bare = shotJson({ file: "shot.png", bytes: 1, size: null, scale: null });
    expect("annotations" in bare).toBe(false);
    expect("url" in bare).toBe(false);
    const full = shotJson({
      file: "shot.png",
      bytes: 1,
      size: null,
      scale: null,
      annotations: [{ number: 1, ref: "e1", role: "link", name: "Learn more" }],
      url: "https://codecast.sh/i/abc",
    });
    expect(full.url).toBe("https://codecast.sh/i/abc");
    expect(full.annotations).toEqual([{ number: 1, ref: "e1", role: "link", name: "Learn more" }]);
  });

  test("the image itself never travels in the JSON", () => {
    // The whole point of the flag: a path, not several thousand tokens of
    // base64 that the conversation cannot render anyway.
    const out = defaultShotPath("png");
    writeShotFile(png(8, 8), out, { inline: false, quiet: true });
    const json = JSON.stringify(shotJson({
      file: out,
      bytes: fs.statSync(out).size,
      size: imageSize(fs.readFileSync(out)),
      scale: 2,
    }));
    expect(json).not.toContain("base64");
    expect(json).not.toContain("data:image");
    expect(json).not.toContain("iVBOR"); // how a base64 PNG begins
    expect(json.length).toBeLessThan(400);
  });
});
