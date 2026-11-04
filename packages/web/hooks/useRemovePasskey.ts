import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { NOT_CONFIRMED, type PasskeyMeta } from "@codecast/shared/contracts/secrets";
import { usePresence, withPresence } from "../lib/passkeyPresence";

/** Remove a passkey, confirmed with Touch ID. */
export function useRemovePasskey(passkey: PasskeyMeta) {
  const remove = useMutation(api.passkeys.remove);
  const confirm = usePresence();
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drop = async () => {
    setRemoving(true);
    try {
      const res: any = await withPresence(() => confirm("remove_passkey", passkey._id), (grant) => remove({ id: passkey._id, grant }), true);
      setError(res === NOT_CONFIRMED ? null : res?.error ?? null);
    } finally {
      setRemoving(false);
    }
  };
  return { drop, removing, error };
}
