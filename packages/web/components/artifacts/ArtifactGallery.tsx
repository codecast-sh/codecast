"use client";
// /artifacts — gallery of the signed-in user's published artifacts
// (cast publish). Data: api.artifacts.listForWeb (authed convex query).

import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { Copy, Globe } from "lucide-react";
import { ArtifactCard, type ArtifactRow } from "./ArtifactCard";

const EXAMPLE_CMD = "cast publish report.html";

function EmptyState() {
  const copyExample = async () => {
    try {
      await navigator.clipboard.writeText(EXAMPLE_CMD);
      toast.success("Command copied");
    } catch {
      toast.error("Couldn't copy");
    }
  };
  return (
    <div className="flex flex-col items-center justify-center gap-3 text-center py-24 px-8">
      <Globe className="w-10 h-10 text-sol-text-dim opacity-40" />
      <div className="text-sol-text font-medium">No published artifacts yet</div>
      <div className="text-sm text-sol-text-muted max-w-md">
        Publish any HTML file, markdown doc, or directory from a session and it
        gets a stable shareable link. Re-publishing the same file updates the
        same URL, with full version history.
      </div>
      <button
        onClick={copyExample}
        className="group inline-flex items-center gap-2 text-[13px] font-mono bg-sol-bg-alt border border-sol-border/40 rounded px-4 py-2 text-sol-text hover:border-sol-border transition-colors"
        title="Copy command"
      >
        <span>{EXAMPLE_CMD}</span>
        <Copy className="w-3.5 h-3.5 text-sol-text-dim group-hover:text-sol-text-muted" />
      </button>
      <div className="text-xs text-sol-text-dim max-w-md">
        Viewer comments arrive back in the publishing session as messages.
      </div>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg border border-sol-border/30 overflow-hidden animate-pulse"
        >
          <div className="aspect-[1.91/1] bg-sol-bg-alt/60" />
          <div className="p-3 space-y-2">
            <div className="h-3.5 w-2/3 rounded bg-sol-bg-alt/60" />
            <div className="h-3 w-1/2 rounded bg-sol-bg-alt/40" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ArtifactGallery() {
  const data = useQuery(api.artifacts.listForWeb);
  const artifacts = (data?.artifacts ?? []) as ArtifactRow[];

  return (
    <div className="py-6">
      <div className="flex items-baseline gap-3 mb-5">
        <h1 className="text-lg font-semibold text-sol-text">Artifacts</h1>
        {data && artifacts.length > 0 && (
          <span className="text-xs text-sol-text-dim font-mono">{artifacts.length}</span>
        )}
        <span className="ml-auto text-[11px] text-sol-text-dim font-mono hidden sm:inline">
          cast publish &lt;file&gt;
        </span>
      </div>

      {data === undefined ? (
        <SkeletonGrid />
      ) : artifacts.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {artifacts.map((a) => (
            <ArtifactCard key={a.slug} artifact={a} />
          ))}
        </div>
      )}
    </div>
  );
}
