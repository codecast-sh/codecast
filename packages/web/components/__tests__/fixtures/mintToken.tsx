import { useState } from "react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { MintTokenButton, type MintFlow } from "../../MintTokenDialog";

export const mintCalls: Array<{ name: string; args: any }> = [];
export function MintTokenHarness({ publicKey = "", initiallyPending = true, startGate }: { publicKey?: string; initiallyPending?: boolean; startGate?: Promise<void> }) {
  const [flow, setFlow] = useState<MintFlow | null>(initiallyPending ? {
    status: "pending", profile: "work", email: "work@example.com", started_at: Date.now(), url: "https://claude.ai/oauth/authorize?fixture=1",
  } : null);
  // The machine's heartbeat: which profiles have a minted token on file.
  const [onFile, setOnFile] = useState<Record<string, number>>({});
  const profiles = [{ name: "work", email: "work@example.com" }, { name: "home", email: "home@example.com" }]
    .map(p => onFile[p.name] ? { ...p, setup_token: { stored_at: onFile[p.name], expires_at: onFile[p.name] + 365 * 86_400_000 } } : p);
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
      if (name === "accountSwitch:submitMintCode") {
        setFlow(current => current ? { ...current, status: "confirmed", finished_at: Date.now() } : null);
        setOnFile(current => ({ ...current, work: Date.now() }));
      }
      if (name === "accountSwitch:removeSetupToken") setOnFile(({ [args.profile]: _, ...rest }) => rest);
      return {};
    },
  } as unknown as ConvexReactClient;
  const device = { device_id: "fixture-mini", label: "Mac Mini", online: true, profiles, mint_flow: flow, provider_key_pubkey: publicKey };
  return <ConvexProvider client={client}><MintTokenButton device={device} profile={profiles[0]} /></ConvexProvider>;
}
