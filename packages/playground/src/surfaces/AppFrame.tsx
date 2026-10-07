// The app itself: sandboxed iframes of versions on the runtime origin. The
// version on screen is one frame; the versions you are likely to see next
// (the timeline's neighbors, the one you hover) load beside it out of sight,
// so stepping through time shows each one at once. A version comes on top
// once its SDK says it has painted with its data (or after 4s), fading in
// over the one before, which goes out of sight when the fade is done (DESIGN
// 4.4.5). Every frame gets `init` once per page it loads, when its SDK says
// `ready`, and a fresh token before the last one runs out; only the live
// version's frame can write, every other one is looking only. A frame that
// navigates itself somewhere else is sent back to its version before it hears
// from the shell again. Picking, the spotlight and errors follow the frame on
// top.
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { Id } from "../../convex/_generated/dataModel";
import type { ElementRef } from "../../convex/validators";
import { versionPath } from "../../convex/lib/runPaths";
import { RUNTIME_CSP } from "../../convex/lib/runtime";
import { RUNTIME_TOKEN_RENEW_MS, runtimeTokenForSecret, type TokenScope } from "../../convex/lib/identity";
import { initFor, isAppMessage, postToApp, type PickTheme } from "../../runtime/protocol";
import { avatarUrlsForApps } from "../lib/avatars";
import { RUN_ORIGIN } from "../lib/convex";
import { useIdentity } from "../lib/identity";
import { appLink } from "../lib/router";
import { Blob } from "../ui/Blob";
import s from "./AppFrame.module.css";

const SANDBOX = RUNTIME_CSP.replace(/^sandbox /, "");
const FADE_MS = 280;
/** The old frame stays under the new one this long past the fade. */
const FADE_SETTLE_MS = 120;
const SPOTLIT_WAIT_MS = 600;
const LOAD_CAP_MS = 4000;
const LOADER_DELAY_MS = 400;

type Frame = { key: number; version: number; painted: boolean };

export type AppFrameEvents = {
  onPicked: (element: ElementRef) => void;
  onPickCancelled: () => void;
  onError: (version: number, message: string) => void;
  /** A version is on screen now (its fade-in has started). */
  onShown: (version: number) => void;
  /** The app on screen tried to write while looking only. */
  onRefused: () => void;
};

export type AppFrameHandle = {
  /** Ring the elements `selector` matches in the frame on top; false when
   *  none is on screen there. */
  spotlight(selector: string): Promise<boolean>;
};

export function AppFrame({
  slug,
  name,
  appId,
  version,
  live: liveVersion,
  preload = [],
  picking,
  ref,
  ...events
}: AppFrameEvents & {
  slug: string;
  /** The app's name, for its SDK's `app`. */
  name: string;
  appId: Id<"apps">;
  /** The version to show. */
  version: number;
  /** The live version: the only one whose frame may write. */
  live: number;
  /** Versions to have ready out of sight. */
  preload?: number[];
  picking: boolean;
  ref?: Ref<AppFrameHandle>;
}) {
  const { creds, me } = useIdentity();
  const [frames, setFrames] = useState<Frame[]>(() => [{ key: 0, version, painted: false }]);
  const [top, setTop] = useState<number | null>(null);
  const [under, setUnder] = useState<number | null>(null);
  const windows = useRef(new Map<number, HTMLIFrameElement>());
  // Per frame: pages loaded, and whether the page now in it was answered.
  // A second load means the frame went somewhere on its own: it is pointed
  // back at its version, and nothing is answered until that page loads.
  const loads = useRef(new Map<number, number>());
  const answered = useRef(new Set<number>());
  const seq = useRef(0);
  const spotlit = useRef<((found: boolean) => void) | null>(null);
  const [slow, setSlow] = useState(false);
  const scopeOf = (v: number): TokenScope => (v === live.current.liveVersion ? "use" : "watch");
  const live = useRef({ creds, me, appId, name, picking, events, liveVersion });
  live.current = { creds, me, appId, name, picking, events, liveVersion };

  // The frames wanted now: the version to show and the ones to have ready.
  // Any other goes, unless it is on screen or fading out under it.
  const wantKey = [version, ...preload].join(",");
  useEffect(() => {
    const wanted = new Set([version, ...preload]);
    setFrames((fs) => {
      const kept = fs.filter((f) => wanted.has(f.version) || f.key === top || f.key === under);
      const missing = [...wanted].filter((v) => !kept.some((f) => f.version === v));
      const next = [...kept, ...missing.map((v) => ({ key: ++seq.current, version: v, painted: false }))];
      return next.length === fs.length && next.every((f, i) => f === fs[i]) ? fs : next;
    });
  }, [wantKey, top, under]);

  const target = frames.find((f) => f.version === version);
  const topKey = useRef<number | null>(null);
  topKey.current = top;

  // The version to show comes on top as soon as it has painted.
  const show = (key: number) => {
    if (key === topKey.current) return;
    const frame = frames.find((f) => f.key === key);
    if (frame) live.current.events.onShown(frame.version);
    setUnder(topKey.current);
    setTop(key);
  };
  useEffect(() => {
    if (target?.painted) show(target.key);
  }, [target?.key, target?.painted]);
  // A version that never paints still comes on top after the cap.
  useEffect(() => {
    if (!target || target.painted || target.key === top) return;
    const t = setTimeout(() => show(target.key), LOAD_CAP_MS);
    return () => clearTimeout(t);
  }, [target?.key, target?.painted, top]);
  // The one it covered goes out of sight once the fade is done.
  useEffect(() => {
    if (under === null) return;
    const t = setTimeout(() => setUnder(null), FADE_MS + FADE_SETTLE_MS);
    return () => clearTimeout(t);
  }, [under, top]);

  useImperativeHandle(ref, () => ({
    spotlight: (selector) =>
      new Promise((resolve) => {
        const w = topKey.current === null ? null : windows.current.get(topKey.current)?.contentWindow;
        if (!w) return resolve(false);
        spotlit.current?.(false);
        const timer = setTimeout(() => answer(false), SPOTLIT_WAIT_MS);
        const answer = (found: boolean) => {
          clearTimeout(timer);
          spotlit.current = null;
          resolve(found);
        };
        spotlit.current = answer;
        postToApp(w, { type: "spotlight", selector, color: cssVar("--live") });
      }),
  }), []);

  useEffect(() => {
    if (top !== null) {
      setSlow(false);
      return;
    }
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
      const { creds, me, appId, name, picking, events } = live.current;
      const msg = e.data;
      const version = frames.find((f) => f.key === key)?.version;
      if (msg.type === "ready") {
        if (version == null || answered.current.has(key) || (loads.current.get(key) ?? 0) > 1) return;
        answered.current.add(key);
        postToApp(target, await initFor({ creds, appId, version, visitor: me, avatars: await avatarUrlsForApps(), app: appLink(slug, name), scope: scopeOf(version) }));
        if (picking && key === topKey.current) postToApp(target, { type: "pick", on: true, theme: pickTheme() });
      } else if (msg.type === "painted") {
        if ((loads.current.get(key) ?? 0) < 2) setFrames((fs) => fs.map((f) => (f.key === key && !f.painted ? { ...f, painted: true } : f)));
      } else if (key !== topKey.current) {
        // Out of sight: nothing else it says is about what you see.
      } else if (msg.type === "spotlit") spotlit.current?.(msg.found);
      else if (msg.type === "picked") events.onPicked(msg.element);
      else if (msg.type === "pick-cancelled") events.onPickCancelled();
      else if (msg.type === "refused") events.onRefused();
      else if (msg.type === "error") {
        if (version != null) events.onError(version, msg.message);
      }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [frames]);

  // Each answered frame gets a fresh token well before its last one
  // expires, and at once when the live version moves, so a frame that stops
  // being live stops writing.
  const sendTokens = () => {
    const { creds, appId } = live.current;
    for (const f of frames) {
      const w = answered.current.has(f.key) ? windows.current.get(f.key)?.contentWindow : null;
      if (w) void runtimeTokenForSecret(creds.secret, appId, f.version, Date.now(), scopeOf(f.version)).then((token) => postToApp(w, { type: "token", token }));
    }
  };
  useEffect(() => {
    const t = setInterval(sendTokens, RUNTIME_TOKEN_RENEW_MS);
    return () => clearInterval(t);
  }, [frames]);
  const tokensFor = useRef(liveVersion);
  useEffect(() => {
    if (tokensFor.current === liveVersion) return;
    tokensFor.current = liveVersion;
    sendTokens();
  }, [liveVersion]);

  const onLoad = (f: Frame, el: HTMLIFrameElement) => {
    const n = (loads.current.get(f.key) ?? 0) + 1;
    if (n === 1 || n === 3) {
      // Its own page: the first load, or the load after being sent back. It
      // is revealed when its SDK says it has painted.
      loads.current.set(f.key, 1);
      return;
    }
    loads.current.set(f.key, 2);
    answered.current.delete(f.key);
    setFrames((fs) => fs.map((g) => (g.key === f.key ? { ...g, painted: false } : g)));
    el.src = frameUrl(slug, f.version);
  };

  // Picking follows the frame on top.
  useEffect(() => {
    if (top == null) return;
    const w = windows.current.get(top)?.contentWindow;
    if (w) postToApp(w, { type: "pick", on: picking, theme: picking ? pickTheme() : undefined });
  }, [picking, top]);

  return (
    <div className={s.stage}>
      {top === null && slow && (
        <div className={s.loading}>
          <Blob size={28} faint />
        </div>
      )}
      {frames.map((f) => (
        <iframe
          key={f.key}
          ref={(el) => {
            if (el) windows.current.set(f.key, el);
            else {
              windows.current.delete(f.key);
              loads.current.delete(f.key);
              answered.current.delete(f.key);
            }
          }}
          className={`${s.frame} ${f.key === top ? s.top : f.key === under ? s.under : ""}`}
          inert={f.key !== top}
          aria-hidden={f.key !== top}
          src={frameUrl(slug, f.version)}
          sandbox={SANDBOX}
          allow="clipboard-write; fullscreen; autoplay"
          title={`${name}, v${f.version}, ${f.version === liveVersion ? "live" : "looking only"}`}
          onLoad={(e) => onLoad(f, e.currentTarget)}
        />
      ))}
    </div>
  );
}

const frameUrl = (slug: string, version: number) => RUN_ORIGIN + versionPath(slug, version);

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** The picker draws with the shell's own tokens so it matches the room. */
function pickTheme(): PickTheme {
  return { accent: cssVar("--accent"), ink: cssVar("--ink"), font: cssVar("--mono") };
}
