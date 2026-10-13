/**
 * Viewport arguments and the multi-viewport capture loop.
 *
 * The loop's contract is what the tests pin: every listed viewport is applied
 * in order, and the tab ALWAYS leaves the way it arrived — pinned emulation
 * restored, or cleared back to the real window — even when a capture throws.
 * The shared browser makes that non-negotiable: a shot command that strands
 * the tab at mobile width breaks the next agent's clicks.
 *
 * The loop runs against `ViewportCapture`, so a fake with five methods is the
 * whole harness — the same surface a new engine adapter has to supply.
 */

import { describe, expect, test } from "bun:test";
import { DEVICES, type DeviceProfile } from "./actions.js";
import type { PageSession } from "./instance.js";
import {
  captureAtViewports, eachViewport, pageViewportCapture, parseViewport, parseViewportList, runViewportRow,
  viewportLabel, type ViewportCapture,
} from "./viewports.js";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

/** A capability that records what was asked of it. */
function fakeCapture(opts: { failOn?: string } = {}) {
  const log: string[] = [];
  const evals: string[] = [];
  const cap: ViewportCapture = {
    setViewport: async (d: DeviceProfile) => { log.push(`set:${d.width}`); },
    clearViewport: async () => { log.push("clear"); },
    settle: async () => { log.push("settle"); },
    evaluate: async (js: string) => { evals.push(js); return undefined; },
    screenshot: async () => {
      const last = log.filter((l) => l.startsWith("set:")).pop();
      if (opts.failOn && last === `set:${opts.failOn}`) throw new Error("capture failed");
      log.push("shot");
      return Buffer.from(last ?? "");
    },
  };
  return { cap, log, evals };
}

describe("parseViewport", () => {
  test("resolves a preset by name", () => {
    const vp = parseViewport("mobile");
    expect(vp?.name).toBe("mobile");
    expect(vp?.device).toBe(DEVICES.mobile);
  });

  test("resolves an explicit WxH as a plain desktop screen", () => {
    const vp = parseViewport("1024x768");
    expect(vp?.device).toEqual({ width: 1024, height: 768, scale: 1, mobile: false });
  });

  test("rejects anything else", () => {
    expect(parseViewport("phablet")).toBeNull();
    expect(parseViewport("1024x")).toBeNull();
    expect(parseViewport("")).toBeNull();
  });
});

describe("parseViewportList", () => {
  test("keeps order, trims whitespace, drops duplicates", () => {
    const names = parseViewportList("desktop, mobile,desktop,1024x768").map((v) => v.name);
    expect(names).toEqual(["desktop", "mobile", "1024x768"]);
  });

  test("names the offending entry", () => {
    expect(() => parseViewportList("desktop,phablet")).toThrow("unknown viewport 'phablet'");
  });

  test("rejects an empty list", () => {
    expect(() => parseViewportList(" , ")).toThrow("no viewports given");
  });
});

describe("viewportLabel", () => {
  test("names presets with their size, and explicit sizes as themselves", () => {
    expect(viewportLabel(parseViewport("mobile")!)).toBe("mobile 390×844");
    expect(viewportLabel(parseViewport("1024x768")!)).toBe("1024x768");
  });
});

describe("eachViewport", () => {
  const list = parseViewportList("desktop,mobile");

  test("applies each viewport in order and captures at it", async () => {
    const { cap, log } = fakeCapture();
    const seen: string[] = [];
    await eachViewport(cap, list, undefined, async (vp) => { seen.push(vp.name); });
    expect(seen).toEqual(["desktop", "mobile"]);
    expect(log.filter((l) => l.startsWith("set:"))).toEqual([`set:${DEVICES.desktop.width}`, `set:${DEVICES.mobile.width}`]);
  });

  test("clears emulation afterwards when the tab had none", async () => {
    const { cap, log } = fakeCapture();
    await eachViewport(cap, list, undefined, async () => {});
    expect(log[log.length - 1]).toBe("clear");
  });

  test("restores the tab's pinned viewport afterwards", async () => {
    const { cap, log } = fakeCapture();
    await eachViewport(cap, list, DEVICES.tablet, async () => {});
    expect(log[log.length - 1]).toBe(`set:${DEVICES.tablet.width}`);
  });

  test("restores even when a capture throws, and rethrows", async () => {
    const { cap, log } = fakeCapture();
    await expect(
      eachViewport(cap, list, DEVICES.tablet, async (vp) => {
        if (vp.name === "mobile") throw new Error("capture failed");
      }),
    ).rejects.toThrow("capture failed");
    expect(log[log.length - 1]).toBe(`set:${DEVICES.tablet.width}`);
  });
});

describe("captureAtViewports", () => {
  const list = parseViewportList("desktop,mobile");

  test("returns one labelled shot per viewport, in order, taken after settling", async () => {
    const { cap, log } = fakeCapture();
    const shots = await captureAtViewports(cap, list, undefined, { format: "png" });
    expect(shots.map((s) => s.vp.name)).toEqual(["desktop", "mobile"]);
    expect(shots.map((s) => s.label)).toEqual(["desktop 1440×900", "mobile 390×844"]);
    expect(shots.map((s) => s.bytes.toString())).toEqual([`set:${DEVICES.desktop.width}`, `set:${DEVICES.mobile.width}`]);
    // set → settle → shot, per viewport, then the restore.
    expect(log).toEqual(["set:1440", "settle", "shot", "set:390", "settle", "shot", "clear"]);
  });

  test("stamps the label into the page for the capture and removes it after", async () => {
    const { cap, evals } = fakeCapture();
    await captureAtViewports(cap, list, undefined, { format: "png" });
    // Two evals per viewport: label on, label off. The chip must never
    // survive into the page the next command sees.
    expect(evals).toHaveLength(4);
    expect(evals[0]).toContain('"desktop 1440×900"');
    expect(evals[1]).toContain("const label = null");
    expect(evals[2]).toContain('"mobile 390×844"');
    expect(evals[3]).toContain("const label = null");
  });

  test("removes the label and restores the viewport when the screenshot throws", async () => {
    const { cap, log, evals } = fakeCapture({ failOn: String(DEVICES.mobile.width) });
    await expect(captureAtViewports(cap, list, DEVICES.tablet, { format: "png" })).rejects.toThrow("capture failed");
    expect(evals[evals.length - 1]).toContain("const label = null");
    expect(log[log.length - 1]).toBe(`set:${DEVICES.tablet.width}`);
  });
});

describe("runViewportRow format", () => {
  // The engine path has no --jpeg flag; the --out extension carries the format.
  const shotFormats = () => {
    const formats: string[] = [];
    const cap: ViewportCapture = {
      setViewport: async () => {},
      clearViewport: async () => {},
      settle: async () => {},
      evaluate: async () => undefined,
      screenshot: async (opts) => { formats.push(opts.format ?? "png"); return Buffer.from("x"); },
    };
    return { cap, formats };
  };

  test("a .jpg --out means JPEG capture even without --jpeg", async () => {
    const { cap, formats } = shotFormats();
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vp-")), "row.jpg");
    await runViewportRow(cap, "desktop", undefined, { out, inline: false }, {} as any);
    expect(formats).toEqual(["jpeg"]);
    expect(fs.existsSync(path.join(path.dirname(out), "row-desktop.jpg"))).toBe(true);
  });

  test("no hint at all means PNG", async () => {
    const { cap, formats } = shotFormats();
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vp-")), "row.png");
    await runViewportRow(cap, "desktop", undefined, { out, inline: false }, {} as any);
    expect(formats).toEqual(["png"]);
  });
});

describe("pageViewportCapture (built-in driver adapter)", () => {
  test("drives device emulation and capture through CDP", async () => {
    const calls: string[] = [];
    const page = {
      sessionId: "s1",
      targetId: "t1",
      conn: {
        send: async (method: string) => {
          calls.push(method);
          if (method === "Runtime.evaluate") return { result: { value: 10000 } };
          if (method === "Page.captureScreenshot") return { data: Buffer.from("png").toString("base64") };
          return {};
        },
      },
    } as unknown as PageSession;
    const cap = pageViewportCapture(page);
    await cap.setViewport(DEVICES.mobile);
    expect(calls).toContain("Emulation.setDeviceMetricsOverride");
    expect((await cap.screenshot({ format: "png" })).toString()).toBe("png");
    await cap.clearViewport();
    expect(calls).toContain("Emulation.clearDeviceMetricsOverride");
  });
});
