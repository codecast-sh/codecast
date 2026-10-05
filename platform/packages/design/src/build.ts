// Writes tokens.css from the tokens. Run after any change to src/tokens.ts:
// `bun run build` in this package.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tokensCss } from "./css";

writeFileSync(join(import.meta.dir, "..", "tokens.css"), tokensCss());
