// The stage's screen share button, and the picker the desktop shell opens
// from it: whole screens as previews, windows as a list filtered by typing.
import { useRef, useState } from "react";
import { AppWindow, MonitorUp } from "lucide-react";
import { setScreenShare } from "../../lib/calls/callManager";
import { usePressOutside } from "../../hooks/usePressOutside";
import { STAGE_CTL, STAGE_CTL_IDLE } from "./stageHost";
import type { DesktopDisplaySource } from "../../lib/desktop";

export function StageShareButton({ sharing }: { sharing: boolean }) {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<DesktopDisplaySource[] | null>(null);
  const bridge = typeof window !== "undefined" ? window.__CODECAST_ELECTRON__ : undefined;
  const canPick = !!bridge?.getDisplaySources && !!bridge?.selectDisplaySource;

  const onClick = async () => {
    if (sharing) return void setScreenShare(false);
    if (!canPick) return void setScreenShare(true);
    setOpen(true);
    setSources(null);
    try {
      setSources(await bridge!.getDisplaySources!({ types: ["screen", "window"] }));
    } catch {
      setSources([]);
    }
  };

  return (
    <span className="relative">
      <button
        onClick={() => void onClick()}
        className={`${STAGE_CTL} ${
          sharing ? "bg-sol-violet/15 text-sol-violet hover:bg-sol-violet/25" : STAGE_CTL_IDLE
        }`}
        title={sharing ? "Stop sharing" : "Share your screen"}
      >
        <MonitorUp className="h-[18px] w-[18px]" />
      </button>
      {open && (
        <SharePicker
          sources={sources}
          onClose={() => setOpen(false)}
          onPick={(id) => {
            setOpen(false);
            void setScreenShare(true, id);
          }}
        />
      )}
    </span>
  );
}

/** A capture preview, or the source's icon on a quiet tile when the shell
 *  sent none: an empty image serializes as a bare `data:image/png;base64,`,
 *  which Chromium draws as a broken image. */
function ShareThumb({ src, icon: Icon, className }: { src: string; icon: typeof MonitorUp; className: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !src || src.endsWith("base64,")) {
    return (
      <span className={`flex items-center justify-center bg-sol-text/[0.04] ${className}`}>
        <Icon className="h-5 w-5 text-sol-text-dim" />
      </span>
    );
  }
  return <img src={src} alt="" onError={() => setFailed(true)} className={`object-cover ${className}`} />;
}

/** Screens and windows are different choices, so they get different shapes:
 *  whole screens as a row of large previews, windows as a scannable list with
 *  the app's icon and full title, filtered by typing. The shell lists windows
 *  front to back, so the one you were just in is already near the top. */
function SharePicker({
  sources,
  onClose,
  onPick,
}: {
  sources: DesktopDisplaySource[] | null;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  usePressOutside(rootRef, true, onClose, { escape: true });

  const screens = sources?.filter((s) => s.kind === "screen") ?? [];
  const q = query.trim().toLowerCase();
  const windows = (sources ?? []).filter((s) => s.kind === "window" && (!q || s.name.toLowerCase().includes(q)));
  const windowCount = sources?.filter((s) => s.kind === "window").length ?? 0;

  return (
    <div
      ref={rootRef}
      className="absolute bottom-full left-1/2 z-10 mb-3 max-h-[calc(100dvh-120px)] w-[min(440px,calc(100vw-24px))] -translate-x-1/2 overflow-y-auto rounded-xl bg-sol-bg-alt p-2.5 shadow-2xl ring-1 ring-sol-text/5"
    >
      {sources === null ? (
        <div className="px-1 py-6 text-center text-meta text-sol-text-muted">Looking…</div>
      ) : sources.length === 0 ? (
        <div className="px-1 py-6 text-center text-meta text-sol-text-muted">
          Nothing to share. Check Screen Recording permission in System Settings
        </div>
      ) : (
        <>
          {screens.length > 0 && (
            <section>
              <div className="mb-1.5 px-1 text-meta font-medium text-sol-text-muted">Entire screen</div>
              <div className={`grid gap-2 ${screens.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
                {screens.map((src, i) => (
                  <button
                    key={src.id}
                    onClick={() => onPick(src.id)}
                    className="group flex flex-col gap-1.5 rounded-lg border border-sol-text/5 p-1.5 text-left transition-colors hover:border-sol-violet/60 hover:bg-sol-violet/10"
                    title={src.name}
                  >
                    <ShareThumb
                      src={src.thumbnail}
                      icon={MonitorUp}
                      className={`w-full rounded-md ${screens.length === 1 ? "aspect-[16/7]" : "aspect-video"}`}
                    />
                    <span className="flex items-center gap-1.5 px-0.5 text-meta text-sol-text-muted group-hover:text-sol-text">
                      <MonitorUp className="h-3 w-3 shrink-0" />
                      <span className="truncate">{screens.length === 1 ? "Your entire screen" : `Screen ${i + 1}`}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {windowCount > 0 && (
            <section className={screens.length > 0 ? "mt-3 border-t border-sol-text/5 pt-2.5" : ""}>
              <div className="mb-1.5 flex items-center gap-2 px-1">
                <span className="text-meta font-medium text-sol-text-muted">
                  Windows <span className="text-sol-text-dim">· {windowCount}</span>
                </span>
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && windows[0]) onPick(windows[0].id);
                  }}
                  placeholder="Find a window…"
                  className="ml-auto h-6 w-40 rounded-md bg-sol-text/5 px-2 text-meta text-sol-text outline-none ring-1 ring-sol-text/5 placeholder:text-sol-text-dim focus:ring-sol-violet/50"
                  style={{ fontVariantLigatures: "none" }}
                />
              </div>
              <div className="max-h-[260px] space-y-0.5 overflow-y-auto">
                {windows.length === 0 ? (
                  <div className="px-1 py-3 text-center text-meta text-sol-text-muted">No window matches "{query}"</div>
                ) : (
                  windows.map((src, i) => (
                    <button
                      key={src.id}
                      onClick={() => onPick(src.id)}
                      className={`group flex w-full items-center gap-2.5 rounded-md p-1 text-left transition-colors hover:bg-sol-violet/10 ${
                        q && i === 0 ? "bg-sol-violet/10" : ""
                      }`}
                      title={src.name}
                    >
                      <ShareThumb src={src.thumbnail} icon={AppWindow} className="h-9 w-16 shrink-0 rounded ring-1 ring-sol-text/5" />
                      {src.appIcon ? (
                        <img src={src.appIcon} alt="" className="h-4 w-4 shrink-0" />
                      ) : (
                        <AppWindow className="h-4 w-4 shrink-0 text-sol-text-dim" />
                      )}
                      <span className="line-clamp-2 min-w-0 text-meta leading-snug text-sol-text-muted group-hover:text-sol-text">
                        {src.name || "Untitled window"}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
