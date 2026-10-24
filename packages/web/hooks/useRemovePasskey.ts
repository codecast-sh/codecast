import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { NOT_CONFIRMED, removableUnasked, type PasskeyMeta } from "@codecast/shared/contracts/secrets";
import { usePresence, withPresence } from "../lib/passkeyPresence";

/** Hours left of a passkey's probation, rounded up. */
export const probationHours = (p: PasskeyMeta) => Math.ceil(((p.probation_until ?? 0) - Date.now()) / 3_600_000);

/** Remove a passkey: with Touch ID, or with one press when it went in with no grant (removableUnasked). `count` is how many the person has. */
export function useRemovePasskey(passkey: PasskeyMeta, count: number) {
  const remove = useMutation(api.passkeys.remove);
  const confirm = usePresence();
  const unasked = removableUnasked(passkey, count);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drop = async () => {
    setRemoving(true);
    try {
      const res: any = await withPresence(() => confirm("remove_passkey", passkey._id), (grant) => remove({ id: passkey._id, grant }), !unasked);
      setError(res === NOT_CONFIRMED ? null : res?.error ?? null);
    } finally {
      setRemoving(false);
    }
  };
  return { drop, removing, error, unasked };
}
