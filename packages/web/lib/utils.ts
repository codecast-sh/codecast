import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
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
