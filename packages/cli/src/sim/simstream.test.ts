import { describe, expect, test } from "bun:test";
import { buildArgs, helperFrameReader, helperPath, jpegSize, mjpegFrameReader, parseScreenLine, type SimFrame } from "./simstream.js";

/** A minimal JPEG prefix: SOI, an APP0 segment, then a baseline SOF0 giving the size. */
function fakeJpeg(width: number, height: number, tail = 10): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(tail, 0xab)]);
}

function helperFrame(jpeg: Buffer, w: number, h: number): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt32BE(jpeg.length, 0);
  head.writeUInt32BE(w, 4);
  head.writeUInt32BE(h, 8);
  return Buffer.concat([head, jpeg]);
}

describe("helperFrameReader", () => {
  test("frames split across chunks and packed into one come out whole and in order", () => {
    const out: SimFrame[] = [];
    const read = helperFrameReader((f) => out.push(f));
    const a = helperFrame(Buffer.from("first-jpeg"), 589, 1280);
    const b = helperFrame(Buffer.from("second"), 10, 20);
    const all = Buffer.concat([a, b]);
    read(all.subarray(0, 5));
    read(all.subarray(5, a.length + 3));
    expect(out).toHaveLength(1);
    read(all.subarray(a.length + 3));
    expect(out.map((f) => [Buffer.from(f.data, "base64").toString(), f.width, f.height])).toEqual([["first-jpeg", 589, 1280], ["second", 10, 20]]);
  });
});

describe("mjpegFrameReader", () => {
  test("parts of axe's multipart stream become frames sized from their JPEG", () => {
    const out: SimFrame[] = [];
    const read = mjpegFrameReader((f) => out.push(f));
    const jpeg = fakeJpeg(402, 874);
    const part = (j: Buffer) => Buffer.concat([Buffer.from(`--mjpegstream\r\nContent-Type: image/jpeg\r\nContent-Length: ${j.length}\r\n\r\n`), j, Buffer.from("\r\n")]);
    const stream = Buffer.concat([Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=--mjpegstream\r\n\r\n"), part(jpeg), part(jpeg)]);
    for (let i = 0; i < stream.length; i += 7) read(stream.subarray(i, i + 7));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ width: 402, height: 874 });
    expect(Buffer.from(out[1].data, "base64").equals(jpeg)).toBe(true);
  });
});

describe("jpegSize", () => {
  test("reads the start-of-frame marker past other segments", () => {
    expect(jpegSize(fakeJpeg(1206, 2622))).toEqual({ width: 1206, height: 2622 });
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0x00]))).toBeNull();
  });
});

describe("parseScreenLine", () => {
  test("the helper's screen line, and nothing else", () => {
    expect(parseScreenLine("simstream: screen 1206 2622 3.00")).toEqual({ widthPx: 1206, heightPx: 2622, scale: 3 });
    expect(parseScreenLine("simstream: streaming X")).toBeNull();
    expect(parseScreenLine("simstream: screen 0 0 0.00")).toBeNull();
  });
});

describe("building the helper", () => {
  test("links each framework by its Versions/A binary, which Homebrew leaves signed", () => {
    const args = buildArgs("/x/Frameworks", "/t/s.m", "/t/out");
    expect(args).toContain("/x/Frameworks/FBControlCore.framework/Versions/A/FBControlCore");
    expect(args).toContain("/x/Frameworks/FBSimulatorControl.framework/Versions/A/FBSimulatorControl");
    expect(args).toContain("-Wl,-rpath,/x/Frameworks");
    expect(args.some((a) => a.endsWith("FBControlCore.framework/FBControlCore"))).toBe(false);
  });

  test("a different axe install builds a different binary", () => {
    expect(helperPath("/a/Frameworks", "/h")).not.toBe(helperPath("/b/Frameworks", "/h"));
    expect(helperPath("/a/Frameworks", "/h")).toMatch(/^\/h\/\.codecast\/sim\/bin\/simstream-[0-9a-f]{12}$/);
  });
});
