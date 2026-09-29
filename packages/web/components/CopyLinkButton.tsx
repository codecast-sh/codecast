"use client";

import { Link2 } from "lucide-react";
import { copyText } from "../lib/copyText";
import { sharePageUrl } from "../lib/utils";

/** An icon button that copies the public address of an in-app path (or a full URL). */
export function CopyLinkButton({ path, className = "" }: { path: string | (() => string); className?: string }) {
  return (
    <button
      type="button"
      onClick={() => void copyText(sharePageUrl(typeof path === "function" ? path() : path), "Link copied")}
      className={`p-1 rounded-md text-sol-text-dim hover:text-sol-cyan hover:bg-sol-bg-alt transition-colors ${className}`}
      title="Copy link"
      aria-label="Copy link"
    >
      <Link2 className="w-3.5 h-3.5" />
    </button>
  );
}
