// A DM is named from its raw row through ONE function, dmRoomName
// (lib/chatViews.ts), which reads both the parties and whether the viewer only
// watches the room (a session's owner, a role's host) from the dm_key. A
// surface that hands channelDisplayName the parties itself (dmOtherIds) skips
// the watcher read and names an agent's one-to-one room "Alice, <session>"
// for its owner (ct-79021: the header, tab title, menu, toasts, recents and
// pins all did). Fix the surface by calling dmRoomName, never this list.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = [join(import.meta.dir, "../.."), join(import.meta.dir, "../../../mobile")];
const SKIP = new Set(["node_modules", ".vite", "dist", "build", "ios", "android", "__tests__", ".expo"]);
// The view builders that read dmWatcher beside dmOtherIds themselves.
const ALLOWED = new Set(["lib/chatViews.ts", "store/chatSelectors.ts"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("DM naming goes through dmRoomName", () => {
  test("no surface names a DM from dmOtherIds directly", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sources(root)) {
        const rel = relative(root, file);
        if (ALLOWED.has(rel)) continue;
        const src = readFileSync(file, "utf8");
        if (/channelDisplayName\([\s\S]{0,300}?dmOtherIds\(/.test(src)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
