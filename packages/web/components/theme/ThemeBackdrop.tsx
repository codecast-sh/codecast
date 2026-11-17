// A mod theme's live scene behind the whole app (contracts/theme.ts
// `backdrop`). The scene runs in its own sandboxed frame, the same
// /mod-host.html every mod runs in, loaded in backdrop mode: the mod's
// `theme.backdrop` hook draws on a full-window canvas there, with no network
// and no answers to `$` calls. The frame sits under every layer of the app
// and takes no input. While it is mounted, the root carries
// `data-theme-backdrop`, and globals.css turns the window's own background
// see-through and paints the theme's tint once, on the layer above the scene.

import { useRef, useState } from "react";
import { MOD_PROTOCOL, type FrameToHost, type HostToFrame } from "@codecast/shared/contracts/mods";
import type { ThemeBackdrop as Backdrop } from "@codecast/shared/contracts/theme";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { modHost, type ModRow } from "../../lib/mods/host";

const ROOT_ATTR = "data-theme-backdrop";
const DEFAULT_TINT = 0.15;

export function ThemeBackdrop({ row, themeId, backdrop, mode }: { row: ModRow; themeId: string; backdrop: Backdrop; mode: "light" | "dark" }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [stopped, setStopped] = useState<string | null>(null);
  const tint = backdrop.tint ?? DEFAULT_TINT;
  const glass = backdrop.glass ?? 0;

  useWatchEffect(() => {
    const root = document.documentElement;
    root.setAttribute(ROOT_ATTR, glass > 0 ? "glass" : "");
    root.style.setProperty("--theme-backdrop-tint", `${Math.round(tint * 1000) / 10}%`);
    root.style.setProperty("--theme-glass", `${glass}px`);
    return () => {
      root.removeAttribute(ROOT_ATTR);
      root.style.removeProperty("--theme-backdrop-tint");
      root.style.removeProperty("--theme-glass");
    };
  }, [tint, glass]);

  useWatchEffect(() => {
    setStopped(null);
    let loads = 0;
    const frame = frameRef.current;
    const log = (level: "log" | "warn" | "error", text: string) => modHost.get(row._id)?.addLog(level, `backdrop: ${text}`);
    const onLoad = () => {
      // The page loads once; a second load means the scene navigated its own frame.
      if (++loads > 1) {
        log("error", "the scene navigated its own frame away, so it was stopped");
        setStopped("navigated");
      }
    };
    const onMessage = (ev: MessageEvent) => {
      if (!frame || ev.source !== frame.contentWindow) return;
      const msg = ev.data as FrameToHost;
      if (!msg || typeof msg.type !== "string") return;
      const post = (m: HostToFrame) => frame.contentWindow?.postMessage(m, "*");
      if (msg.type === "booted") {
        post({
          type: "load", proto: MOD_PROTOCOL, code: row.code, primary: false, backdrop: { theme: themeId },
          mod: { id: row._id, name: row.name, manifest: JSON.parse(JSON.stringify(row.manifest)), context: { user: null, team: null, surface: (window as any).electronAPI ? "desktop" : "web", theme: mode } },
        });
      } else if (msg.type === "log") {
        log(msg.level, msg.text);
      } else if (msg.type === "load-failed") {
        log("error", msg.error);
      } else if (msg.type === "call") {
        // A scene draws; it reads and writes nothing of the person's.
        post({ type: "reply", cid: msg.cid, ok: false, error: "a theme's backdrop draws only; $ is not available to it" });
      }
    };
    frame?.addEventListener("load", onLoad);
    window.addEventListener("message", onMessage);
    return () => {
      frame?.removeEventListener("load", onLoad);
      window.removeEventListener("message", onMessage);
    };
  }, [row._id, row.rev, row.code, themeId, mode]);

  if (stopped) return null;
  return (
    <div className="cc-theme-backdrop" aria-hidden="true">
      <iframe
        key={`${row._id}:${row.rev}:${themeId}:${mode}`}
        ref={frameRef}
        src="/mod-host.html"
        sandbox="allow-scripts"
        tabIndex={-1}
        title={`${row.title || row.name} backdrop`}
      />
    </div>
  );
}
