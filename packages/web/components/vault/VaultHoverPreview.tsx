// Hover preview for wiki links: hold the pointer on a link and the target note
// floats up in a scrollable card — Obsidian's "page preview". The feel lives in
// three details: a deliberate delay IN (no flicker while scanning text), a
// forgiving delay OUT with a hover bridge (moving the pointer from link to card
// must not dismiss it), and edge collision (the card flips/clamps to stay on
// screen). Nested previews are capped at one level.

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { FileText } from "lucide-react";
import { useVaultStore } from "../../store/vaultStore";
import { VaultMarkdown, VaultLinkContext } from "./VaultMarkdown";
import { noteDisplayName } from "./VaultExplorer";
import { splitFrontmatter } from "../../lib/vault/frontmatter";
import { useVaultLinkCtx } from "./useVaultLinkCtx";

const SHOW_DELAY_MS = 420;
const HIDE_DELAY_MS = 280;
const CARD_W = 400;
const CARD_MAX_H = 320;
const EDGE_PAD = 12;

interface HoverPreviewApi {
  onLinkEnter: (el: HTMLElement, path: string) => void;
  onLinkLeave: () => void;
}

const HoverPreviewContext = createContext<HoverPreviewApi | null>(null);
const PreviewDepthContext = createContext(0);

export function useHoverPreview(): HoverPreviewApi | null {
  return useContext(HoverPreviewContext);
}

function previewPosition(anchor: DOMRect): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchor.left;
  if (left + CARD_W + EDGE_PAD > vw) left = Math.max(EDGE_PAD, vw - CARD_W - EDGE_PAD);
  let top = anchor.bottom + 6;
  if (top + CARD_MAX_H + EDGE_PAD > vh) {
    // Flip above when there's more room there.
    const above = anchor.top - 6 - CARD_MAX_H;
    if (above > EDGE_PAD || anchor.top > vh - anchor.bottom) top = Math.max(EDGE_PAD, above);
  }
  return { left, top };
}

function PreviewCard({
  path,
  pos,
  onEnter,
  onLeave,
  onNavigate,
}: {
  path: string;
  pos: { left: number; top: number };
  onEnter: () => void;
  onLeave: () => void;
  onNavigate: (path: string) => void;
}) {
  const body = useVaultStore((s) => s.bodies[path]);
  const [, markdown] = useMemo(() => splitFrontmatter(body?.content ?? ""), [body?.content]);
  const depth = useContext(PreviewDepthContext);
  // The card gets its own full link context — without it every wiki link, tag
  // pill, and vault image inside a preview was dead (review finding, R5).
  const linkCtx = useVaultLinkCtx(path, onNavigate);

  return createPortal(
    <div
      className="fixed z-[80] rounded-md border border-sol-border/50 bg-sol-card shadow-xl overflow-hidden"
      style={{ left: pos.left, top: pos.top, width: CARD_W, maxHeight: CARD_MAX_H }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      data-vault-hover-preview
    >
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-sol-text-muted bg-sol-bg-alt/60 border-b border-sol-border/30">
        <FileText className="w-3 h-3" />
        <span className="truncate">{noteDisplayName(path.split("/").pop()!)}</span>
        <span className="ml-auto text-[10px] text-sol-text-dim truncate max-w-[45%]">
          {path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""}
        </span>
      </div>
      <div className="overflow-y-auto px-3 py-2" style={{ maxHeight: CARD_MAX_H - 34 }}>
        {body ? (
          <PreviewDepthContext.Provider value={depth + 1}>
            <VaultLinkContext.Provider value={linkCtx}>
              <div className="vault-prose prose prose-sm max-w-none text-[12px]">
                <VaultMarkdown content={markdown} />
              </div>
            </VaultLinkContext.Provider>
          </PreviewDepthContext.Provider>
        ) : (
          <div className="text-xs text-sol-text-dim py-4">Note not loaded.</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export const HoverPreviewProvider = memo(function HoverPreviewProvider({
  children,
  onNavigate,
}: {
  children: React.ReactNode;
  /** Navigating from inside a preview drives the main view. */
  onNavigate: (path: string) => void;
}) {
  const [active, setActive] = useState<{ path: string; pos: { left: number; top: number } } | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const depth = useContext(PreviewDepthContext);

  const cancelTimers = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    showTimer.current = null;
    hideTimer.current = null;
  };

  const onLinkEnter = useCallback((el: HTMLElement, path: string) => {
    cancelTimers();
    const rect = el.getBoundingClientRect();
    showTimer.current = setTimeout(() => {
      setActive({ path, pos: previewPosition(rect) });
    }, SHOW_DELAY_MS);
  }, []);

  const scheduleHide = useCallback(() => {
    if (showTimer.current) clearTimeout(showTimer.current);
    hideTimer.current = setTimeout(() => setActive(null), HIDE_DELAY_MS);
  }, []);

  const keepOpen = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  // One nested level: a preview's own links still preview, but not further.
  const api = useMemo<HoverPreviewApi | null>(
    () => (depth >= 2 ? null : { onLinkEnter, onLinkLeave: scheduleHide }),
    [depth, onLinkEnter, scheduleHide],
  );

  return (
    <HoverPreviewContext.Provider value={api}>
      {children}
      {active && (
        <PreviewCard
          path={active.path}
          pos={active.pos}
          onEnter={keepOpen}
          onLeave={scheduleHide}
          onNavigate={(p) => {
            setActive(null);
            onNavigate(p);
          }}
        />
      )}
    </HoverPreviewContext.Provider>
  );
});
