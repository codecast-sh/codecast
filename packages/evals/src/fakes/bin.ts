#!/usr/bin/env bun
// The executable the dry-run guard asks before it refuses a write
// (DRY_RUN_FAKE=<this file>). It answers one `cast` call from the fake and
// keeps the run's world beside its calls.log:
//
//   DRY_RUN_FAKE_WORLD  the world file (default $RUN_DIR/fake-world.json)
//   DRY_RUN_FAKE_TREE   the CLI's command tree (cast agent-context --json)
//   DRY_RUN_FAKE_SEED   a WorldSeed JSON file the first call starts from
//
// Exit 125 with no output: not modelled, the guard goes on as before.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DECLINE_EXIT, openFake, wantsStdin } from './cast';
import { readTree } from './cast/tree';

const argv = process.argv.slice(2);
const runDir = process.env.RUN_DIR || process.cwd();
const worldPath = process.env.DRY_RUN_FAKE_WORLD || join(runDir, 'fake-world.json');
const tree = readTree(process.env.DRY_RUN_FAKE_TREE || join(runDir, '.cast-help', 'agent-context.json'));
if (!tree) process.exit(DECLINE_EXIT);
const seedPath = process.env.DRY_RUN_FAKE_SEED;
const fake = openFake({ worldPath, tree, seed: seedPath && existsSync(seedPath) ? JSON.parse(readFileSync(seedPath, 'utf8')) : undefined });
const stdin = wantsStdin(argv) ? await new Response(Bun.stdin.stream()).text() : '';
const a = fake(argv, stdin);
if (!a) process.exit(DECLINE_EXIT);
process.stdout.write(a.out);
process.exit(a.exit);
