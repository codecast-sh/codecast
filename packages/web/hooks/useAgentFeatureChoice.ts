"use client";
// The Agents step's state (components/onboarding/ConnectStep), shared by the
// setup flow and the join flow.
import { useMemo, useState } from "react";
import { SNIPPET_CATALOG, snippetAvailableForTeams, type SnippetDescriptor } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";
import { useDevices } from "../components/DeviceBadge";
import { applyAgentFeatures, setPendingAgentFeatures } from "../components/onboarding/agentFeatures";

/** The agent features this person can have, given their teams' switches. */
export function useAvailableAgentFeatures(): SnippetDescriptor[] {
  const teams = useInboxStore((s) => s.teams);
  return useMemo(() => SNIPPET_CATALOG.filter((s) => snippetAvailableForTeams(s.slug, teams || [])), [teams]);
}

/** The Agents step's state, shared by every flow that hosts it: which
 *  features are chosen (all of them until unticked), and `commit`, which
 *  turns them on for machines online now, or keeps them for the first
 *  machine to connect (usePendingAgentFeatures). */
export function useAgentFeatureChoice() {
  const features = useAvailableAgentFeatures();
  const { devices } = useDevices();
  const [unchosen, setUnchosen] = useState<Set<string>>(() => new Set());
  const chosen = new Set(features.map((f) => f.slug).filter((s) => !unchosen.has(s)));
  return {
    chosen,
    total: features.length,
    allChosen: chosen.size === features.length,
    onToggle: (slug: string) => setUnchosen((u) => {
      const n = new Set(u);
      if (n.has(slug)) n.delete(slug); else n.add(slug);
      return n;
    }),
    onToggleAll: (on: boolean) => setUnchosen(on ? new Set() : new Set(features.map((f) => f.slug))),
    /** `all` takes every feature, whatever was unticked: the footer's "Turn on all". */
    commit: (all = false) => {
      const picked = all ? features : features.filter((f) => chosen.has(f.slug));
      applyAgentFeatures(devices, picked);
      if (!devices.some((d) => !d.is_remote && d.online && d.settings)) setPendingAgentFeatures(picked.map((f) => f.slug));
    },
  };
}

export type AgentFeatureChoice = ReturnType<typeof useAgentFeatureChoice>;

