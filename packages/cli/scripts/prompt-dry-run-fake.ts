#!/usr/bin/env bun
// One call to a run's fake, in a process of its own. prompt-dry-run.ts runs
// this per call inside the closed world (no network, no home, a clean env,
// writes only in the fake's own dir), so the fake's code, however it was
// written, can only answer wrongly: it reaches nothing. It imports the --fake
// module, answers the argv with its openFake, and prints the answer as JSON,
// or exits 125 when the fake does not model the call.
//
//   bun prompt-dry-run-fake.ts <module> <world.json> <tree.json> <seed.json|""> <argv...>   (stdin: the call's stdin)
import { readFileSync } from "node:fs";

const [mod, worldPath, treePath, seedPath, ...argv] = process.argv.slice(2);
if (!mod || !worldPath || !treePath) throw new Error("usage: prompt-dry-run-fake.ts <module> <world.json> <tree.json> <seed.json|\"\"> <argv...>");
const { openFake } = await import(mod);
const stdin = await new Response(Bun.stdin.stream()).text();
const a = openFake({ worldPath, tree: JSON.parse(readFileSync(treePath, "utf8")), seed: seedPath ? JSON.parse(readFileSync(seedPath, "utf8")) : undefined })(argv, stdin);
if (!a) process.exit(125);
process.stdout.write(JSON.stringify({ out: a.out, exit: a.exit, ...(a.cli ? { cli: true } : {}) }));
process.exit(0);
