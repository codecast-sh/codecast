import { useState } from "react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { MintTokenButton, type MintFlow } from "../../MintTokenDialog";

export const mintCalls: Array<{ name: string; args: any }> = [];
export function MintTokenHarness({ publicKey = "", initiallyPending = true, startGate }: { publicKey?: string; initiallyPending?: boolean; startGate?: Promise<void> }) {
  const [flow, setFlow] = useState<MintFlow | null>(initiallyPending ? {
    status: "pending", profile: "work", email: "work@example.com", started_at: Date.now(), url: "https://claude.ai/oauth/authorize?fixture=1",
  } : null);
  const profiles = [{ name: "work", email: "work@example.com" }, { name: "home", email: "home@example.com" }];
  const client = {
    mutation: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      mintCalls.push({ name, args });
      if (name === "accountSwitch:requestMintToken") {
        await startGate;
        const started_at = Date.now();
        setFlow({ status: "pending", profile: args.profile, started_at, url: "https://claude.ai/oauth/authorize?fixture=1" });
        return { started_at };
      }
      if (name === "accountSwitch:cancelMintToken") setFlow(current => current ? { ...current, status: "cancelled" } : null);
      if (name === "accountSwitch:submitMintCode") setFlow(current => current ? { ...current, status: "confirmed", finished_at: Date.now() } : null);
      return {};
    },
  } as unknown as ConvexReactClient;
  const device = { device_id: "fixture-mini", label: "Mac Mini", online: true, profiles, mint_flow: flow, provider_key_pubkey: publicKey };
  return <ConvexProvider client={client}><MintTokenButton device={device} profile={profiles[0]} /></ConvexProvider>;
}
