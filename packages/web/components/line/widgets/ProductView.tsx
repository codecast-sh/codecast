"use client";
// A connected app's own screen, framed in place (docs/architecture/
// external-data.md X8, views): Union's rendering of a conversation, a person,
// a call, a match or a need, where codecast would otherwise draw its own text.
//
// The frame url carries a short-lived token the app mints for this one view
// of this one id (convex sources/appViews.mint, through the connector's
// stored credential in the viewer's active workspace, granted and audited
// like any action). It is minted when the card first nears the screen and
// then kept: a page holds at most LIVE_PLAYERS_MAX heavy frames that opened
// by themselves (the replay embeds' budget, shared), and the rest wait behind
// a click. A card holds its slot only while it has, or may still get, a frame:
// a mint that comes back with no view or a refusal gives the slot back. That
// an app declares no such view is remembered for the page load, so one mint
// answers for every card of that app and view.
//
// The frame talks only through contracts/productView.ts: a message counts
// when it comes from the minted origin and from this iframe's own window, and
// carries the protocol's source tag. It sizes the card (`ready`, `height`),
// or says it cannot draw (`error`). When the app declares no such view, the
// mint is refused, or the frame errors, the card shows its fallback (a
// moment, a link) under a one-line head that says why.
import { memo, useCallback, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAction } from "convex/react";
import { AppWindow, ArrowUpRight, ChevronDown } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import {
  PRODUCT_VIEW_HOST_SOURCE,
  formatProductViewRef,
  framesOwnSite,
  parseProductViewMessage,
  type ProductViewHostMessage,
  type ProductViewRef,
} from "@codecast/shared/contracts/productView";
import { useInboxStore } from "../../../store/inboxStore";
import { useActiveWorkspaceKey } from "../../../hooks/useWorkspaceCollection";
import { useNearViewport } from "../../../hooks/useNearViewport";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useLivePlayerSlot } from "../../ops/ReplayMomentEmbed";
import { viewLabel } from "../../../lib/productViewRefs";
import "../workspace/workspace.css";
import "./productView.css";

export type ProductViewMint = NonNullable<FunctionReturnType<typeof api.sources.appViews.mint>>;

/** Until the frame says how tall it is. */
const FIRST_HEIGHT = 320;
/** A view taller than this folds; Show all opens the rest. */
const FOLD_AT = 560;
/** A minted url is reused until this long before it lapses. */
const REUSE_MARGIN_MS = 60_000;

// Mints this page load, by viewer and reference: a card scrolled away and back,
// or the same view named twice, frames the url already minted while it is good.
const mints = new Map<string, { at: number; p: Promise<ProductViewMint | null> }>();
// Views no connected app declares, by viewer, workspace, app and view: answered once a page load, for every id.
const noView = new Set<string>();
// Views a mint has shown to exist, the same key: a card that cannot know may then offer its button.
const hasView = new Set<string>();
// The app and view pairs one card is already asking about, so a page of moments asks once.
const probes = new Set<string>();
let mintsOf: string | null = null;
const noViewListeners = new Set<() => void>();
const subscribeNoView = (fn: () => void) => { noViewListeners.add(fn); return () => { noViewListeners.delete(fn); }; };
const noViewSize = () => noView.size + hasView.size;
const tellViewKnown = () => { for (const fn of noViewListeners) fn(); };

/** `exists`: whether a connected app declares the view, once any mint this page load has said so; null until then.
 *  `probe` asks to find that out for a card with no slot: the first such card of an app and view mints, the rest wait on it. */
export function useProductViewMint(ref: ProductViewRef, want: boolean, probe = false): { state: "idle" | "minting" | "done"; mint: ProductViewMint | null; exists: boolean | null } {
  const run = useAction(api.sources.appViews.mint);
  const viewer = useInboxStore((s) => s.currentUser?._id?.toString?.() ?? null);
  // The mint goes through the viewer's active workspace: the server reads that workspace's sources and no other.
  const workspace = useActiveWorkspaceKey();
  const text = formatProductViewRef(ref);
  const scope = `${viewer}:${workspace}`;
  const none = `${scope}:${ref.app}:${ref.view}`;
  // Another card of the same app and view learned there is none: this one is answered without asking.
  useSyncExternalStore(subscribeNoView, noViewSize, noViewSize);
  const known = !!viewer && !!workspace && mintsOf === scope && noView.has(none);
  const exists = !viewer || !workspace || mintsOf !== scope ? null : noView.has(none) ? false : hasView.has(none) ? true : null;
  const [got, setGot] = useState<{ key: string; mint: ProductViewMint | null } | null>(null);
  // The one card that asks whether the view exists, when no card of this app and view has a slot.
  const [probing, setProbing] = useState(false);
  useWatchEffect(() => {
    if (!probe || want || probing || !viewer || !workspace || exists !== null) return;
    if (mintsOf !== scope) { mints.clear(); noView.clear(); hasView.clear(); probes.clear(); mintsOf = scope; }
    if (probes.has(none)) return;
    probes.add(none);
    setProbing(true);
  }, [probe, want, probing, viewer, workspace, exists, scope, none]);
  const asks = want || probing;
  useWatchEffect(() => {
    if (!asks || !viewer || !workspace) return;
    if (mintsOf !== scope) { mints.clear(); noView.clear(); hasView.clear(); probes.clear(); mintsOf = scope; }
    if (noView.has(none)) return;
    const key = `${scope}:${text}`;
    let p = mints.get(key)?.p;
    if (!p) {
      p = run({ ref: text, workspace }).catch(() => ({ ok: false as const, app: ref.app, view: ref.view, title: ref.view, error: "could not reach codecast" }));
      mints.set(key, { at: Date.now(), p });
      // Only a good url is reused, and only while it is good; a refusal is asked again next time. "No such view" is a
      // fact about the app, not this id: remembered for the page load.
      void p.then((m) => {
        if (m === null) { noView.add(none); mints.delete(key); tellViewKnown(); return; }
        // An app that answered, even with a refusal, declares the view.
        if (!hasView.has(none)) { hasView.add(none); tellViewKnown(); }
        if (!m.ok) return void mints.delete(key);
        const left = Date.parse(m.expires_at) - Date.now() - REUSE_MARGIN_MS;
        setTimeout(() => { if (mints.get(key)?.p === p) mints.delete(key); }, Math.max(0, left));
      });
    }
    let live = true;
    void p.then((mint) => { if (live) setGot({ key: text, mint }); });
    return () => { live = false; };
  }, [asks, viewer, workspace, text]);
  if (known) return { state: "done", mint: null, exists: false };
  if (!asks) return { state: "idle", mint: null, exists };
  return got?.key === text ? { state: "done", mint: got.mint, exists } : { state: "minting", mint: null, exists };
}

/** The frame's messages, trusted only from `origin` and from this iframe's window. */
function useProductViewChannel(origin: string | null, on: { size: (h: number) => void; error: (m: string) => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const handlers = useRef(on);
  handlers.current = on;
  const hello = useCallback(() => {
    if (!origin) return;
    const msg: ProductViewHostMessage = { source: PRODUCT_VIEW_HOST_SOURCE, type: "hello" };
    frameRef.current?.contentWindow?.postMessage(msg, origin);
  }, [origin]);
  useWatchEffect(() => {
    if (!origin) return;
    const listen = (e: MessageEvent) => {
      if (e.origin !== origin || !frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const msg = parseProductViewMessage(e.data);
      if (!msg) return;
      if (msg.type === "hello") hello();
      else if (msg.type === "error") handlers.current.error(msg.message);
      else handlers.current.size(msg.height);
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [origin, hello]);
  return { frameRef, hello };
}

const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);
const atWords = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export type ProductViewProps = {
  viewRef: ProductViewRef;
  /** What shows when the app cannot draw the view: our own rendering (a moment), a link. Absent, the card folds to its head. */
  fallback?: ReactNode;
  /** Fold height in px. */
  foldAt?: number;
  /** Open without waiting for the screen or a slot (a card a person asked for). */
  eager?: boolean;
  /** Draw nothing when no connected app declares the view (a surface that names views it cannot know exist). */
  hideWhenNone?: boolean;
  /** Draw nothing unless the view frames: where the host already shows codecast's own text of the thing and a link
   *  to it, a refusal adds nothing a reader can use. A missing grant still shows its Allow link: that one can be acted on. */
  hideWhenUnframed?: boolean;
  /** The fallback names the thing itself (a call read by its people, day and length): when the view cannot be framed it
   *  shows alone, with no head saying the view could not be shown above a reading that works. An Allow link still shows. */
  fallbackNames?: boolean;
  className?: string;
};

export const ProductView = memo(function ProductView({ viewRef, fallback, foldAt = FOLD_AT, eager, hideWhenNone, hideWhenUnframed, fallbackNames, className }: ProductViewProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(boxRef, "800px");
  // A card with nothing to frame (no such view, a refusal) gives its slot back: the budget is for frames that draw.
  const [spent, setSpent] = useState(false);
  const slot = useLivePlayerSlot(near && !eager && !spent, spent);
  const [clicked, setClicked] = useState(false);
  const open = !!eager || slot || clicked;
  const { state, mint, exists } = useProductViewMint(viewRef, open || spent, !!hideWhenNone && near);
  const unframed = state === "done" && !mint?.ok;
  useWatchEffect(() => { if (unframed) setSpent(true); }, [unframed]);
  const [height, setHeight] = useState<number | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  // A frame of codecast's own origin or site is never mounted: sandboxed with scripts and its own origin, it would
  // be this page's origin and could read it. The server refuses such a url (readViewToken); this is the second wall.
  const ownSite = !!mint?.ok && typeof window !== "undefined" && framesOwnSite(mint.url, window.location.href);
  const ready = mint?.ok && !ownSite ? mint : null;
  const channel = useProductViewChannel(ready?.origin ?? null, { size: setHeight, error: setFrameError });

  const label = viewLabel(viewRef, mint?.app);
  const why = state !== "done" ? null : !mint ? `${viewRef.app} has no ${viewRef.view} view here` : !mint.ok ? mint.error : ownSite ? "the view is on codecast's own site, which is never framed here" : frameError;
  const fellBack = !!why;
  // What the reader is told: the view could not be drawn. Why, in the connection's own terms, is for whoever set it up (the title).
  const whyWords = !mint ? why : "can't be shown here";
  const tall = (height ?? FIRST_HEIGHT) > foldAt;
  const shown = Math.min(height ?? FIRST_HEIGHT, all ? Infinity : foldAt);

  // A fallback that names the thing (codecast's own reading of a call) is the thing: it shows until a frame is ready,
  // and in place of one that never comes, rather than an empty slot waiting on the viewport or the app.
  const reading = !!fallbackNames && !!fallback && (!ready || fellBack) && !(mint && !mint.ok && mint.grant_url);
  if (hideWhenNone && state === "done" && !mint && !reading) return null;
  if (hideWhenUnframed && fellBack && !(mint && !mint.ok && mint.grant_url)) return null;
  if (reading) {
    return <div ref={boxRef} className={`pv${className ? ` ${className}` : ""}`} data-product-view={formatProductViewRef(viewRef)} data-state="fallback" title={why ?? undefined}><div className="pv-fallback">{fallback}</div></div>;
  }
  // A surface that cannot know the view exists draws nothing until a mint has said it does: never a button for a view that may not be there.
  if (hideWhenNone && !ready && !fellBack && exists !== true) return <div ref={boxRef} data-product-view={formatProductViewRef(viewRef)} data-state="unknown" />;
  return (
    <div ref={boxRef} className={`pv${className ? ` ${className}` : ""}`} data-product-view={formatProductViewRef(viewRef)} data-state={fellBack ? "fallback" : ready ? "ready" : state}>
      <div className="pv-head">
        <AppWindow className="pv-icon" aria-hidden />
        <b className="pv-title">{label}</b>
        <span className="pv-id" title={viewRef.id}>{shortId(viewRef.id)}</span>
        {viewRef.at && <span className="pv-at" title={`As of ${viewRef.at}`}>as of {atWords(viewRef.at)}</span>}
        <span className="pv-sp" />
        {why && (
          <span className="pv-why" title={why}>
            {mint && !mint.ok && mint.grant_url ? <>not allowed · <a href={mint.grant_url} target="_blank" rel="noreferrer">Allow</a></> : whyWords}
          </span>
        )}
        {ready && !frameError && (
          <a className="pv-open" href={ready.url} target="_blank" rel="noreferrer" title={`Open in ${ready.app}`}>
            {ready.app}<ArrowUpRight aria-hidden />
          </a>
        )}
      </div>

      {fellBack ? (
        fallback ? <div className="pv-fallback">{fallback}</div> : null
      ) : ready ? (
        <div className="pv-frame-wrap" data-folded={tall && !all ? "" : undefined}>
          <iframe
            ref={channel.frameRef}
            className="pv-frame"
            src={ready.url}
            title={`${label} ${viewRef.id}`}
            // Its own origin and scripts, popups out to a full tab; never this page's.
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
            referrerPolicy="no-referrer"
            loading="lazy"
            onLoad={channel.hello}
            style={{ height: shown, opacity: height == null ? 0.001 : 1 }}
          />
          {height == null && <div className="pv-wait"><span className="lw-spin" aria-hidden /> Opening {label}</div>}
          {tall && (
            <button type="button" className="pv-more" aria-expanded={all} onClick={() => setAll(!all)}>
              <ChevronDown aria-hidden />{all ? "Fold" : "Show all"}
            </button>
          )}
        </div>
      ) : open ? (
        <div className="pv-wait pv-wait-box"><span className="lw-spin" aria-hidden /> Opening {label}</div>
      ) : (
        <button type="button" className="pv-play" onClick={() => setClicked(true)}>
          <AppWindow aria-hidden />Open {label}
        </button>
      )}
    </div>
  );
});

/** A reference in running text: a pill naming the view, opening it in the app in a new tab. */
export function ProductViewPill({ viewRef }: { viewRef: ProductViewRef }) {
  const [want, setWant] = useState(false);
  const { state, mint } = useProductViewMint(viewRef, want);
  const pending = useRef<Window | null>(null);
  useWatchEffect(() => {
    if (state !== "done") return;
    const w = pending.current;
    pending.current = null;
    if (mint?.ok && w) w.location.href = mint.url;
    else w?.close();
  }, [state, mint]);
  const failed = state === "done" && !mint?.ok;
  const text = formatProductViewRef(viewRef);
  // A view the app cannot open is read as its name, never a button that does nothing.
  if (failed) return <span className="pv-pill" data-product-view-pill={text} data-failed=""><span>{viewLabel(viewRef, mint?.app)}</span><span className="pv-pill-id">{shortId(viewRef.id)}</span></span>;
  return (
    <button
      type="button"
      className="pv-pill"
      data-product-view-pill={text}
      title={text}
      onClick={() => {
        // Opened now, inside the click, so no popup blocker stands between; pointed at the view once minted.
        if (mint?.ok) return void window.open(mint.url, "_blank", "noopener");
        const w = window.open("about:blank", "_blank");
        if (w) w.opener = null;
        pending.current = w;
        setWant(true);
      }}
    >
      <AppWindow aria-hidden />
      <span>{viewLabel(viewRef, mint?.app)}</span>
      <span className="pv-pill-id">{shortId(viewRef.id)}</span>
    </button>
  );
}

/** A reference alone on its line: the view itself, falling back to its text. */
export function ProductViewEmbed({ viewRef }: { viewRef: ProductViewRef }) {
  const text = useMemo(() => formatProductViewRef(viewRef), [viewRef]);
  return (
    <div className="lw-widget">
      <ProductView viewRef={viewRef} fallback={<code className="pv-ref-text">{text}</code>} />
    </div>
  );
}
