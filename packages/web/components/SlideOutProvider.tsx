import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSlideOutStore } from "../store/slideOutStore";

const ROUTE_MAP: Record<string, string> = { plan: "/plans", task: "/tasks" };

export function SlideOutProvider() {
  const router = useRouter();
  const pendingNav = useSlideOutStore((s) => s.pendingNav);
  const clearNav = useSlideOutStore((s) => s.clearNav);

  useEffect(() => {
    if (pendingNav) {
      const base = ROUTE_MAP[pendingNav.type] || `/${pendingNav.type}s`;
      router.push(`${base}/${pendingNav.id}`);
      clearNav();
    }
  }, [pendingNav, router, clearNav]);

  return null;
}
