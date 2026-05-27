import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Mentions (@person, #task, doc/plan/session refs) render as bare `<a href>`
 * anchors -- both from the TipTap React node view (MentionNodeView) and from the
 * serialized HTML path (mention node renderHTML). A bare anchor click triggers a
 * native full-page navigation, which reboots the whole SPA (blank screen +
 * websocket reconnect) instead of routing client-side. That's why clicking a
 * person pill "doesn't go anywhere reasonable".
 *
 * This installs ONE capture-phase listener that intercepts clicks on mention
 * anchors and routes them through the app router (`router.push`), which handles
 * tab routing / React Router. Capture phase runs before ProseMirror's own click
 * handling, so it works inside the editor (editable or read-only) as well as in
 * chat messages and anywhere else mentions are rendered.
 */
export const MENTION_ANCHOR_SELECTOR =
  "a.editor-mention, a.mention-card, a.mention-inline, a[data-mention-id]";

/**
 * Pure decision: given a (matched mention) anchor's href/target and the click
 * modifiers, should we intercept and route client-side? Extracted so the policy
 * is unit-testable without a DOM. Returns the internal path to push, or null to
 * let the browser handle the click natively.
 */
export function resolveMentionClickNavigation(opts: {
  defaultPrevented: boolean;
  button: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  href: string | null;
  target?: string | null;
}): string | null {
  // Respect modified clicks (open-in-new-tab) and non-primary buttons.
  if (opts.defaultPrevented || opts.button !== 0) return null;
  if (opts.metaKey || opts.ctrlKey || opts.shiftKey || opts.altKey) return null;
  if (opts.target === "_blank") return null;
  // Only handle internal app paths; let external links behave normally.
  if (!opts.href || !opts.href.startsWith("/")) return null;
  return opts.href;
}

export function useMentionLinkNavigation() {
  const router = useRouter();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.(MENTION_ANCHOR_SELECTOR) as
        | HTMLAnchorElement
        | null;
      if (!anchor) return;

      const path = resolveMentionClickNavigation({
        defaultPrevented: e.defaultPrevented,
        button: e.button,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        href: anchor.getAttribute("href"),
        target: anchor.target,
      });
      if (!path) return;

      e.preventDefault();
      router.push(path);
    };

    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, [router]);
}
