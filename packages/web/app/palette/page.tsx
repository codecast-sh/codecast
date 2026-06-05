import { useCallback, useState } from "react";
import { CommandPalette } from "../../components/CommandPalette";
import { ComposeView } from "../../components/ComposeView";
import { ShortcutProvider } from "../../shortcuts";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useEnsureDispatch } from "../../hooks/useEnsureDispatch";
import { isElectron } from "../../lib/desktop";

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
  // The palette window hydrates the store from IDB but, unlike the main app
  // shell, never wires the server dispatch — so creating/sending a session here
  // would no-op (asyncAction returns undefined without a dispatch). Wire it so
  // the compose popup can start sessions on its own. Idempotent across windows.
  useEnsureDispatch();

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

  if (mode === "compose") {
    return <ComposeView key={composeNonce} initialQuery={composeQuery} />;
  }
  return <CommandPalette standalone />;
}
