// A cloud host's whole display in a pane: the windows, dialogs, file pickers
// and popups that live outside the agent's tab and so never reach the stream.
//
// The host serves its Xvfb as VNC behind websockify on its own loopback; this
// machine's daemon forwards that port (packages/cli/src/cloud/hostForward.ts)
// and noVNC's RFB client draws it here, inside the pane's own chrome. noVNC's
// page is deliberately not used: its floating control bar and status strip
// are a second UI inside ours. The pane strip carries the verbs instead.

import { useCallback, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { ClipboardPaste, RotateCw } from "lucide-react";
import { HOST_NOVNC_PORT } from "@codecast/shared/contracts";
import { forwardHostPort } from "../../../lib/terminal/endpoint";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import type { BackendProps, PaneStripAction } from "./types";

type Rfb = import("@novnc/novnc").default;

const UNREACHABLE =
  "The host's screen opens through the laptop that manages the host. Open this pane in codecast on that laptop, with its daemon running.";

export function ScreenBackend({ source, reloadToken, onTitle, onState, onActions }: BackendProps) {
  const deviceId = source.kind === "screen" ? source.deviceId : "";
  const convex = useConvex();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<Rfb | null>(null);
  const [retry, setRetry] = useState(0);
  const reconnect = useCallback(() => setRetry((n) => n + 1), []);

  useWatchEffect(() => {
    let cancelled = false;
    let rfb: Rfb | null = null;
    onState({ kind: "loading" });
    onTitle("Host screen");
    (async () => {
      const port = await forwardHostPort(convex, deviceId, HOST_NOVNC_PORT);
      if (cancelled) return;
      if (port === null) {
        onState({ kind: "error", message: UNREACHABLE });
        return;
      }
      const { default: RFB } = await import("@novnc/novnc");
      if (cancelled || !hostRef.current) return;
      rfb = new RFB(hostRef.current, `ws://127.0.0.1:${port}/`, { shared: true });
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.focusOnClick = true;
      rfb.showDotCursor = true;
      rfb.background = "transparent";
      rfbRef.current = rfb;
      rfb.addEventListener("connect", () => { if (!cancelled) onState({ kind: "ready", opaque: false }); });
      rfb.addEventListener("disconnect", (e) => {
        if (cancelled) return;
        rfbRef.current = null;
        const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean;
        onState({
          kind: "error",
          message: clean ? "The host's screen closed." : "Lost the host's screen: the host went to sleep, or the forward through this laptop dropped.",
        });
      });
      rfb.addEventListener("securityfailure", () => {
        if (!cancelled) onState({ kind: "error", message: "The host's VNC server refused the connection." });
      });
    })().catch((err) => {
      if (!cancelled) onState({ kind: "error", message: "Could not open the host's screen.", detail: String((err as Error)?.message ?? err) });
    });
    return () => {
      cancelled = true;
      rfbRef.current = null;
      rfb?.disconnect();
    };
  }, [convex, deviceId, reloadToken, retry, onState, onTitle]);

  // Paste is the one thing a person can't do across the wire by typing: it
  // hands the host your clipboard, then Ctrl+V lands it in whatever is focused.
  const paste = useCallback(() => {
    void navigator.clipboard?.readText().then((text) => {
      if (!text) return;
      rfbRef.current?.clipboardPasteFrom(text);
      rfbRef.current?.focus();
    }).catch(() => {});
  }, []);

  useWatchEffect(() => {
    if (!onActions) return;
    const actions: PaneStripAction[] = [
      { icon: <RotateCw className="w-3 h-3" />, label: "Reconnect to the host's screen", card: "Reconnect", onClick: reconnect },
      { icon: <ClipboardPaste className="w-3 h-3" />, label: "Send your clipboard to the host, then press Ctrl+V there", onClick: paste },
    ];
    onActions(actions);
    return () => onActions([]);
  }, [onActions, reconnect, paste]);

  return <div ref={hostRef} className="absolute inset-0 bg-sol-bg-inset overflow-hidden" />;
}
