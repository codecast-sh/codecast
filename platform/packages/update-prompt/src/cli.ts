#!/usr/bin/env bun
// Flag the next deploy as one that asks open windows to reload now.
//
//   platform-release-prompt <path/to/release-prompt.json> "Fixes the crash when a session is deleted."
import { bumpReleasePrompt } from "./build";

const [file, ...words] = process.argv.slice(2);
const message = words.join(" ").trim();
if (!file || !message) {
  console.error('usage: platform-release-prompt <release-prompt.json> "<one line the card shows>"');
  process.exit(1);
}
const next = bumpReleasePrompt(file, message);
console.log(`release prompt generation ${next.generation}: ${next.message}`);
