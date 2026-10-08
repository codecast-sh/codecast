// Solves a registration's proof of work off the page (mint.ts solveOffThread).
import { solveProof } from "../../convex/lib/proof";

const scope = self as unknown as { onmessage: (e: MessageEvent<{ secretHash: string; bits: number }>) => void; postMessage: (nonce: number) => void };

scope.onmessage = async (e) => {
  // Nothing else runs here, so it never needs to pause for a frame.
  scope.postMessage(await solveProof(e.data.secretHash, e.data.bits, Number.MAX_SAFE_INTEGER));
};
