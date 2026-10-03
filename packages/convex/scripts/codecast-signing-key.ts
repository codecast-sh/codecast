// Prints a new private signing key for CODECAST_SIGNING_KEY (external-data.md
// X8, signed requests). Set it on prod from packages/convex without writing it
// to a file (run.sh explains why CONVEX_DEPLOYMENT is unset):
//
//   env -u CONVEX_DEPLOYMENT npx convex env set CODECAST_SIGNING_KEY "$(bun scripts/codecast-signing-key.ts ck-2026-10)"
//
// To rotate, set the env var to a JSON array with the new key first and the
// old one second; drop the old one after five minutes.
import { generateSigningKey } from "@codecast/shared/contracts/codecastSignature";

const key = await generateSigningKey(process.argv[2]);
process.stdout.write(JSON.stringify(key));
