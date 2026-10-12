"use client";
// A connected app's own screen, framed in place (docs/architecture/
// external-data.md X8, views): Union's rendering of a conversation, a person,
// a call, a match or a need, where codecast would otherwise draw its own text.
//
// The frame url carries a short-lived token the app mints for this one view
// of this one id (convex sources/appViews.mint, through the connector's
// stored credential, granted and audited like any action). It is minted when
// the card first nears the screen and then kept: a page holds at most
// LIVE_PLAYERS_MAX heavy frames that opened by themselves (the replay
// embeds' budget, shared), and the rest wait behind a click.
//
// The frame talks only through contracts/productView.ts: a message counts
// when it comes from the minted origin and from this iframe's own window, and
// carries the protocol's source tag. It sizes the card (`ready`, `height`),
// or says it cannot draw (`error`). When the app declares no such view, the
// mint is refused, or the frame errors, the card shows its fallback (a
// moment, a link) under a one-line head that says why.
import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useAction } from "convex/react";
import { AppWindow, ArrowUpRight, ChevronDown } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import {
  PRODUCT_VIEW_HOST_SOURCE,
  formatProductViewRef,
  parseProductViewMessage,
  type ProductViewHostMessage,
  type ProductViewRef,
} from "@codecast/shared/contracts/productView";
import { useInboxStore } from "../../../store/inboxStore";
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
let mintsOf: string | null = null;

export function useProductViewMint(ref: ProductViewRef, want: boolean): { state: "idle" | "minting" | "done"; mint: ProductViewMint | null } {
  const run = useAction(api.sources.appViews.mint);
  const viewer = useInboxStore((s) => s.currentUser?._id?.toString?.() ?? null);
  const text = formatProductViewRef(ref);
  const [got, setGot] = useState<{ key: string; mint: ProductViewMint | null } | null>(null);
  useWatchEffect(() => {
    if (!want || !viewer) return;
    if (mintsOf !== viewer) { mints.clear(); mintsOf = viewer; }
    const key = `${viewer}:${text}`;
    let p = mints.get(key)?.p;
    if (!p) {
      p = run({ ref: text }).catch(() => ({ ok: false as const, app: ref.app, view: ref.view, title: ref.view, error: "could not reach codecast" }));
      mints.set(key, { at: Date.now(), p });
      // Only a good url is reused, and only while it is good; a refusal is asked again next time.
      void p.then((m) => {
        if (!m?.ok) return void mints.delete(key);
        const left = Date.parse(m.expires_at) - Date.now() - REUSE_MARGIN_MS;
        setTimeout(() => { if (mints.get(key)?.p === p) mints.delete(key); }, Math.max(0, left));
      });
    }
    let live = true;
    void p.then((mint) => { if (live) setGot({ key: text, mint }); });
    return () => { live = false; };
  }, [want, viewer, text]);
  if (!want) return { state: "idle", mint: null };
  return got?.key === text ? { state: "done", mint: got.mint } : { state: "minting", mint: null };
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
  className?: string;
};

export const ProductView = memo(function ProductView({ viewRef, fallback, foldAt = FOLD_AT, eager, hideWhenNone, className }: ProductViewProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(boxRef, "800px");
  const slot = useLivePlayerSlot(near && !eager);
  const [clicked, setClicked] = useState(false);
  const open = !!eager || slot || clicked;
  const { state, mint } = useProductViewMint(viewRef, open);
  const [height, setHeight] = useState<number | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const ready = mint?.ok ? mint : null;
  const channel = useProductViewChannel(ready?.origin ?? null, { size: setHeight, error: setFrameError });

  const label = viewLabel(viewRef, mint?.app);
  const why = state !== "done" ? null : !mint ? `${viewRef.app} has no ${viewRef.view} view here` : !mint.ok ? mint.error : frameError;
  const fellBack = !!why;
  const tall = (height ?? FIRST_HEIGHT) > foldAt;
  const shown = Math.min(height ?? FIRST_HEIGHT, all ? Infinity : foldAt);

  if (hideWhenNone && state === "done" && !mint) return null;
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
            {mint && !mint.ok && mint.grant_url ? <>not allowed · <a href={mint.grant_url} target="_blank" rel="noreferrer">Allow</a></> : why}
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
  return (
    <button
      type="button"
      className="pv-pill"
      data-product-view-pill={text}
      data-failed={failed ? "" : undefined}
      title={failed ? (mint && !mint.ok ? mint.error : `${viewRef.app} has no ${viewRef.view} view here`) : text}
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
