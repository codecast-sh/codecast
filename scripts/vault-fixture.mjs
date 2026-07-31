#!/usr/bin/env node
// Generates a realistic Obsidian-style fixture vault for testing the codecast
// vault feature. Deterministic (seeded) so regenerating produces the same tree.
//
//   node scripts/vault-fixture.mjs [target-dir] [--notes N]
//
// Defaults to ~/vault-fixture with ~220 notes. Covers: nested folders, wiki
// links (plain, aliased, #heading, ^block, unresolved), embeds, tags (inline +
// frontmatter, nested), frontmatter property types, callouts, tasks, code
// blocks containing fake [[links]] (must NOT index), unicode/spacey filenames,
// duplicate basenames in different folders (resolution test), an image asset,
// and a daily-notes folder.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const notesFlag = args.indexOf("--notes");
const NOTE_TARGET = notesFlag >= 0 ? parseInt(args[notesFlag + 1], 10) : 220;
const target = args.find((a) => !a.startsWith("--") && a !== String(NOTE_TARGET)) || path.join(os.homedir(), "vault-fixture");

let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const TOPICS = ["Distributed Systems", "Gardening", "Rust", "Woodworking", "Espresso", "Type Theory", "Sailing", "Fermentation", "Photography", "Chess Openings"];
const FOLDERS = ["Projects", "Areas", "Resources", "Archive", "Daily", "People", "Books", "Projects/Codecast", "Resources/Papers", "Areas/Health"];
const TAGS = ["#status/draft", "#status/done", "#project", "#idea", "#book", "#person", "#recipe", "#deep-dive", "#review/weekly", "#til"];
const WORDS = "the quick brown fox jumps over lazy dog while contemplating existential questions about markdown parsing and link resolution in modern note taking applications with elegant typography".split(" ");

const sentence = (n) => {
  const s = Array.from({ length: n }, () => pick(WORDS)).join(" ");
  return s[0].toUpperCase() + s.slice(1) + ".";
};
const para = () => Array.from({ length: int(2, 5) }, () => sentence(int(8, 18))).join(" ");

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const f of FOLDERS) fs.mkdirSync(path.join(target, f), { recursive: true });

// Build the note name list first so links can point at real notes.
const names = [];
for (let i = 0; i < NOTE_TARGET; i++) {
  const topic = pick(TOPICS);
  names.push(`${topic} ${["Notes", "Overview", "Deep Dive", "Log", "Ideas", "Reference"][i % 6]} ${i}`);
}
// Special names: unicode, spaces/punctuation, duplicate basenames across folders.
names.push("Café Réunion — planning", "What's next?", "2026 Goals");
const dupA = "Projects/Meeting Notes";
const dupB = "Areas/Meeting Notes";

const noteFile = (name, folder) => path.join(target, folder, `${name}.md`);
const placed = new Map(); // name -> folder
names.forEach((n, i) => placed.set(n, FOLDERS[i % (FOLDERS.length - 2)]));

const wikiTargets = [...names, "Meeting Notes", "Unresolved Idea", "Ghost Note"];
const link = () => {
  const t = pick(wikiTargets);
  const r = rand();
  if (r < 0.15) return `[[${t}|${pick(["see this", "the details", "more"])}]]`;
  if (r < 0.25) return `[[${t}#Background]]`;
  if (r < 0.3) return `[[${t}#^key-claim]]`;
  return `[[${t}]]`;
};

function noteBody(name, i) {
  const fm = [
    "---",
    `title: ${name}`,
    `created: 2026-0${int(1, 7)}-${String(int(1, 28)).padStart(2, "0")}`,
    `tags: [${pick(TAGS).slice(1)}, ${pick(TAGS).slice(1)}]`,
    ...(rand() < 0.3 ? [`aliases: ["${name.split(" ")[0]} alias ${i}"]`] : []),
    ...(rand() < 0.2 ? ["rating: " + int(1, 5), "reviewed: " + (rand() < 0.5)] : []),
    "---",
  ].join("\n");
  const parts = [fm, "", `# ${name}`, "", `${para()} ${link()} and also ${link()}.`, ""];
  parts.push("## Background", "", `${para()} ${pick(TAGS)}`, "", `Key claim goes here. ^key-claim`, "");
  if (rand() < 0.4) parts.push(`> [!note] Worth remembering`, `> ${sentence(12)} ${link()}`, "");
  if (rand() < 0.3) parts.push("## Tasks", "", `- [ ] ${sentence(6)} ${link()}`, `- [x] ${sentence(5)}`, `- [ ] follow up on ${link()}`, "");
  if (rand() < 0.3) parts.push("```ts", `// [[Not A Link]] inside code must not index`, `const x = ${i};`, "```", "");
  if (rand() < 0.25) parts.push(`![[${pick(names)}]]`, "");
  if (rand() < 0.15) parts.push(`![[attachments/diagram.png]]`, "");
  parts.push("## Details", "", para(), "", `Related: ${link()}, ${link()}, ${pick(TAGS)}`, "");
  return parts.join("\n");
}

let count = 0;
for (const [name, folder] of placed) {
  fs.writeFileSync(noteFile(name, folder), noteBody(name, count++));
}
// Duplicate basenames (shortest-unique-name resolution test).
fs.writeFileSync(path.join(target, `${dupA}.md`), `# Meeting Notes (projects)\n\nProject standup. [[${names[0]}]]\n`);
fs.writeFileSync(path.join(target, `${dupB}.md`), `# Meeting Notes (areas)\n\nArea review. [[${names[1]}]]\n`);
// Daily notes.
for (let d = 1; d <= 14; d++) {
  const day = `2026-07-${String(d).padStart(2, "0")}`;
  fs.writeFileSync(path.join(target, "Daily", `${day}.md`), `# ${day}\n\n${para()}\n\n- [ ] daily task ${d}\n\nYesterday: [[2026-07-${String(Math.max(1, d - 1)).padStart(2, "0")}]]\n${d % 3 === 0 ? `\n${pick(TAGS)} ${link()}\n` : ""}`);
}
// Attachment.
fs.mkdirSync(path.join(target, "attachments"), { recursive: true });
// 1x1 red PNG.
fs.writeFileSync(path.join(target, "attachments", "diagram.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
// A note with edge-case markdown.
fs.writeFileSync(path.join(target, "Resources", "Edge Cases.md"), `---
title: Edge Cases
tags: [til]
list-prop:
  - one
  - two
checkbox-prop: true
link-prop: "[[${names[2]}]]"
---
# Edge Cases

Nested tag #review/weekly and a bare #til.

A [[${dupA.split("/")[1]}]] ambiguous link (two Meeting Notes exist).

| a | b |
|---|---|
| [[${names[3]}]] | value |

$e^{i\\pi} + 1 = 0$

> [!warning] Callout with a [[${names[4]}]] link
> And a nested list:
> - item one
> - item two

\`inline [[not-a-link]] code\`

***

Footnote reference[^1].

[^1]: The footnote body with [[${names[5]}]].
`);

const total = fs.readdirSync(target, { recursive: true }).filter((f) => String(f).endsWith(".md")).length;
console.log(`fixture vault: ${target} (${total} markdown files)`);
