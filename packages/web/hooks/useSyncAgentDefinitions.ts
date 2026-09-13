// Agent definitions and chains: feeder + readers.
//
// Two workspace wide snapshot queries (registry entries `agentDefinitions`
// and `agentChains`), mounted once by HostFeeders. Readers go through
// useWorkspaceCollection because both collections are workspace scoped.

import { useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { AgentChainSpec, AgentDefinitionSpec } from "@codecast/shared/contracts";
import { useSyncCollection } from "./useSyncCollection";
import { useWorkspaceCollection } from "./useWorkspaceCollection";

export interface AgentDefinitionRow extends AgentDefinitionSpec {
  _id: string;
  short_id: string;
  workspace?: string;
  team_id?: string;
  user_id?: string;
  client_key?: string;
  created_at: number;
  updated_at: number;
}

export interface AgentChainRow extends AgentChainSpec {
  _id: string;
  short_id: string;
  workspace?: string;
  team_id?: string;
  user_id?: string;
  client_key?: string;
  created_at: number;
  updated_at: number;
}

export function useSyncAgentDefinitions(enabled = true) {
  useSyncCollection("agentDefinitions", api.agentDefinitions.list, enabled ? {} : "skip");
  useSyncCollection("agentChains", api.agentDefinitions.listChains, enabled ? {} : "skip");
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** Rows re-render on the fields the library and choosers show. */
export const agentDefinitionSig = (d: any) =>
  `${d.name}|${d.description}|${d.agent ?? ""}|${d.model ?? ""}|${d.effort ?? ""}|${d.mode ?? ""}|${d.updated_at ?? 0}`;
export const agentChainSig = (c: any) => `${c.name}|${c.description}|${(c.steps ?? []).length}|${c.updated_at ?? 0}`;

export function useAgentDefinitions(): AgentDefinitionRow[] {
  const rows = useWorkspaceCollection<AgentDefinitionRow>("agentDefinitions", agentDefinitionSig);
  return useMemo(() => [...rows].sort(byName), [rows]);
}

export function useAgentChains(): AgentChainRow[] {
  const rows = useWorkspaceCollection<AgentChainRow>("agentChains", agentChainSig);
  return useMemo(() => [...rows].sort(byName), [rows]);
}
