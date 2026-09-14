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

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useConvex } from "convex/react";
import {
  ArrowUpRight,
  CircleAlert,
  CircleHelp,
  EyeOff,
  Globe,
  Laptop,
  Lock,
  LockOpen,
  RotateCw,
  ShieldOff,
  Unplug,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  browserRoutePath,
  displayHost,
  isLoopbackUrl,
  normalizeUrl,
  pageAddress,
  parseBrowserRoute,
  prefersNativeRoute,
  rememberBrowserTitle,
  selectBackend,
  type BrowserSource,
} from "../../lib/browserPane";
import { pageAddressLabel } from "../../lib/browserPaneLinks";
import { browserPaneRecents, rememberBrowserPaneUrl } from "../../lib/browserPaneRecents";
import { useTabContext } from "../../lib/tabParams";
import { bridge, isDesktop } from "../../lib/desktop";
import { stageClose, stageExpand } from "../../lib/stage";
import { getTerminalEndpoint } from "../../lib/terminal/endpoint";
import { useSqueezeToFit } from "../../hooks/useSqueezeToFit";
import { DeviceIcon, deviceDisplayName, type Device } from "../DeviceBadge";
import { useInboxStore } from "../../store/inboxStore";
import { paneOfferOwner } from "../../lib/browserPaneOffer";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { isMac } from "../../shortcuts";
import { PaneControls } from "../stage/PaneControls";
import { FrameBackend } from "./backends/FrameBackend";
import { NativeBackend } from "./backends/NativeBackend";
import { useNativeBrowserPane } from "../../hooks/useNativeBrowserPane";
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

  // The route's `s=` names the session the pane was offered by, and a route
  // is only a hint: a pasted link could name any session. Confirm it against
  // the store's offer row for that session and this address (one read, at
  // parse time), and strip it otherwise, so the desktop registry never stamps
  // an owner nobody offered a pane to (lib/browserPaneOffer.ts paneOfferOwner).
  const source = useMemo(() => {
    const parsed = parseBrowserRoute(path);
    if (!parsed || parsed.kind !== "url" || !parsed.session) return parsed;
    const st = useInboxStore.getState();
    const rows: any[] = [];
    for (const r of Object.values(st.conversations)) if ((r as any)?.session_id === parsed.session) rows.push(r);
    for (const r of Object.values(st.sessions)) if ((r as any)?.session_id === parsed.session) rows.push(r);
    const owner = paneOfferOwner({ hinted: parsed.session, url: parsed.url, rows, now: Date.now() });
    return owner ? parsed : { kind: "url" as const, url: parsed.url };
  }, [path]);
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
  // The field shows the address without its scheme until someone reaches for
  // it; then it holds the full URL, selected, ready to be replaced.
  const [editing, setEditing] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [askedWhy, setAskedWhy] = useState(false);
  const [graceOver, setGraceOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const headRef = useRef<HTMLDivElement>(null);

  // A new address is a new page: every judgement about the old one goes. The
  // STATE is deliberately not reset here — the backend owns it, and a child's
  // effect runs before its parent's, so resetting would erase the verdict the
  // backend just reached (an http page blocked under https never showed).
  useWatchEffect(() => {
    setLiveUrl(null);
    setLiveTitle(null);
    setDraft(null);
    setAskedWhy(false);
    setGraceOver(false);
  }, [url, source?.kind, reloadToken]);

  useWatchEffect(() => {
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
  const fieldValue = draft ?? (editing ? shownUrl : pageAddress(shownUrl));
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
      // A typed page is a page a person opened, the same as one a gesture
      // opened, so the blank pane offers it back too.
      rememberBrowserPaneUrl(normalized);
      router.push(browserRoutePath({ kind: "url", url: normalized }));
    },
    [router],
  );

  // Selecting on focus has to wait for the render that swaps the short
  // address for the full URL: replacing an input's value drops its selection.
  useLayoutEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // The address wins the strip. When it would truncate, the machine badge
  // folds to its icon first (squeeze level 1, `cq-sq1`); only past that does
  // the address itself ellipsize. Measured, because no fixed width knows how
  // long the address is.
  useSqueezeToFit(headRef, 1, fieldValue);

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
  useWatchEffect(() => {
    if (source || !focused) return;
    inputRef.current?.focus();
  }, [source, focused]);

  // Cmd/Ctrl+L is the address bar's key everywhere; inside the app it belongs
  // to the focused browser pane, so it only binds while this pane has focus.
  useWatchEffect(() => {
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
  // One lookup for the badge and the "nothing is listening" card, and only for
  // an address this machine serves: a github.com pane has no machine to name.
  const machine = useThisMachine(loopback);
  const secure = shownUrl.startsWith("https://");
  const overlay = paneOverlay({
    state,
    host: url ? displayHost(url) : "",
    loopback,
    machineName: machine ? deviceDisplayName(machine) : null,
    askedWhy,
    desktop: isDesktop(),
    onReload: () => setReloadToken((n) => n + 1),
    onOpenOutside: openOutside,
    onNative: goNative,
    onDismiss: () => setAskedWhy(false),
  });

  return (
    <div className="h-full flex flex-col min-h-0 bg-sol-bg">
      <div ref={headRef} className="cc-panel__head">
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
            value={fieldValue}
            title={editing ? undefined : shownUrl}
            spellCheck={false}
            autoComplete="off"
            placeholder="Type an address"
            aria-label="Address"
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => setEditing(true)}
            onBlur={() => {
              setEditing(false);
              setDraft(null);
            }}
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
            // The floor is the whole address (1ch per character in a mono
            // face), so an address that does not fit overflows the strip and
            // the squeeze folds the badge. At level 1 the floor drops back to
            // 88px: the address ellipsizes, but never vanishes.
            style={{ minWidth: `max(88px, ${fieldValue.length + 1}ch)` }}
            className={`flex-1 [[data-squeeze~='1']_&]:!min-w-[88px] bg-transparent border-0 outline-none text-[11px] font-mono truncate ${
              rejected ? "text-sol-red" : "text-sol-text-muted focus:text-sol-text"
            }`}
          />
        )}
        {loopback && <LoopbackBadge device={machine} />}
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
          // Folds to its icon with the machine badge, never to a fragment of
          // the question: "not showing?" alone reads as a stray word.
          <button
            type="button"
            onClick={() => setAskedWhy(true)}
            className="group flex flex-shrink-0 items-center gap-1 px-1 text-[10px] text-sol-text-dim/70 transition-colors hover:text-sol-text-muted"
            title="If this pane stays blank, the site may refuse to be shown inside another page"
            aria-label="Page not showing?"
          >
            <CircleHelp className="w-3 h-3" />
            <span className="cq-sq1 underline decoration-dotted decoration-sol-text-dim/40 underline-offset-2 group-hover:decoration-sol-text-muted">
              Page not showing?
            </span>
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
          {/* No list, no promise of one. */}
          {recents.length > 0 ? "Paste a URL or pick a recent page." : "Paste or type a URL."}{" "}
          <KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap> <KeyCap size="xs">L</KeyCap> focuses the
          address bar.
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

/**
 * Every state that covers the page, in one place so they cannot drift apart.
 *
 * One shape for all of them (PaneCard): a quiet glyph for what kind of thing
 * happened, the address, one headline, one sentence, and the actions. The
 * first action is always the one most likely to get the page on screen, so it
 * is always the primary one.
 */
function paneOverlay(a: {
  state: BrowserPaneState;
  host: string;
  loopback: boolean;
  machineName: string | null;
  askedWhy: boolean;
  desktop: boolean;
  onReload: () => void;
  onOpenOutside: () => void;
  onNative: () => void;
  onDismiss: () => void;
}) {
  const glyph = "w-5 h-5";
  const openActions = (
    <>
      <PaneCardButton primary onClick={a.onOpenOutside}>
        Open in browser
      </PaneCardButton>
      {a.desktop && <PaneCardButton onClick={a.onNative}>Open natively</PaneCardButton>}
    </>
  );
  const tryAgain = (
    <PaneCardButton primary onClick={a.onReload}>
      Try again
    </PaneCardButton>
  );

  if (a.state.kind === "unreachable") {
    return (
      <PaneCard
        icon={<Unplug className={glyph} />}
        host={a.host}
        headline={
          a.state.loopback ? "Nothing is listening on this machine" : "Nothing answered at this address"
        }
        detail={
          a.state.loopback
            ? `Start the server on ${a.machineName ?? "this machine"}, or open this pane on the machine that runs it.`
            : "The host may be down, or its name may not resolve from here."
        }
        actions={tryAgain}
      />
    );
  }

  if (a.state.kind === "blocked" && a.state.reason === "local-network") {
    // Chrome's Local Network Access: a page on a public origin must be granted
    // permission to reach this machine or this network. The probe failing is
    // Chrome's refusal, not a closed port, so the pane says whose refusal it is.
    const app = typeof window === "undefined" ? "this app" : window.location.host;
    return (
      <PaneCard
        icon={<ShieldOff className={glyph} />}
        host={a.host}
        headline={
          a.loopback
            ? `Chrome blocked ${app} from reaching this machine`
            : `Chrome blocked ${app} from reaching your local network`
        }
        detail={
          a.desktop
            ? "Allow local network access for this app, then try again."
            : "Allow local network access from the icon in the address bar, or open this pane in the desktop app."
        }
        actions={
          <>
            {tryAgain}
            <PaneCardButton onClick={a.onOpenOutside}>Open in browser</PaneCardButton>
          </>
        }
      />
    );
  }

  if (a.state.kind === "blocked") {
    const insecure = a.state.reason === "insecure";
    return (
      <PaneCard
        icon={insecure ? <LockOpen className={glyph} /> : <EyeOff className={glyph} />}
        host={a.host}
        headline={
          insecure
            ? "An http page cannot be shown inside this https app"
            : "This site refuses to be shown in a pane"
        }
        detail={
          insecure
            ? "Browsers allow it only for addresses on this machine, such as a local dev server."
            : "Its server asks browsers not to embed it."
        }
        actions={openActions}
      />
    );
  }

  if (a.state.kind === "error") {
    return (
      <PaneCard
        icon={<CircleAlert className={glyph} />}
        host={a.host}
        headline={a.state.message}
        actions={tryAgain}
      />
    );
  }

  if (a.askedWhy) {
    return (
      <PaneCard
        icon={<EyeOff className={glyph} />}
        host={a.host}
        headline="Some sites will not load in a pane"
        detail="A site can ask not to be embedded, and from here that looks the same as a page still loading."
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
function LoopbackBadge({ device }: { device: ReturnType<typeof useThisMachine> }) {
  const name = device ? deviceDisplayName(device) : null;
  const tip = name
    ? `This address is served by ${name}, the machine this window runs on`
    : "This address is served by the machine this window runs on";
  // The label folds away first when the strip runs out of room (`cq-sq1`),
  // leaving the icon and its tooltip.
  return (
    <span className="flex flex-shrink-0 items-center gap-1 text-[10px] text-sol-text-dim/80" title={tip} aria-label={tip}>
      {device ? <DeviceIcon d={device} className="w-3 h-3" /> : <Laptop className="w-3 h-3" />}
      <span className="cq-sq1 max-w-[140px] truncate">this machine{name ? ` · ${name}` : ""}</span>
    </span>
  );
}

/** The machine this window runs on, when we can prove it: the daemon that
 *  answers on loopback is by definition here (the same discovery the
 *  integrated terminal uses). Undefined while unknown — never a guess.
 *
 *  Asked only when `wanted`, since only an address on this machine needs a
 *  name. Every pane calls it, so it reads ONE roster row rather than
 *  useDevices: that mounts the roster feeder and subscribes to the whole
 *  roster, whose rows change with liveness, and a github.com pane would
 *  re-render on every one of those changes for a name it never shows. The
 *  shell's own status chip keeps the roster fed. */
function useThisMachine(wanted: boolean): Device | undefined {
  const convex = useConvex();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  useWatchEffect(() => {
    if (!wanted) return;
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
  }, [convex, wanted]);
  return useInboxStore((s) =>
    wanted && deviceId
      ? (s.machineRoster as Device[]).find((d) => d.device_id === deviceId)
      : undefined,
  );
}

export default BrowserPane;
