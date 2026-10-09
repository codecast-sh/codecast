// Becoming a visitor: make a secret, prove a little work over its hash
// (convex/lib/proof) and register it, meeting a harder proof when the
// deployment asks for one during a flood. The shell and the scripts share it;
// the shell solves in a worker (solveOffThread).
import type { Id } from "../../convex/_generated/dataModel";
import { newSecret, sha256Hex } from "../../convex/lib/identity";
import { PROOF_BITS, solveProof } from "../../convex/lib/proof";
import { errorData } from "./errors";

type Solve = (secretHash: string, bits: number) => Promise<number>;

export async function mintVisitor(
  register: (args: { secret: string; nonce: number }) => Promise<{ visitor_id: Id<"visitors"> }>,
  solve: Solve = solveProof,
): Promise<{ visitor_id: Id<"visitors">; secret: string }> {
  const secret = newSecret();
  const hash = await sha256Hex(secret);
  for (let bits = PROOF_BITS; ; ) {
    const nonce = await solve(hash, bits);
    try {
      const { visitor_id } = await register({ secret, nonce });
      return { visitor_id, secret };
    } catch (err) {
      const asked = errorData(err).proof_bits;
      if (!asked || asked <= bits) throw err;
      bits = asked;
    }
  }
}

/** Solve in a worker, so the work never holds up the page's first frames;
 *  on the page itself, in slices, where a worker cannot start. */
export const solveOffThread: Solve = (secretHash, bits) =>
  new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./proof.worker.ts", import.meta.url), { type: "module" });
    } catch {
      return resolve(solveProof(secretHash, bits));
    }
    const done = (nonce: number | Promise<number>) => {
      worker.terminate();
      resolve(nonce);
    };
    worker.onmessage = (e: MessageEvent<number>) => done(e.data);
    worker.onerror = () => done(solveProof(secretHash, bits));
    worker.postMessage({ secretHash, bits });
  });
