import { useCallback, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { NOT_CONFIRMED, type LoginPayload, type SecretPayload } from "@codecast/shared/contracts/secrets";
import { useEventListener } from "./useEventListener";
import { useWatchEffect } from "./useWatchEffect";
import { usePresence, withPresence } from "../lib/passkeyPresence";
import { vaultFailure } from "../components/secrets/vaultModel";
import { useSampleVault } from "../components/secrets/sampleVault";

/** How long revealed text stays in memory with no reveal or copy touching it. */
export const REVEAL_IDLE_MS = 45_000;

/**
 * A secret's value, held in this component's state only (never the store). The
 * value fields drop after REVEAL_IDLE_MS without a reveal or copy, when the
 * window loses focus, and when the component goes, moves to another secret or
 * the secret's value changes (`version`: its value_updated_at, which a replace
 * or restore moves).
 * A login's 2FA seed stays for the component's life, so its code keeps ticking
 * while the panel is open; `seed` is undefined until fetched, null when the
 * login has none. Each fetch records a reveal on the server before the value
 * leaves it. An Ask first secret (`askFirst`) confirms with Touch ID before
 * each fetch (lib/passkeyPresence); cancelled, the fetch answers null. A
 * sample Vault's value comes from the sample, with no server call or Touch ID.
 */
export function useReveal(id: string, version?: number, askFirst?: boolean) {
  const reveal = useAction(api.secrets.reveal);
  const confirm = usePresence();
  const sample = useSampleVault();
  const [payload, setPayload] = useState<SecretPayload | null>(null);
  const [seed, setSeed] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inflight = useRef<Promise<SecretPayload | null> | null>(null);
  // Bumped by every drop, so a fetch that lands after one is handed to its caller but not kept.
  const generation = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shown = `${id}@${version ?? ""}`;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const drop = useCallback(() => {
    clearTimeout(idle.current);
    generation.current++;
    setPayload(null);
    inflight.current = null;
  }, []);
  const touch = useCallback(() => {
    clearTimeout(idle.current);
    idle.current = setTimeout(drop, REVEAL_IDLE_MS);
  }, [drop]);
  useWatchEffect(() => {
    setSeed(undefined);
    setError(null);
    return drop;
  }, [shown]);
  useEventListener("blur", drop);
  const load = useCallback(async (): Promise<SecretPayload | null> => {
    if (payload) {
      touch();
      return payload;
    }
    if (inflight.current) return inflight.current;
    // Taken when the fetch starts, after any Touch ID prompt, whose sheet can blur the window.
    let gen = generation.current;
    const fetchValue = (grant?: string) => {
      gen = generation.current;
      return reveal({ ref: id, grant });
    };
    setLoading(true);
    setError(null);
    inflight.current = (sample ? Promise.resolve(sample.reveal(id)) : withPresence(() => confirm("reveal", id), fetchValue, !!askFirst))
      .then((res: any) => {
        if (res === NOT_CONFIRMED) return null;
        if (res?.error) {
          setError(res.error);
          return null;
        }
        const p = res.payload as SecretPayload;
        // A blur mid-fetch keeps the seed; moving to another secret or value does not.
        if (shown === shownRef.current) setSeed((p as LoginPayload).totp_seed ?? null);
        if (gen === generation.current) {
          setPayload(p);
          touch();
        }
        return p;
      })
      .catch((err: unknown) => {
        setError(vaultFailure(err).error);
        return null;
      })
      .finally(() => {
        setLoading(false);
        if (gen === generation.current) inflight.current = null;
      });
    return inflight.current;
  }, [id, shown, payload, reveal, touch, confirm, askFirst, sample]);
  return { payload, seed, error, loading, load, drop };
}
