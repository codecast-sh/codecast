// The app itself: sandboxed iframes of versions on the runtime origin. The
// version on screen is one frame; the versions you are likely to see next
// (the timeline's neighbors, the one you hover) load beside it out of sight,
// so stepping through time shows each one at once. A version comes on top
// once its SDK says it has painted with its data (or after 4s), fading in
// over the one before, which goes out of sight when the fade is done (DESIGN
// 4.4.5). Every frame gets `init` once per page it loads, when its SDK says
// `ready` and the shell knows who you are (until then `hold`, so the app
// waits rather than starting without its data), and a fresh token before the
// last one runs out; only the live version's frame can write, every other
// one is looking only. A frame that navigates itself somewhere else is sent
// back to where it started before it hears from the shell again. Picking,
// the spotlight and errors follow the frame on top. A version whose page
// loads without its SDK ever saying `ready` (an import that failed, a
// network that refused it) never comes on top: the page is told it failed
// and offers a way out.
//
// The first frame can start from the link alone, before the app or the
// visitor is known: it opens the app's live link, and learns which version
// that is from its SDK's `ready`.
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { Id } from "../../convex/_generated/dataModel";
import type { PublicVisitor, VisitorCredentials } from "../../convex/visitors";
import type { ElementRef } from "../../convex/validators";
import { livePath, versionPath } from "../../convex/lib/runPaths";
import { RUNTIME_CSP } from "../../convex/lib/runtime";
import { RUNTIME_TOKEN_RENEW_MS, runtimeTokenForSecret, type TokenScope } from "../../convex/lib/identity";
import { initFor, isAppMessage, postToApp, type PickTheme } from "../../runtime/protocol";
import { avatarUrlsForApps } from "../lib/avatars";
import { RUN_ORIGIN } from "../lib/convex";
import { useAfter } from "../lib/useAfter";
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
/** Past this, the loader says the app is still on its way. */
const STILL_LOADING_MS = 6000;
/** A page that loaded and has not said `ready` this long after did not start. */
const READY_GRACE_MS = 1500;
/** A page that has not even loaded by now is not coming. */
const LOAD_GIVE_UP_MS = 20000;

type Frame = {
  key: number;
  /** Null for a page opened at the live link until it says which it is. */
  version: number | null;
  /** Where it was pointed, kept so relabeling it never reloads it. */
  src: string;
  /** Its SDK said `ready`. */
  ready: boolean;
  /** It has its `init`. */
  inited: boolean;
  painted: boolean;
  /** Its page never started; the last error it reported before, if any. */
  failed: { error: string | null } | null;
  /** An error it reported before its SDK said ready. */
  bootError?: string;
};

const newFrame = (key: number, version: number | null, slug: string): Frame => ({
  key,
  version,
  src: RUN_ORIGIN + (version === null ? livePath(slug) : versionPath(slug, version)),
  ready: false,
  inited: false,
  painted: false,
  failed: null,
});

/** The version on screen did not load. */
export type FailedFrame = { version: number; error: string | null; retry: () => void };

export type AppFrameEvents = {
  onPicked: (element: ElementRef) => void;
  onPickCancelled: () => void;
  onError: (version: number, message: string) => void;
  /** A version is on screen now (its fade-in has started). */
  onShown: (version: number) => void;
  /** The app on screen tried to write while looking only. */
  onRefused: () => void;
  /** The version on screen did not load, or did after all (null). */
  onFailed: (failed: FailedFrame | null) => void;
};

/** Who the frames speak for, once known: what `init` is made of. */
export type FrameSession = { creds: VisitorCredentials; me: PublicVisitor; appId: Id<"apps">; name: string };

export type AppFrameHandle = {
  /** Ring the elements `selector` matches in the frame on top; false when
   *  none is on screen there. */
  spotlight(selector: string): Promise<boolean>;
};

export type AppFrameProps = {
  slug: string;
  /** The version to show; null for whatever is live, before that is known. */
  version: number | null;
  /** The live version, the only one whose frame may write; null until known. */
  live: number | null;
  /** Versions to have ready out of sight. */
  preload?: number[];
  picking?: boolean;
  session: FrameSession | null;
  events?: AppFrameEvents;
  ref?: Ref<AppFrameHandle>;
};

export function AppFrame({ slug, version, live: liveVersion, preload = NONE, picking = false, session, events, ref }: AppFrameProps) {
  const [frames, setFrames] = useState<Frame[]>(() => [newFrame(0, version, slug)]);
  const [top, setTop] = useState<number | null>(null);
  const [under, setUnder] = useState<number | null>(null);
  const windows = useRef(new Map<number, HTMLIFrameElement>());
  // Per frame: pages loaded, and whether the page now in it was answered.
  // A second load means the frame went somewhere on its own: it is pointed
  // back where it started, and nothing is answered until that page loads.
  const loads = useRef(new Map<number, number>());
  const answered = useRef(new Set<number>());
  const seq = useRef(0);
  const spotlit = useRef<((found: boolean) => void) | null>(null);
  const [slow, setSlow] = useState(false);
  const live = useRef({ session, picking, events, liveVersion, frames });
  live.current = { session, picking, events, liveVersion, frames };
  const scopeOf = (v: number): TokenScope => (v === live.current.liveVersion ? "use" : "watch");

  // The frames wanted now: the version to show and the ones to have ready.
  // A page opened at the live link is taken to be the live version once that
  // is known (its `ready` corrects it). Any other goes, unless it is on
  // screen or fading out under it.
  const wantKey = [version, ...preload].join(",");
  const versionsKey = frames.map((f) => f.version).join(",");
  useEffect(() => {
    if (version === null) return;
    const wanted = new Set([version, ...preload]);
    setFrames((fs) => {
      const named = fs.map((f) => (f.version === null && liveVersion !== null ? { ...f, version: liveVersion } : f));
      const kept = named.filter((f) => f.version === null || wanted.has(f.version) || f.key === top || f.key === under);
      const missing = [...wanted].filter((v) => !kept.some((f) => f.version === v));
      const next = [...kept, ...missing.map((v) => newFrame(++seq.current, v, slug))];
      return next.length === fs.length && next.every((f, i) => f === fs[i]) ? fs : next;
    });
  }, [wantKey, versionsKey, liveVersion, top, under]);

  const target = frames.find((f) => f.version === version) ?? (version === null ? frames[0] : undefined);
  const topKey = useRef<number | null>(null);
  topKey.current = top;

  // The version to show comes on top as soon as it has painted.
  const show = (key: number) => {
    if (key === topKey.current) return;
    const frame = frames.find((f) => f.key === key);
    if (frame?.version != null) live.current.events?.onShown(frame.version);
    setUnder(topKey.current);
    setTop(key);
  };
  useEffect(() => {
    if (target?.painted) show(target.key);
  }, [target?.key, target?.painted]);
  // A version that started but never paints still comes on top after the
  // cap; one that never started does not, and says so.
  useEffect(() => {
    if (!target || target.painted || target.failed || target.key === top) return;
    if (target.ready && !target.inited) return;
    const t = setTimeout(() => (target.ready ? show(target.key) : fail(target.key)), target.ready ? LOAD_CAP_MS : LOAD_GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [target?.key, target?.painted, target?.ready, target?.inited, target?.failed, top]);
  const patch = (key: number, change: (f: Frame) => Frame) => setFrames((fs) => fs.map((f) => (f.key === key ? change(f) : f)));
  const fail = (key: number) => patch(key, (f) => (f.ready || f.failed ? f : { ...f, failed: { error: f.bootError ?? null } }));
  const retry = (key: number) => setFrames((fs) => fs.map((f) => (f.key === key ? newFrame(++seq.current, f.version, slug) : f)));
  // The version on screen did not start. When its own code said why (a
  // module that failed to load or threw), the room hears it, once a version;
  // a page that never arrived is this screen's network, not the app's news.
  const failedNow = target?.failed && target.version !== null ? target : null;
  useEffect(() => {
    if (!events) return;
    events.onFailed(failedNow && { version: failedNow.version!, error: failedNow.failed!.error, retry: () => retry(failedNow.key) });
    const error = failedNow?.failed?.error;
    if (failedNow && error) events.onError(failedNow.version!, error);
  }, [failedNow?.key, !events]);
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

  // A frame whose SDK is ready gets its `init` as soon as the shell knows who
  // you are; until then it is told to hold on.
  const answer = async (key: number, version: number) => {
    const w = windows.current.get(key)?.contentWindow;
    const { session, picking } = live.current;
    if (!w || !session || answered.current.has(key)) return;
    answered.current.add(key);
    const { creds, me, appId, name } = session;
    postToApp(w, await initFor({ creds, appId, version, visitor: me, avatars: await avatarUrlsForApps(), app: appLink(slug, name), scope: scopeOf(version) }));
    patch(key, (f) => ({ ...f, inited: true }));
    if (picking && key === topKey.current) postToApp(w, { type: "pick", on: true, theme: pickTheme() });
  };
  useEffect(() => {
    if (!session) return;
    for (const f of frames) if (f.ready && f.version !== null && (loads.current.get(f.key) ?? 0) < 2) void answer(f.key, f.version);
  }, [!session, frames]);

  // The protocol: match each message to the frame that sent it.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!isAppMessage(e.data)) return;
      const entry = [...windows.current.entries()].find(([, el]) => el.contentWindow === e.source);
      if (!entry) return;
      const [key, el] = entry;
      const { events } = live.current;
      const msg = e.data;
      const frame = frames.find((f) => f.key === key);
      if (msg.type === "ready") {
        if (!frame || answered.current.has(key) || (loads.current.get(key) ?? 0) > 1) return;
        const version = msg.version ?? frame.version;
        if (version === null) return;
        if (!frame.ready || frame.version !== version) patch(key, (f) => ({ ...f, version, ready: true, failed: null }));
        if (live.current.session) void answer(key, version);
        else postToApp(el.contentWindow!, { type: "hold" });
      } else if (msg.type === "painted") {
        if ((loads.current.get(key) ?? 0) < 2) patch(key, (f) => (f.painted ? f : { ...f, painted: true }));
      } else if (msg.type === "error" && !answered.current.has(key)) {
        // Before its SDK runs, an error is why the page may not start.
        patch(key, (f) => ({ ...f, bootError: msg.message }));
      } else if (key !== topKey.current) {
        // Out of sight: nothing else it says is about what you see.
      } else if (msg.type === "spotlit") spotlit.current?.(msg.found);
      else if (msg.type === "picked") events?.onPicked(msg.element);
      else if (msg.type === "pick-cancelled") events?.onPickCancelled();
      else if (msg.type === "refused") events?.onRefused();
      else if (msg.type === "error") {
        if (frame?.version != null) events?.onError(frame.version, msg.message);
      }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [frames]);

  // Each answered frame gets a fresh token well before its last one
  // expires, and at once when the live version moves, so a frame that stops
  // being live stops writing.
  const sendTokens = () => {
    const { session } = live.current;
    if (!session) return;
    for (const f of frames) {
      const w = answered.current.has(f.key) && f.version !== null ? windows.current.get(f.key)?.contentWindow : null;
      if (w) void runtimeTokenForSecret(session.creds.secret, session.appId, f.version!, Date.now(), scopeOf(f.version!)).then((token) => postToApp(w, { type: "token", token }));
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

  // One ref callback per frame for its whole life: a new one each render
  // would detach and reattach the frame every time, forgetting its loads
  // and its answer (and with them its token renewals).
  const refs = useRef(new Map<number, (el: HTMLIFrameElement | null) => void>());
  const refFor = (key: number) => {
    let ref = refs.current.get(key);
    if (!ref) {
      ref = (el) => {
        if (el) return void windows.current.set(key, el);
        windows.current.delete(key);
        loads.current.delete(key);
        answered.current.delete(key);
        refs.current.delete(key);
      };
      refs.current.set(key, ref);
    }
    return ref;
  };

  const onLoad = (f: Frame, el: HTMLIFrameElement) => {
    const n = (loads.current.get(f.key) ?? 0) + 1;
    if (n === 1 || n === 3) {
      // Its own page: the first load, or the load after being sent back. It
      // is revealed when its SDK says it has painted, and has failed if the
      // SDK never says ready.
      loads.current.set(f.key, 1);
      setTimeout(() => fail(f.key), READY_GRACE_MS);
      return;
    }
    loads.current.set(f.key, 2);
    answered.current.delete(f.key);
    patch(f.key, (g) => ({ ...g, painted: false, inited: false }));
    el.src = f.src;
  };

  // Picking follows the frame on top.
  useEffect(() => {
    if (top == null) return;
    const w = windows.current.get(top)?.contentWindow;
    if (w) postToApp(w, { type: "pick", on: picking, theme: picking ? pickTheme() : undefined });
  }, [picking, top]);

  const name = session?.name ?? "The app";
  return (
    <div className={s.stage}>
      {top === null && slow && !failedNow && <Loading version={version} />}
      {frames.map((f) => (
        <iframe
          key={f.key}
          ref={refFor(f.key)}
          className={`${s.frame} ${f.key === top ? s.top : f.key === under ? s.under : ""}`}
          inert={f.key !== top}
          aria-hidden={f.key !== top}
          src={f.src}
          sandbox={SANDBOX}
          allow="clipboard-write; fullscreen; autoplay"
          title={f.version === null ? name : `${name}, v${f.version}, ${f.version === liveVersion ? "live" : "looking only"}`}
          onLoad={(e) => onLoad(f, e.currentTarget)}
        />
      ))}
    </div>
  );
}

const NONE: number[] = [];

/** The faint blob while the first frame loads; on a slow network, after a
 *  while, one line says it is still coming. */
function Loading({ version }: { version: number | null }) {
  const long = useAfter(STILL_LOADING_MS);
  return (
    <div className={s.loading}>
      <Blob size={28} faint />
      {long && <p className={s.still}>Still loading{version === null ? "" : ` v${version}`}</p>}
    </div>
  );
}

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** The picker draws with the shell's own tokens so it matches the room. */
function pickTheme(): PickTheme {
  return { accent: cssVar("--accent"), ink: cssVar("--ink"), font: cssVar("--mono") };
}
