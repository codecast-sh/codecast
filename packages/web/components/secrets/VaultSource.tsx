"use client";
// Which Vault a tree shows: an agent's tab (lib/agentTabGuard) gets a sample
// Vault of its own (sampleVault.ts), its session pills resolved from the
// sample too; a person's tab gets the real one, unwrapped.

import { useMemo, type ReactNode } from "react";
import { useAgentDrivenTab } from "../../lib/agentTabGuard";
import { EntityFixtureContext } from "../../lib/entityDisplay";
import { SAMPLE_ENTITIES, SampleVaultContext, createSampleVault } from "./sampleVault";

export function VaultSource({ children }: { children: ReactNode }) {
  const agentTab = useAgentDrivenTab();
  const sample = useMemo(() => (agentTab ? createSampleVault() : null), [agentTab]);
  if (!sample) return <>{children}</>;
  return (
    <SampleVaultContext.Provider value={sample}>
      <EntityFixtureContext.Provider value={SAMPLE_ENTITIES}>{children}</EntityFixtureContext.Provider>
    </SampleVaultContext.Provider>
  );
}
