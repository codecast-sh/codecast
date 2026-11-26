// A page's filters ride its address, so a copied link opens the view on screen. A bare address (the sidebar, a
// bookmark, a link that names no filter) opens the filters the viewer last chose on that page, and is rewritten in
// place to name them, so a copy of it opens them too. Each change is saved per viewer in the ui prefs bag
// (page_filters, stamped, so it follows them to every device), in the address's own encoding.
import { useMemo } from "react";
import { useInboxStore, type ClientUI } from "../store/inboxStore";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { usePathname, useRouter } from "next/navigation";

type Params = { get(name: string): string | null; toString(): string };
/** The ui bag's key: the filters last chosen on each page, by page, in address encoding. */
type PageFilterPrefs = { page_filters?: Record<string, string> };

const named = (params: Params | null | undefined, keys: readonly string[]) => keys.some((k) => params?.get(k) != null);

/** The address's filters when it names any of `keys`; else the viewer's last ones laid over the address. */
export function withRemembered(params: Params | null | undefined, keys: readonly string[], last: Params | null): URLSearchParams {
  const out = new URLSearchParams(params?.toString() ?? "");
  if (!last || named(out, keys)) return out;
  for (const k of keys) {
    const v = last.get(k);
    if (v !== null) out.set(k, v);
  }
  return out;
}

/** `href` (a path, or a whole URL) naming the viewer's last filters when it names none of `keys`, as a path; null when
 *  it needs no rewrite. */
export function addressNaming(href: string, keys: readonly string[], last: Params | null): string | null {
  const url = new URL(href, "http://local");
  const opened = withRemembered(url.searchParams, keys, last).toString();
  if (opened === url.searchParams.toString()) return null;
  return url.pathname + (opened ? `?${opened}` : "") + url.hash;
}

/** The filters `values` names (a null is a default, left out), in address encoding. */
export function encodeFilters(values: Record<string, string | null>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== null) out.set(k, v);
  return out.toString();
}

/** Save `values` as the filters the viewer last chose on `page`. */
export function rememberFilters(page: string, values: Record<string, string | null>): void {
  const s = useInboxStore.getState();
  const all = (s.clientState.ui as PageFilterPrefs | undefined)?.page_filters ?? {};
  const qs = encodeFilters(values);
  if (all[page] !== qs) s.updateClientUI({ page_filters: { ...all, [page]: qs } } as Partial<ClientUI>);
}

/** The filters `page` opens with: the address's when it names any of `keys`, else the viewer's last ones (saved with
 *  rememberFilters). A bare address is rewritten to name the remembered filters once they are known. */
export function useRememberedFilters(page: string, keys: readonly string[], params: Params | null | undefined): URLSearchParams {
  const saved = useInboxStore((s) => (s.clientState.ui as PageFilterPrefs | undefined)?.page_filters?.[page]);
  const last = useMemo(() => (saved === undefined ? null : new URLSearchParams(saved)), [saved]);
  const address = params?.toString() ?? "";
  const opened = useMemo(() => withRemembered(new URLSearchParams(address), keys, last), [address, keys, last]);
  // Through the router, never window.location: a hidden or prewarmed pane rewrites only its own tab's address.
  const router = useRouter();
  const pathname = usePathname();
  useWatchEffect(() => {
    const next = addressNaming(pathname + (address ? `?${address}` : ""), keys, last);
    if (next) router.replace(next, { scroll: false });
  }, [pathname, address, keys, last, router]);
  return opened;
}
