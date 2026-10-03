#!/usr/bin/env bun
// Flag the next web deploy as one that asks open windows to reload now.
//
//   bun packages/web/scripts/release-prompt.ts "Fixes the crash when a session is deleted."
//
// Bumps release-prompt.json's generation and sets the card's line. Commit it
// with the change it announces. Every window running a bundle older than this
// generation shows the card once; routine deploys (no bump) stay silent and
// apply when the window next hides. See lib/updatePrompt.tsx.
import path from "node:path";
import { bumpReleasePrompt } from "@platform/update-prompt/build";

const message = process.argv.slice(2).join(" ").trim();
if (!message) {
  console.error('usage: bun packages/web/scripts/release-prompt.ts "<one line the card shows>"');
  process.exit(1);
}
const next = bumpReleasePrompt(path.resolve(import.meta.dir, "../release-prompt.json"), message);
console.log(`release prompt generation ${next.generation}: ${next.message}`);
