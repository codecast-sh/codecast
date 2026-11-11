import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { useInboxStore } from "../store/inboxStore";
import { useTabContext } from "../lib/tabParams";
import { placeCrumbsSig } from "../lib/placeTitle";
import type { PlaceCrumb } from "../lib/navPlace";

/** The address of the page this hook runs in, with its query (the inbox's
 *  session lives in it). */
export function usePagePath(): string {
  const tabCtx = useTabContext();
  const pathname = usePathname();
  if (!tabCtx) return pathname;
  const q = tabCtx.searchParams.toString();
  return q ? `${tabCtx.pathname}?${q}` : tabCtx.pathname;
}

/** The crumbs above a page (lib/navPlace), named from the store. Subscribes to
 *  the crumbs as one string, so only a change in what they say re-renders. */
export function usePlaceCrumbs(path?: string): PlaceCrumb[] {
  const own = usePagePath();
  const at = path ?? own;
  const sig = useInboxStore((s) => placeCrumbsSig(s, at));
  return useMemo(
    () =>
      sig
        ? sig.split("\x1f").map((part) => {
            const [label, href, more, mono] = part.split("\x1e");
            return { label, href: href || undefined, more: more === "1" ? (true as const) : undefined, mono: mono === "1" || undefined };
          })
        : [],
    [sig],
  );
}
