import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { LoginPayload, SecretKind, SecretMeta } from "@codecast/shared/contracts/secrets";
import type { VaultScope } from "./useSyncSecrets";
import { useInboxStore } from "../store/inboxStore";
import { useSampleVault } from "../components/secrets/sampleVault";
import { vaultFailure } from "../components/secrets/vaultModel";

/** Paint the row, create it, and settle the stub on the answer. Resolves with the error sentence, or null. A sample Vault adds it to the sample. */
export function useCreate(scope: VaultScope) {
  const create = useAction(api.secrets.create);
  const me = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : ""));
  const sample = useSampleVault();
  return async (where: "team" | "personal", fields: { name: string; kind: SecretKind; payload: unknown; env?: string[]; sites?: string[]; note?: string }) => {
    if (sample) return sample.create(where, fields);
    const { stageSecret, settleSecretStub } = useInboxStore.getState();
    const now = Date.now();
    const stubId = `sec_stub_${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const team = where === "team" ? scope.team : null;
    const { payload, ...meta } = fields;
    stageSecret({
      _id: stubId,
      short_id: undefined as unknown as string,
      status: "ready",
      workspace: team ? team.key : scope.personal!,
      team_id: team?.id,
      created_by: me,
      created_at: now,
      updated_at: now,
      ...meta,
      env: meta.env?.length ? meta.env : undefined,
      sites: meta.sites?.length ? meta.sites : undefined,
      note: meta.note?.trim() || undefined,
      has_otp: fields.kind === "login" ? !!(payload as LoginPayload).totp_seed : undefined,
    } as SecretMeta);
    const res: any = await create({ ...fields, ...(team ? { team_id: team.id as any } : { personal: true }) }).catch(vaultFailure);
    settleSecretStub(stubId, res?.error ? null : res.short_id);
    return res?.error ? (res.error as string) : null;
  };
}
