// Device emulation for a page: the viewport presets and the CDP overrides that
// apply and drop them.

import type { PageSession } from "./instance.js";

/** A device preset: viewport, pixel density, touch, and user agent. */
export interface DeviceProfile {
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
  userAgent?: string;
}

// Enough to cover the breakpoints frontend work actually targets. Names are
// what a developer would say out loud rather than model numbers.
export const DEVICES: Record<string, DeviceProfile> = {
  desktop: { width: 1440, height: 900, scale: 1, mobile: false },
  laptop: { width: 1280, height: 800, scale: 2, mobile: false },
  wide: { width: 1920, height: 1080, scale: 1, mobile: false },
  tablet: {
    width: 820, height: 1180, scale: 2, mobile: true,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  mobile: {
    width: 390, height: 844, scale: 3, mobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "mobile-small": {
    width: 320, height: 568, scale: 2, mobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
};

/**
 * Resize the viewport, optionally emulating a device.
 *
 * This overrides the metrics the PAGE sees rather than resizing the OS window,
 * so it works headless, it is exact (a real window carries chrome and is
 * subject to the display size), and it can emulate a density and a touch
 * screen that the machine does not have. That is what makes it useful for
 * checking a layout at a breakpoint: media queries, `innerWidth` and
 * `devicePixelRatio` all report the emulated values.
 */
export async function setViewport(page: PageSession, d: DeviceProfile): Promise<void> {
  const { conn, sessionId } = page;

  // The window's CONTENT area must be at least as wide as the viewport we are
  // emulating, or Chrome scales the rendering to fit and input stops following.
  //
  // When the emulated width exceeds the content area, `elementFromPoint`
  // answers in emulated space while `Input.dispatchMouseEvent` is routed
  // through window space. The occlusion check passes and the click still lands
  // somewhere else. Measured on Hacker News: a click aimed at [43,30] was
  // delivered at [107,75] — 2.5x out, exactly the ratio of the 390px emulated
  // width to the 156px content area — and opened an unrelated story while
  // reporting success.
  //
  // The content width has to be MEASURED, not derived from the window bounds:
  // those are in display units, and with any display scaling a 1440-wide
  // window can have a 156px content area. So clear any override, read the real
  // width, and grow until it fits. Only ever grow — shrinking to match a small
  // device is what caused the bug in the first place.
  try {
    const realWidth = async (): Promise<number> => {
      const r = await conn.send<any>(
        "Runtime.evaluate",
        { expression: "innerWidth", returnByValue: true },
        sessionId,
        2000,
      );
      return Number(r.result?.value) || 0;
    };
    await conn.send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const have = await realWidth();
      if (have >= d.width) break;
      const { windowId, bounds } = await conn.send<any>("Browser.getWindowForTarget", { targetId: page.targetId });
      if (!windowId || bounds?.windowState === "minimized") break;
      // Scale the window by the shortfall rather than setting an absolute size,
      // which is the only way to be right without knowing the display scaling.
      const grown = Math.ceil((bounds.width || d.width) * (d.width / Math.max(have, 1)) * 1.05);
      await conn.send("Browser.setWindowBounds", {
        windowId,
        bounds: { width: Math.min(grown, 4000), height: Math.max(bounds.height || 0, 900) },
      });
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch {
    // Headless has no window; there the emulated size IS the rendering size.
  }

  await conn.send(
    "Emulation.setDeviceMetricsOverride",
    {
      width: d.width,
      height: d.height,
      deviceScaleFactor: d.scale,
      mobile: d.mobile,
      screenWidth: d.width,
      screenHeight: d.height,
    },
    sessionId,
  );
  // Touch changes real behaviour: hover-only menus never open, and libraries
  // branch on it. Emulating the size without it gives a misleading picture.
  await conn
    .send("Emulation.setTouchEmulationEnabled", { enabled: d.mobile, maxTouchPoints: d.mobile ? 5 : 0 }, sessionId)
    .catch(() => {});
  if (d.userAgent) {
    await conn.send("Emulation.setUserAgentOverride", { userAgent: d.userAgent }, sessionId).catch(() => {});
  }
}

/** Drop every emulation override, back to the real window. */
export async function clearViewport(page: PageSession): Promise<void> {
  const { conn, sessionId } = page;
  await conn.send("Emulation.clearDeviceMetricsOverride", {}, sessionId).catch(() => {});
  await conn.send("Emulation.setTouchEmulationEnabled", { enabled: false }, sessionId).catch(() => {});
  await conn.send("Emulation.setUserAgentOverride", { userAgent: "" }, sessionId).catch(() => {});
}
