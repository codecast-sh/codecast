// The app itself: a sandboxed iframe of one version on the runtime origin.
// When the version changes the next iframe preloads underneath, fades in over
// the old one when it loads (or after 4s), and the old one is dropped, so the
// clean link feels like one live app (DESIGN 4.4.5). Every frame gets `init`
// when its SDK says `ready`; picking talks to the frame on top.
import { useEffect, useRef, useState } from "react";
import type { Id } from "../../convex/_generated/dataModel";
import type { ElementRef } from "../../convex/validators";
import { versionPath } from "../../convex/lib/runPaths";
import { RUNTIME_CSP } from "../../convex/lib/runtime";
import { initFor, isAppMessage, postToApp, type PickTheme } from "../../runtime/protocol";
import { avatarUrlsForApps } from "../lib/avatars";
import { RUN_ORIGIN } from "../lib/convex";
import { useIdentity } from "../lib/identity";
import { Blob } from "../ui/Blob";
import s from "./AppFrame.module.css";

const SANDBOX = RUNTIME_CSP.replace(/^sandbox /, "");
const FADE_MS = 280;
const LOAD_CAP_MS = 4000;
const LOADER_DELAY_MS = 400;

type Frame = { key: number; version: number; shown: boolean };

export type AppFrameEvents = {
  onPicked: (element: ElementRef) => void;
  onPickCancelled: () => void;
  onError: (version: number, message: string) => void;
};

export function AppFrame({ slug, appId, version, picking, ...events }: AppFrameEvents & { slug: string; appId: Id<"apps">; version: number; picking: boolean }) {
  const { creds, me } = useIdentity();
  const [frames, setFrames] = useState<Frame[]>(() => [{ key: 0, version, shown: false }]);
  const windows = useRef(new Map<number, HTMLIFrameElement>());
  const seq = useRef(0);
  const [slow, setSlow] = useState(false);
  const live = useRef({ creds, me, appId, picking, events });
  live.current = { creds, me, appId, picking, events };

  // A new version: preload it beside the current one.
  useEffect(() => {
    setFrames((fs) => (fs[fs.length - 1]?.version === version ? fs : [...fs, { key: ++seq.current, version, shown: false }]));
  }, [version]);

  const top = frames.filter((f) => f.shown).at(-1);
  const topKey = useRef<number | null>(null);
  topKey.current = top?.key ?? null;

  const reveal = (key: number) => {
    setFrames((fs) => fs.map((f) => (f.key === key ? { ...f, shown: true } : f)));
    setTimeout(() => setFrames((fs) => {
      const idx = fs.findIndex((f) => f.key === key);
      return idx > 0 ? fs.slice(idx) : fs;
    }), FADE_MS);
  };

  // A newer frame that never loads still takes over after the cap.
  const pendingKey = frames.at(-1)?.shown ? null : frames.at(-1)?.key;
  useEffect(() => {
    if (pendingKey == null) return;
    const t = setTimeout(() => reveal(pendingKey), LOAD_CAP_MS);
    return () => clearTimeout(t);
  }, [pendingKey]);

  useEffect(() => {
    if (top) return setSlow(false);
    const t = setTimeout(() => setSlow(true), LOADER_DELAY_MS);
    return () => clearTimeout(t);
  }, [top]);

  // The protocol: match each message to the frame that sent it.
  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      if (!isAppMessage(e.data)) return;
      const entry = [...windows.current.entries()].find(([, el]) => el.contentWindow === e.source);
      if (!entry) return;
      const [key, el] = entry;
      const target = el.contentWindow!;
      const { creds, me, appId, picking, events } = live.current;
      const msg = e.data;
      if (msg.type === "ready") {
        postToApp(target, await initFor(creds, appId, me, await avatarUrlsForApps()));
        if (picking && key === topKey.current) postToApp(target, { type: "pick", on: true, theme: pickTheme() });
      } else if (msg.type === "picked") events.onPicked(msg.element);
      else if (msg.type === "pick-cancelled") events.onPickCancelled();
      else if (msg.type === "error") {
        const v = frames.find((f) => f.key === key)?.version;
        if (v != null) events.onError(v, msg.message);
      }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [frames]);

  // Picking follows the frame on top.
  useEffect(() => {
    if (top == null) return;
    const w = windows.current.get(top.key)?.contentWindow;
    if (w) postToApp(w, { type: "pick", on: picking, theme: picking ? pickTheme() : undefined });
  }, [picking, top?.key]);

  return (
    <div className={s.stage}>
      {!top && slow && (
        <div className={s.loading}>
          <Blob size={72} squash />
        </div>
      )}
      {frames.map((f) => (
        <iframe
          key={f.key}
          ref={(el) => {
            if (el) windows.current.set(f.key, el);
            else windows.current.delete(f.key);
          }}
          className={`${s.frame} ${f.shown ? s.shown : ""}`}
          src={RUN_ORIGIN + versionPath(slug, f.version)}
          sandbox={SANDBOX}
          allow="clipboard-write; fullscreen; autoplay"
          title={`v${f.version}`}
          onLoad={() => !f.shown && reveal(f.key)}
        />
      ))}
    </div>
  );
}

/** The picker draws with the shell's own tokens so it matches the room. */
function pickTheme(): PickTheme {
  const css = getComputedStyle(document.documentElement);
  return { accent: css.getPropertyValue("--butter").trim(), ink: css.getPropertyValue("--ink").trim(), font: css.getPropertyValue("--mono").trim() };
}
