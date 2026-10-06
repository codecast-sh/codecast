import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// `authority_events` is append only and has ONE writer, lib/authorityEvents.ts
// (recordAuthorityEvent), so that every row is written inside the mutation
// that changed authority and nothing rewrites history. Nothing in the type
// system stops the next `ctx.db.insert("authority_events", …)` or a patch of a
// row read off the table, so this reads the source of every convex module.

const WRITER = "lib/authorityEvents.ts";
const INSERT = /\.insert\(\s*["'`]authority_events["'`]/;
// A patch or delete whose target was read off the table: the id comes from a
// row named `event`/`ev`/`row` in a file that queries the table, or the call
// names the table in the same statement.
const TABLE = /["'`]authority_events["'`]/;
const PATCH_OR_DELETE = /\.(patch|delete|replace)\(/;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "_generated" || name === "node_modules") continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) sources(abs, out);
    else if (/\.ts$/.test(name) && !/\.(test|testing)\.ts$/.test(name)) out.push(abs);
  }
  return out;
}

describe("authority_events has one writer and is append only", () => {
  const files = sources(import.meta.dir);
  const offenders: string[] = [];
  for (const abs of files) {
    const rel = abs.slice(import.meta.dir.length + 1);
    const src = readFileSync(abs, "utf8");
    if (rel === WRITER) {
      expect(INSERT.test(src)).toBe(true);
      if (PATCH_OR_DELETE.test(src)) offenders.push(`${rel}: the writer may only insert`);
      continue;
    }
    if (rel === "schema.ts") continue;
    if (INSERT.test(src)) offenders.push(`${rel}: inserts into authority_events`);
    // Any file that names the table and also patches or deletes something is
    // suspect: the read query is the only reader and it writes nothing.
    if (TABLE.test(src) && PATCH_OR_DELETE.test(src)) offenders.push(`${rel}: names authority_events and patches or deletes`);
  }
  test("no file outside the writer inserts, patches or deletes", () => {
    expect(offenders).toEqual([]);
  });
});
