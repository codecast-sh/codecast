// The dashboard's filter as the URL holds it (`?f.day=30d&f.person=ada`), so
// a filtered view is a link to send, and how to change it.
import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { dashboard } from "@codecast/shared/artifacts";

const todayUtc = (now: number) => new Date(now).toISOString().slice(0, 10);

export function useDashboardScope(now: number) {
  const params = useSearchParams();
  const router = useRouter();
  const sig = params.toString();
  const today = todayUtc(now);
  const scope = useMemo(() => dashboard.scopeFromParams(new URLSearchParams(sig).entries(), today), [sig, today]);
  const value = useCallback((column: string) => new URLSearchParams(sig).get(`f.${column}`) ?? "", [sig]);
  const set = useCallback(
    (column: string, v: string | null) => {
      const next = new URLSearchParams(window.location.search);
      if (v) next.set(`f.${column}`, v);
      else next.delete(`f.${column}`);
      const q = next.toString();
      router.replace(`${window.location.pathname}${q ? `?${q}` : ""}`, { scroll: false });
    },
    [router],
  );
  const clear = useCallback(() => {
    const next = new URLSearchParams(window.location.search);
    for (const k of [...next.keys()]) if (k.startsWith("f.")) next.delete(k);
    const q = next.toString();
    router.replace(`${window.location.pathname}${q ? `?${q}` : ""}`, { scroll: false });
  }, [router]);
  return { scope, value, set, clear };
}

