import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every create the app offers (New menu, the palette's Create group, a board's
// "+") sets store.createModal and relies on one host to draw it. The host
// once lived in the desktop Sidebar: phones, which mount no Sidebar, got no
// dialog at all, and "doc" had no branch anywhere, so New → Doc did nothing.
const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");
const store = read("store/inboxStore.ts");
const layout = read("components/DashboardLayout.tsx");
// The host and its dialogs live beside the shell; the shell mounts it.
const hosts = read("components/shell/ShellHosts.tsx");

const kinds = (() => {
  const m = store.match(/export type CreateModalKind\s*=\s*([^;]+);/);
  return m ? [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] ?? x[2]) : [];
})();

test("every create kind has a dialog in the shell's host", () => {
  expect(kinds.length).toBeGreaterThan(3);
  const host = hosts.slice(hosts.indexOf("function CreateModal("), hosts.indexOf("function PaletteHost("));
  expect(host.length).toBeGreaterThan(0);
  for (const kind of kinds) expect({ kind, drawn: host.includes(`kind === "${kind}"`) }).toEqual({ kind, drawn: true });
});

test("the host is mounted once, outside any rail, so it exists at every width", () => {
  expect(layout.match(/<CreateModalHost \/>/g)).toHaveLength(1);
  expect(hosts).not.toMatch(/<CreateModalHost \/>/);
  expect(read("components/Sidebar.tsx")).not.toMatch(/createModal ===|CreateTaskModal|CreateDocModal/);
});
