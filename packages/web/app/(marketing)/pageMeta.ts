"use client";

import { useMountEffect } from "@/hooks/useMountEffect";

/**
 * The SPA has no head-management library, so real page metadata means writing
 * document.title and the description meta tag on mount — the honest equivalent of
 * a Next.js `metadata` export in this Vite build. Restores both on unmount so
 * navigating away doesn't leave a stale title behind.
 */
export function usePageMeta(title: string, description: string) {
  useMountEffect(() => {
    const prevTitle = document.title;
    const meta = document.querySelector('meta[name="description"]');
    const prevDesc = meta?.getAttribute("content") ?? null;

    document.title = title;
    if (meta && description) meta.setAttribute("content", description);

    return () => {
      document.title = prevTitle;
      if (meta && prevDesc !== null) meta.setAttribute("content", prevDesc);
    };
  });
}
