// This checkout's repository, and how the CLI names PRs from it: a PR here
// reads "#42", one in any other repository "owner/repo#42", so a wait on
// another repository's PR is never mistaken for this one's (task-graph.md TG12).

import { execFileSync } from "./proc.js";
import { repositoryKeyOfRemote } from "@codecast/shared/contracts";
import { prWords, type WaitLabelOptions } from "@codecast/shared/tasks";

/** This checkout's repository (`owner/name`), or null outside one. */
export function checkoutRepository(cwd: string): string | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return repositoryKeyOfRemote(url);
  } catch {
    return null;
  }
}

const wordsByCwd = new Map<string, WaitLabelOptions>();

/** The wait-label options for output read in `cwd`, asked of git once per directory. */
export function checkoutWords(cwd: string = process.cwd()): WaitLabelOptions {
  let words = wordsByCwd.get(cwd);
  if (!words) wordsByCwd.set(cwd, (words = prWords(checkoutRepository(cwd))));
  return words;
}
