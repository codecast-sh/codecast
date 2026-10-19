import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { heicToJpeg, isHeicImage } from "./heicImage";
import { detectImageMediaType } from "./imagePayload";

const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftyp" + brand, "ascii"), Buffer.alloc(8)]);

describe("heicImage", () => {
  it("knows HEIC by its ftyp brand, not its name", () => {
    expect(isHeicImage(ftyp("heic"))).toBe(true);
    expect(isHeicImage(ftyp("mif1"))).toBe(true);
    expect(isHeicImage(ftyp("avif"))).toBe(false);
    expect(isHeicImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe(false);
  });

  it("falls through converters and reports when none is there", async () => {
    const tried: string[] = [];
    const exec = async (bin: string) => { tried.push(bin); throw new Error("no"); };
    expect(await heicToJpeg("a.heic", "a.jpg", { exec, platform: "linux", which: (n) => (n === "magick" ? "/usr/bin/magick" : null) })).toBe(false);
    expect(tried).toEqual(["/usr/bin/magick"]);
    expect(await heicToJpeg("a.heic", "a.jpg", { exec, platform: "linux", which: () => null })).toBe(false);
  });

  it.skipIf(process.platform !== "darwin")("turns a real HEIC into a JPEG with sips", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heic-"));
    const png = path.join(dir, "in.png");
    // A 2x2 PNG, then the same picture as HEIC (sips writes both).
    fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64"));
    const heic = path.join(dir, "photo.png"); // mislabelled, as older uploads were
    execFileSync("/usr/bin/sips", ["-s", "format", "heic", png, "--out", heic], { stdio: "ignore" });
    expect(isHeicImage(fs.readFileSync(heic))).toBe(true);
    const jpg = path.join(dir, "photo.jpg");
    expect(await heicToJpeg(heic, jpg)).toBe(true);
    expect(detectImageMediaType(fs.readFileSync(jpg))).toBe("image/jpeg");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
