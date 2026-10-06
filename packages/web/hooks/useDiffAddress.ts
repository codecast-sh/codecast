// A diff page's addresses: which file and which lines the URL names, how the
// page moves to them, and how a reader hands them to someone else.
//
// A pull request's Files view and a commit page are both a stack of file
// cards in one scroller, and both keep the place in the fragment
// (`#diff-src/a.ts:R12-R20`, lib/prView). This hook is that shared half: it
// reads the fragment, writes it when lines are picked, lands the page on it
// (in a browser and in the app's tab shell alike), and answers `y` (copy a
// link to exactly this) and Escape (let go of the lines).
import { useCallback, useMemo, useRef, type RefObject } from "react";
import { useRouter } from "next/navigation";
import type { DiffFlow } from "../components/FileDiffLayout";
import { useRepoLocation } from "../components/repo/useRepoFamily";
import { formatDiffHash, parseDiffHash } from "../lib/prView";
import { type DiffLineAnchor } from "../lib/patchParser";
import { toStandaloneHref } from "../lib/repoView";
import { sharePageUrl } from "../lib/utils";
import { copyText } from "../lib/copyText";
import { useEventListener } from "./useEventListener";
import { useWatchEffect } from "./useWatchEffect";
import { keyBelongsElsewhere } from "../shortcuts/keyOwnership";
import { useFollowSurface } from "./useFollowSurface";

export function useDiffAddress({
  diffHref,
  here,
  ready,
  rootRef,
  stickyTop,
}: {
  /** The page that shows the diff, carrying a fragment, in this page's family. */
  diffHref: (hash: string) => string;
  /** The diff is the view on screen. Elsewhere a trip to it is a new page. */
  here: boolean;
  /** The files are in hand, so there is something to land on. */
  ready: boolean;
  /** The page's one scroller, or any element inside it. */
  rootRef: RefObject<HTMLElement | null>;
  /** Pixels of sticky chrome above the diff. */
  stickyTop: number;
}) {
  const router = useRouter();
  const loc = useRepoLocation();
  const target = useMemo(() => parseDiffHash(loc.hash), [loc.hash]);
  // Set when the page itself rewrote the fragment for a line click, so the
  // landing below leaves the view where the reader is looking.
  const quietHash = useRef<string | null>(null);

  /** Move to a file, or lines in it. A fragment changes in place (a bookmark,
   *  not a step back); arriving from another view is a step. */
  const goTo = useCallback((file: string, anchor?: DiffLineAnchor, opts?: { scroll?: boolean }) => {
    const hash = formatDiffHash({ file, anchor });
    if (opts?.scroll === false) quietHash.current = hash;
    if (here) router.replace(diffHref(hash), { scroll: false });
    else router.push(diffHref(hash));
  }, [router, diffHref, here]);

  /** A link someone else can open: the public form, whatever form this page is in. */
  const shareUrl = useCallback(
    (href: string) => sharePageUrl(loc.family === "standalone" ? href : toStandaloneHref(href)),
    [loc.family],
  );

  useEventListener("keydown", (e: KeyboardEvent) => {
    // A background tab keeps its copy mounted under display: none.
    if (!rootRef.current?.offsetParent) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (keyBelongsElsewhere(el)) return;
    // y: a link to exactly what is on screen. The desktop app has no address
    // bar, so this is how a place in it gets handed to someone.
    if (e.key === "y") {
      e.preventDefault();
      void copyText(shareUrl(`${loc.pathname}${loc.search}${loc.hash}`), target?.anchor ? "Link to the lines copied" : "Link copied");
      return;
    }
    // Escape lets go of the selected lines, and the address drops them too.
    if (e.key === "Escape" && here && target?.anchor) {
      goTo(target.file, undefined, { scroll: false });
    }
  });

  // Land on what the address names. The row may not exist yet (the diff is
  // still arriving, or cards above it have not measured their real height),
  // so keep correcting until the target stops moving. A timer, not a frame
  // callback: a page opened in a background tab still lands by the time it
  // is looked at.
  useWatchEffect(() => {
    if (!ready || !here || !target) return;
    if (quietHash.current && decodeURIComponent(quietHash.current) === decodeURIComponent(loc.hash)) {
      quietHash.current = null;
      return;
    }
    const lineId = target.anchor
      ? formatDiffHash({ file: target.file, anchor: { side: target.anchor.side, lineNumber: target.anchor.lineNumber } }).slice(1)
      : null;
    const fileId = formatDiffHash({ file: target.file }).slice(1);
    return landOn(
      () => {
        const inner = rootRef.current;
        return inner?.closest<HTMLElement>("[data-main-scroll]") ?? inner;
      },
      (root) => (lineId && root.querySelector<HTMLElement>(`[id="${CSS.escape(lineId)}"]`))
        || root.querySelector<HTMLElement>(`[id="${CSS.escape(fileId)}"]`),
      // A line sits a third of the way down, with the lines before it in view
      // for context; a file starts right under the sticky chrome. A line not
      // on screen yet (its card still arriving) has not landed.
      (el, root) => (lineId && el.id === lineId ? Math.max(stickyTop + 80, root.clientHeight / 3) : stickyTop + 12),
      // Once the file's rows are drawn and the line is not among them (it
      // sits in an unchanged stretch the diff leaves out), it is not coming.
      (el) => !lineId || el.id === lineId || !!el.querySelector(".cc-diff-target"),
    );
  }, [ready, here, loc.hash]);

  // Follow mode (lib/follow.ts): the file and line the address names are the
  // reader's place in the diff. A follower moves the address the way a click
  // would; when the leader's scroll comes with it, the scroll places the page
  // and the address only marks the lines.
  useFollowSurface(
    {
      read: () => (target ? { diff: { file: target.file, line: target.anchor?.lineNumber } } : null),
      apply: (view) => {
        const want = view.diff;
        if (!want || !here) return [];
        const anchor: DiffLineAnchor | undefined = want.line ? { side: "RIGHT", lineNumber: want.line } : undefined;
        goTo(want.file, anchor, { scroll: !view.scroll });
        return ["diff"];
      },
    },
    here,
    [target?.file, target?.anchor?.lineNumber],
  );

  const flow: DiffFlow = {
    stickyTop,
    fileId: (path) => formatDiffHash({ file: path }).slice(1),
    rowId: (path, anchor) => formatDiffHash({ file: path, anchor: { side: anchor.side, lineNumber: anchor.lineNumber } }).slice(1),
    fileAnchorHref: (path) => diffHref(formatDiffHash({ file: path })),
    lineHref: (path, anchor) => diffHref(formatDiffHash({ file: path, anchor })),
    shareUrl,
    selected: target,
    onSelectLines: (path, anchor) => goTo(path, anchor, { scroll: false }),
    onJumpFile: (path) => goTo(path),
  };

  return { loc, target, goTo, flow };
}

/**
 * Scroll `root` until `find`'s element sits `margin` below its top, and hold
 * it there while the page settles: the element may not exist yet (its data is
 * still arriving), and content above it grows as it renders (file cards start
 * at an estimated height). It lets go as soon as the reader moves the page
 * themselves, after a stretch of real stillness, or at the deadline.
 * Timers, not frame callbacks: a page opened in a background tab still lands
 * by the time it is looked at. Returns the cancel.
 */
export function landOn(
  getRoot: () => HTMLElement | null | undefined,
  find: (root: HTMLElement) => HTMLElement | null | undefined,
  margin: (el: HTMLElement, root: HTMLElement) => number,
  final: (el: HTMLElement) => boolean = () => true,
): () => void {
  const deadline = Date.now() + 8000;
  // Still for this long counts as settled: long enough for the cards above
  // the target to take their real height.
  const SETTLED_MS = 1500;
  let stillSince = 0;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listening: HTMLElement | null = null;
  const letGo = () => { cancelled = true; };
  const INTENT = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
  const step = () => {
    const root = getRoot();
    if (cancelled || !root) return;
    if (!listening) {
      listening = root;
      for (const type of INTENT) root.addEventListener(type, letGo, { passive: true });
    }
    const el = find(root);
    if (el) {
      const delta = el.getBoundingClientRect().top - root.getBoundingClientRect().top - margin(el, root);
      const before = root.scrollTop;
      if (Math.abs(delta) > 2) root.scrollTop += delta;
      // On the mark, or against the top or bottom of the page.
      if (Math.abs(delta) <= 2 || root.scrollTop === before) {
        if (!stillSince) stillSince = Date.now();
        else if (Date.now() - stillSince >= SETTLED_MS && final(el)) return cleanup();
      } else stillSince = 0;
    }
    if (Date.now() < deadline) timer = setTimeout(step, 50);
    else cleanup();
  };
  const cleanup = () => {
    if (listening) for (const type of INTENT) listening.removeEventListener(type, letGo);
    listening = null;
  };
  step();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    cleanup();
  };
}
