// Becoming a visitor: make a secret, prove a little work over its hash
// (convex/lib/proof) and register it, meeting a harder proof when the
// deployment asks for one during a flood. The shell and the scripts share it.
import type { Id } from "../../convex/_generated/dataModel";
import { newSecret, sha256Hex } from "../../convex/lib/identity";
import { PROOF_BITS, solveProof } from "../../convex/lib/proof";
import { errorData } from "./errors";

export async function mintVisitor(
  register: (args: { secret: string; nonce: number }) => Promise<{ visitor_id: Id<"visitors"> }>,
): Promise<{ visitor_id: Id<"visitors">; secret: string }> {
  const secret = newSecret();
  const hash = await sha256Hex(secret);
  for (let bits = PROOF_BITS; ; ) {
    const nonce = await solveProof(hash, bits);
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
