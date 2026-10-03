// A token pair for the e2e person on the e2e deployment (target.ts), for a
// page's localStorage: `bun run e2e/tokens.ts > /tmp/e2e-tokens.json`.
import { mintTokens } from "../scripts/rig/auth.mjs";
import { dep, userId } from "./target";

console.log(JSON.stringify({ convexUrl: dep.convexUrl, tokens: await mintTokens(dep, userId) }));
