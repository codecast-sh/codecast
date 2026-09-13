"use client";
// A web page, as a pane on the stage.
//
// The pane owns ONE 32px header (`.cc-panel__head`, the house panel language)
// and hosts PaneControls in it, exactly as a conversation pane hosts them in
// its own header — the split renderer skips its usual PaneStrip for this
// route, so a browser pane is never two stacked bars. That header IS the
// address bar: where you are, and the four things you can do about it.
//
// Everything that identifies the pane lives in the path (`/browser?u=…`), so
// typing an address is a navigation: it rewrites the leaf through the
// pane-local router, which keeps the tab-path invariant and makes back,
// reload, drag-to-split and tab restore work with no state of our own.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { ArrowUpRight, Globe, Lock, RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  browserRoutePath,
  displayHost,
  isLoopbackUrl,
  normalizeUrl,
  parseBrowserRoute,
  prefersNativeRoute,
  rememberBrowserTitle,
  selectBackend,
  type BrowserSource,
} from "../../lib/browserPane";
import { pageAddressLabel } from "../../lib/browserPaneLinks";
import { browserPaneRecents } from "../../lib/browserPaneRecents";
import { useTabContext } from "../../lib/tabParams";
import { bridge, isDesktop } from "../../lib/desktop";
import { stageClose, stageExpand } from "../../lib/stage";
import { getTerminalEndpoint } from "../../lib/terminal/endpoint";
import { deviceDisplayName, useDevices } from "../DeviceBadge";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { isMac } from "../../shortcuts";
import { PaneControls } from "../stage/PaneControls";
import { FrameBackend } from "./backends/FrameBackend";
import { NativeBackend, useNativeBrowserPane } from "./backends/NativeBackend";
import { StreamBackend } from "./backends/StreamBackend";
import { PaneCard, PaneCardButton } from "./backends/PaneCard";
import type { BrowserPaneState, PaneStripAction } from "./backends/types";

/** How long a cross-origin frame gets before the strip offers the "it didn't
 *  load" card. A frame that refuses can only be told apart from one that
 *  worked by a human looking at it (see FrameBackend's header), so this only
 *  ever OFFERS the explanation — it never asserts one. */
const REFUSAL_GRACE_MS = 2500;

export function BrowserPane() {
  const ctx = useTabContext();
  const router = useRouter();
  const path = useMemo(() => {
    if (ctx) {
      const q = ctx.searchParams.toString();
      return ctx.pathname + (q ? `?${q}` : "");
    }
    if (typeof window === "undefined") return "/browser";
    return window.location.pathname + window.location.search;
  }, [ctx]);

  const source = useMemo(() => parseBrowserRoute(path), [path]);
  const wantsNative = prefersNativeRoute(path);
  const url = source?.kind === "url" ? source.url : null;
  const focused = ctx?.isActive ?? true;
  const leafId = ctx?.leafId;

  const [state, setState] = useState<BrowserPaneState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [liveTitle, setLiveTitle] = useState<string | null>(null);
  // Verbs the backend put in the strip (backends/types.ts). The stream's drive
  // toggle and reconnect live here; a frame registers none.
  const [actions, setActions] = useState<PaneStripAction[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const [askedWhy, setAskedWhy] = useState(false);
  const [graceOver, setGraceOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // A new address is a new page: every judgement about the old one goes. The
  // STATE is deliberately not reset here — the backend owns it, and a child's
  // effect runs before its parent's, so resetting would erase the verdict the
  // backend just reached (an http page blocked under https never showed).
  useEffect(() => {
    setLiveUrl(null);
    setLiveTitle(null);
    setDraft(null);
    setAskedWhy(false);
    setGraceOver(false);
  }, [url, source?.kind, reloadToken]);

  // A backend's verbs belong to that backend: a NEW source clears them, a
  // reload does not — the same backend is still mounted and has no reason to
  // register them again.
  useEffect(() => setActions([]), [url, source?.kind]);

  useEffect(() => {
    if (state.kind !== "ready" || !state.opaque) return;
    const t = setTimeout(() => setGraceOver(true), REFUSAL_GRACE_MS);
    return () => clearTimeout(t);
  }, [state]);

  const handleTitle = useCallback(
    (title: string | null) => {
      setLiveTitle(title);
      if (url) rememberBrowserTitle(url, title);
    },
    [url],
  );
  const handleUrl = useCallback((next: string) => setLiveUrl(next), []);
  const handleState = useCallback((next: BrowserPaneState) => setState(next), []);
  const handleActions = useCallback((next: PaneStripAction[]) => setActions(next), []);

  const shownUrl = liveUrl ?? url ?? "";
  const navigateTo = useCallback(
    (next: string) => {
      const normalized = normalizeUrl(next);
      if (!normalized) {
        setRejected(true);
        setTimeout(() => setRejected(false), 1200);
        return;
      }
      setDraft(null);
      inputRef.current?.blur();
      router.push(browserRoutePath({ kind: "url", url: normalized }));
    },
    [router],
  );

  const openOutside = useCallback(() => {
    if (!shownUrl) return;
    const openExternal = isDesktop() ? bridge("openExternal") : undefined;
    if (openExternal) void openExternal(shownUrl);
    else window.open(shownUrl, "_blank", "noopener,noreferrer");
  }, [shownUrl]);

  const goNative = useCallback(() => {
    if (!source || source.kind !== "url") return;
    router.replace(browserRoutePath(source, { native: true }));
  }, [router, source]);

  // A pane with no address exists to be typed into (the palette's "Open a URL
  // in a pane"), so its bar takes focus as it appears — and only there: a
  // pane showing a page must never steal focus from what you were doing.
  useEffect(() => {
    if (source || !focused) return;
    inputRef.current?.focus();
  }, [source, focused]);

  // Cmd/Ctrl+L is the address bar's key everywhere; inside the app it belongs
  // to the focused browser pane, so it only binds while this pane has focus.
  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "l") return;
      if (isMac ? !e.metaKey || e.ctrlKey : !e.ctrlKey) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [focused]);

  // Whether this build has the shell's native view at all. It is the shell's
  // own answer to a capability call, so it arrives a tick after boot — hence a
  // subscription rather than a read (NativeBackend owns the question).
  const nativeReady = useNativeBrowserPane();

  // Selection is automatic, never inferred from a frame: nothing on the client
  // can tell a refused frame from one that painted (FrameBackend's header), so
  // `refused` is only ever what the user told us by choosing the native view.
  const backendKind = source
    ? selectBackend(source, {
        desktop: isDesktop(),
        nativeAvailable: nativeReady,
        refused: false,
        preferNative: wantsNative,
      })
    : "frame";
  // An explicit choice is honored even where the view is missing: the native
  // card then says so, which is more honest than silently re-framing the page
  // the user just told us would not frame.
  const Backend =
    source?.kind === "watch"
      ? StreamBackend
      : wantsNative || backendKind === "native"
        ? NativeBackend
        : FrameBackend;

  const loopback = !!url && isLoopbackUrl(url);
  const secure = shownUrl.startsWith("https://");
  const overlay = paneOverlay({
    state,
    url,
    host: url ? displayHost(url) : "",
    askedWhy,
    loopback,
    desktop: isDesktop(),
    onReload: () => setReloadToken((n) => n + 1),
    onOpenOutside: openOutside,
    onNative: goNative,
    onDismiss: () => setAskedWhy(false),
  });

  return (
    <div className="h-full flex flex-col min-h-0 bg-sol-bg">
      <div className="cc-panel__head">
        <span className="cc-panel__icon" title={secure ? "Served over https" : "Served over http"}>
          {secure ? <Lock className="w-3 h-3" /> : <Globe className="w-3 h-3" />}
        </span>
        {source?.kind === "watch" ? (
          // What the agent is looking at, in the words the daemon uses for it:
          // its title, then its address. The session uuid is a handle, not a
          // name, so it only stands in while nothing has been streamed yet.
          <span className="flex-1 min-w-0 flex items-baseline gap-1.5 overflow-hidden text-[11px] font-mono">
            <span className="flex-shrink-0 truncate text-sol-text-muted">
              {liveTitle || "Agent tab"}
            </span>
            {shownUrl && (
              <span className="min-w-0 truncate text-sol-text-dim/70" title={shownUrl}>
                {shownUrl}
              </span>
            )}
          </span>
        ) : (
          <input
            ref={inputRef}
            value={draft ?? shownUrl}
            spellCheck={false}
            autoComplete="off"
            placeholder="Type an address"
            aria-label="Address"
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                navigateTo(draft ?? shownUrl);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraft(null);
                inputRef.current?.blur();
              }
            }}
            // Keeps a usable address bar in a narrow pane: everything else in
            // the strip may shrink or ellipsize, the address may not vanish.
            className={`flex-1 min-w-[88px] bg-transparent border-0 outline-none text-[11px] font-mono truncate ${
              rejected ? "text-sol-red" : "text-sol-text-muted focus:text-sol-text"
            }`}
          />
        )}
        {loopback && <LoopbackBadge />}
        {source?.kind === "url" && (
          <>
            <button
              type="button"
              className="cc-panel__btn"
              title="Reload this page"
              onClick={() => setReloadToken((n) => n + 1)}
            >
              <RotateCw className="w-3 h-3" />
            </button>
            <button
              type="button"
              className="cc-panel__btn"
              title="Open in your browser"
              onClick={openOutside}
            >
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </>
        )}
        {/* Only in the pane you are working in: four panes each nagging about
            a page that may be perfectly fine is noise. */}
        {focused && state.kind === "ready" && state.opaque && graceOver && !askedWhy && (
          <button
            type="button"
            onClick={() => setAskedWhy(true)}
            className="flex-shrink-0 px-1.5 text-[10px] text-sol-text-dim/70 hover:text-sol-text-muted transition-colors"
            title="This pane cannot tell whether the page painted"
          >
            blank?
          </button>
        )}
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={`cc-panel__btn ${action.active ? "is-on" : ""}`}
            title={action.label}
            aria-label={action.label}
            aria-pressed={action.active}
            onClick={action.onClick}
          >
            {action.icon}
          </button>
        ))}
        {leafId && (
          <PaneControls onExpand={() => stageExpand(leafId)} onClose={() => stageClose(leafId)} />
        )}
      </div>

      <div className="relative flex-1 min-h-0">
        {state.kind === "loading" && (
          // The page is opaque to us, so a skeleton would be a guess; a thin
          // sweep under the strip is the honest amount to say.
          <div className="absolute top-0 left-0 right-0 h-[2px] overflow-hidden z-10">
            <div className="h-full w-1/4 bg-sol-cyan/70 animate-[indeterminateBar_1.3s_ease-in-out_infinite]" />
          </div>
        )}
        {source ? (
          <div className="absolute inset-0">
            <Backend
              source={source as BrowserSource}
              focused={focused}
              reloadToken={reloadToken}
              onTitle={handleTitle}
              onUrl={handleUrl}
              onState={handleState}
              onActions={handleActions}
            />
          </div>
        ) : (
          <BlankPane onPick={navigateTo} />
        )}
        {overlay && <div className="absolute inset-0 z-20">{overlay}</div>}
      </div>
    </div>
  );
}

/**
 * The pane before it points anywhere: what to do, and the pages this browser
 * opened in a pane before (lib/browserPaneRecents). Read once, at mount — the
 * list is a place to start, not a live feed, and a list that reshuffles under
 * the pointer is worse than a slightly stale one.
 */
function BlankPane({ onPick }: { onPick: (url: string) => void }) {
  const [recents] = useState(browserPaneRecents);
  return (
    <PaneCard
      icon={<Globe className="w-5 h-5" />}
      headline="No page open"
      detail={
        <>
          Paste a URL or pick a recent page. <KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap>{" "}
          <KeyCap size="xs">L</KeyCap> reaches the address bar.
        </>
      }
      actions={
        recents.length > 0 ? (
          <div className="mt-1 flex w-[320px] max-w-full flex-col items-stretch gap-px">
            {recents.map((url) => (
              <button
                key={url}
                type="button"
                onClick={() => onPick(url)}
                title={url}
                className="group flex items-center gap-2 rounded-[5px] px-2 py-1 text-left text-[11px] font-mono text-sol-text-muted transition-colors hover:bg-sol-bg-highlight/60 hover:text-sol-text"
              >
                <Globe className="h-3 w-3 flex-shrink-0 text-sol-text-dim transition-colors group-hover:text-sol-cyan" />
                <span className="truncate">{pageAddressLabel(url)}</span>
              </button>
            ))}
          </div>
        ) : undefined
      }
    />
  );
}

/** Every state that covers the page, in one place so they cannot drift apart. */
function paneOverlay(a: {
  state: BrowserPaneState;
  url: string | null;
  host: string;
  askedWhy: boolean;
  loopback: boolean;
  desktop: boolean;
  onReload: () => void;
  onOpenOutside: () => void;
  onNative: () => void;
  onDismiss: () => void;
}) {
  const openActions = (
    <>
      <PaneCardButton primary onClick={a.onOpenOutside}>
        Open in browser
      </PaneCardButton>
      {a.desktop && <PaneCardButton onClick={a.onNative}>Open natively</PaneCardButton>}
    </>
  );

  if (a.state.kind === "unreachable") {
    return (
      <PaneCard
        host={a.host}
        headline={
          a.state.loopback
            ? "Nothing is listening on this address on this machine"
            : "Nothing answered at this address"
        }
        detail={
          a.state.loopback ? (
            <LoopbackDetail />
          ) : (
            "The host may be down, or the name may not resolve from here."
          )
        }
        actions={<PaneCardButton onClick={a.onReload}>Try again</PaneCardButton>}
      />
    );
  }

  if (a.state.kind === "blocked") {
    return (
      <PaneCard
        host={a.host}
        headline={
          a.state.reason === "insecure"
            ? "An http page cannot be shown inside this https app"
            : "This site refuses to be shown in a pane"
        }
        detail={
          a.state.reason === "insecure"
            ? "Your browser blocks it. Addresses on this machine are the exception, which is why a local dev server works."
            : "Its server asks browsers not to embed it."
        }
        actions={openActions}
      />
    );
  }

  if (a.state.kind === "error") {
    return (
      <PaneCard
        host={a.host}
        headline={a.state.message}
        actions={<PaneCardButton onClick={a.onReload}>Try again</PaneCardButton>}
      />
    );
  }

  if (a.askedWhy) {
    return (
      <PaneCard
        host={a.host}
        headline="Some sites will not load in a pane"
        detail="A site can tell browsers not to embed it, and it looks blank from here — nothing in the page can tell that apart from a page that simply has not painted yet."
        actions={
          <>
            {openActions}
            <PaneCardButton onClick={a.onDismiss}>Keep waiting</PaneCardButton>
          </>
        }
      />
    );
  }

  return null;
}

/** Which machine a loopback pane points at. The path persists across machines
 *  and tabs, so "localhost:3000" has to say WHOSE localhost. */
function LoopbackBadge() {
  const name = useThisMachineName();
  return (
    <span
      className="min-w-0 max-w-[140px] truncate text-[10px] text-sol-text-dim/80"
      title={
        name
          ? `This address is served by ${name}, the machine this window runs on`
          : "This address is served by the machine this window runs on"
      }
    >
      this machine{name ? ` · ${name}` : ""}
    </span>
  );
}

/** The name of the machine this window runs on, when we can prove it: the
 *  daemon that answers on loopback is by definition here (the same discovery
 *  the integrated terminal uses). Null while unknown — never a guess. */
function useThisMachineName(): string | null {
  const convex = useConvex();
  const { byId } = useDevices();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // Full discovery, not cache-only: without it the badge says "this machine"
    // and never names it. The lookup is cached module-wide, so a pane that
    // opens later pays nothing.
    void getTerminalEndpoint(convex)
      .then((ep) => {
        if (live && ep) setDeviceId(ep.deviceId);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [convex]);
  const device = deviceId ? byId.get(deviceId) : undefined;
  return device ? deviceDisplayName(device) : null;
}

function LoopbackDetail() {
  const name = useThisMachineName();
  return (
    <>
      This address only exists on {name ?? "the machine this window runs on"}. Start the server
      there, or open the pane on the machine that serves it.
    </>
  );
}

export default BrowserPane;
