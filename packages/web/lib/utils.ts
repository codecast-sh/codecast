import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Compact relative age, e.g. "now", "3m", "2h", "5d" (no "ago" suffix — meant
// for tight badges/chips). For full "3m ago" phrasing add the suffix at the
// call site.
export function relTimeShort(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

export function shareOrigin(): string {
  return "https://codecast.sh";
}

export function canonicalUrl(): string {
  if (typeof window === "undefined") return shareOrigin();
  return `${shareOrigin()}${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export async function copyToClipboard(text: string): Promise<void> {
  // Sync execCommand first - must run before dropdown/popup closes and shifts focus
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(textArea);
  if (ok) return;

  // Async Clipboard API fallback (only available in secure contexts)
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
  }
}
