"use client";
// /pages — gallery of the signed-in user's published pages
// (cast publish). Data: store.artifacts, fed by artifacts.listForWeb (hooks/useSyncArtifacts).

import { useState } from "react";
import { useArtifacts } from "../../hooks/useSyncArtifacts";
import { Globe } from "lucide-react";
import { ArtifactCard, type ArtifactRow } from "./ArtifactCard";
import { ArtifactEditModal } from "./ArtifactEditModal";
import { FeatureUpsell } from "../agentFeatures/FeatureUpsell";

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 text-center py-24 px-8">
      <Globe className="w-10 h-10 text-sol-text-dim opacity-40" />
      <div className="text-sol-text font-medium">No published pages yet</div>
      <div className="text-sm text-sol-text-muted max-w-md">
        Any page an agent publishes gets a stable link you can share. Publishing
        it again updates the same link and keeps every version.
      </div>
      <div className="text-sm text-sol-text-muted max-w-md">
        Ask an agent to publish a report, a mockup or a chart, and it shows up here.
      </div>
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
  // Store-fed (hooks/useSyncArtifacts): the gallery paints from the cached
  // set; the skeleton shows only for a genuinely cold cache.
  const { artifacts: rows, ready } = useArtifacts();
  const artifacts = rows as ArtifactRow[];
  const data = ready || artifacts.length > 0 ? { artifacts } : undefined;
  const mine = artifacts.filter((a) => a.mine);
  const team = artifacts.filter((a) => !a.mine);
  const [teamEditing, setTeamEditing] = useState<ArtifactRow | null>(null);

  return (
    <div className="py-6">
      <div className="flex items-baseline gap-3 mb-5">
        <h1 className="text-lg font-semibold text-sol-text">Pages</h1>
        {data && artifacts.length > 0 && (
          <span className="text-xs text-sol-text-dim font-mono">{artifacts.length}</span>
        )}
      </div>

      <FeatureUpsell
        slug="publish"
        className="mb-5"
        reason="Agents can publish their reports, dashboards and mockups here, each at a link you can share."
      />

      {data === undefined ? (
        <SkeletonGrid />
      ) : artifacts.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {mine.map((a) => (
              <ArtifactCard key={a.slug} artifact={a} />
            ))}
          </div>
          {team.length > 0 && (
            <>
              <div className="flex items-baseline gap-3 mt-8 mb-4">
                <h2 className="text-sm font-semibold text-sol-text-muted uppercase tracking-wide">Team</h2>
                <span className="text-xs text-sol-text-dim font-mono">{team.length}</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {team.map((a) => (
                  <ArtifactCard key={a.slug} artifact={a} onTeamEdit={setTeamEditing} />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {teamEditing && <ArtifactEditModal artifact={teamEditing} onClose={() => setTeamEditing(null)} />}
    </div>
  );
}
