import { useCallback, useState } from "react";
import { CommandPalette } from "../../components/CommandPalette";
import { ComposeView } from "../../components/ComposeView";
import { ShortcutProvider } from "../../shortcuts";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useEnsureDispatch } from "../../hooks/useEnsureDispatch";
import { useLiveInboxSessions } from "../../hooks/useLiveInboxSessions";
import { isElectron, bridge } from "../../lib/desktop";
import { usePrincipalLocalState } from "../../components/PrincipalLocalStateProvider";

export default function PalettePage() {
  return (
    <ShortcutProvider>
      <div className="h-screen w-screen flex items-start justify-center pt-2">
        <PaletteRoot />
      </div>
    </ShortcutProvider>
  );
}

/**
 * The single always-on-top palette window renders one of two surfaces:
 *   - search   → the command palette (Cmd+K style), the default.
 *   - compose  → the floating new-session popup (ComposeView).
 * Electron flips the mode via `compose-show` / `palette-show`; in the browser
 * the in-page `codecast-compose` event (from the palette's "New session" item)
 * does the same. `composeNonce` remounts ComposeView so each open starts on a
 * fresh blank session.
 */
function PaletteRoot() {
  // The provider deliberately renders locked public routes, including
  // /palette. That must not expose this window's mutative actions before an
  // exact principal store (and its outbox) has opened. `offline-ready` is safe:
  // writes enqueue durably even though live dispatch waits for the server.
  useEnsureDispatch();
  const { state } = usePrincipalLocalState();
  const durablePrincipalReady =
    state.phase === "offline-ready" || state.phase === "server-verified";
  if (!durablePrincipalReady) {
    return (
      <section className="w-[30rem] max-w-[calc(100vw-1rem)] rounded-xl border border-sol-border bg-sol-card p-5 text-sol-text shadow-xl">
        <h1 className="text-sm font-semibold">Codecast is not ready to write</h1>
        <p className="mt-2 text-xs text-sol-text-muted">
          Sign in or retry after local state opens. Creating or changing work is
          disabled so nothing can be lost.
        </p>
        <button
          className="mt-4 rounded-md border border-sol-border px-3 py-2 text-xs hover:border-sol-cyan"
          onClick={() => window.location.reload()}
        >
          Retry
        </button>
      </section>
    );
  }
  return <ReadyPaletteRoot />;
}

function ReadyPaletteRoot() {
  // The palette window hydrates the store from IDB but, unlike the main app
  // shell, never wires the server dispatch — so creating/sending a session here
  // would no-op (asyncAction returns undefined without a dispatch). Wire it so
  // the compose popup can start sessions on its own. Idempotent across windows.
  // Keep this window's `sessions` cache live (NOT just the cold IDB snapshot).
  // The compose popup reuses a blank session via findReusableBlankSession; on a
  // stale snapshot a session that has since gained messages still looks blank, so
  // the first message lands in that existing conversation. This is the same live
  // list the in-app New Session reads — minus the heavy recovery/sound/crawl
  // machinery — so both paths decide reuse from identical truth. It also keeps the
  // standalone command palette's recent-session list current.
  useLiveInboxSessions();

  const [mode, setMode] = useState<"search" | "compose">("search");
  const [composeNonce, setComposeNonce] = useState(0);
  const [composeQuery, setComposeQuery] = useState("");

  const enterCompose = useCallback((query: string) => {
    setComposeQuery(query);
    setComposeNonce((n) => n + 1);
    setMode("compose");
  }, []);

  // Electron drives the mode: new-session shortcut/menus → compose-show,
  // command-palette shortcut → palette-show.
  useWatchEffect(() => {
    if (!isElectron()) return;
    const offCompose = window.__CODECAST_ELECTRON__?.onComposeShow?.(() => enterCompose(""));
    const offPalette = window.__CODECAST_ELECTRON__?.onPaletteShow?.(() => setMode("search"));
    return () => { offCompose?.(); offPalette?.(); };
  }, [enterCompose]);

  // In-page handoff from the command palette's "New session: <query>" item.
  useWatchEffect(() => {
    const handler = (e: Event) => enterCompose((e as CustomEvent<string>).detail || "");
    window.addEventListener("codecast-compose", handler);
    return () => window.removeEventListener("codecast-compose", handler);
  }, [enterCompose]);

  // Tell the Electron shell the requested face is mounted + painted. The shell
  // holds the window hidden until this ack (or a short fallback) so it never
  // flashes the previous face before the swap. rAF defers to after paint; a
  // no-op in the browser (bridge() returns undefined off-desktop).
  useWatchEffect(() => {
    if (!isElectron()) return;
    const raf = requestAnimationFrame(() => bridge("paletteReady")?.(mode));
    return () => cancelAnimationFrame(raf);
  }, [mode, composeNonce]);

  if (mode === "compose") {
    return <ComposeView key={composeNonce} initialQuery={composeQuery} />;
  }
  return <CommandPalette standalone />;
}
