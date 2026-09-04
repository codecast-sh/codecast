import { existsSync, readFileSync } from "node:fs";
import { extractNestedActions, isShellTool } from "@codecast/shared/render";
import { atomicWriteFile } from "./atomicWrite.js";
import type { ParsedMessage } from "./parser.js";

function shellCommands(source: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote = "";
  let heredoc = "";
  let wantHeredoc = false;
  const flushWord = () => {
    if (!word) return;
    if (wantHeredoc) { heredoc = word; wantHeredoc = false; }
    words.push(word);
    word = "";
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && /["\\$`]/.test(source[i + 1] || "")) word += source[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "\\") { word += source[++i] || ""; continue; }
    if (c === "#" && !word) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end - 1;
      continue;
    }
    if (c === "<" && source[i + 1] === "<") {
      flushWord();
      wantHeredoc = true;
      i += source[i + 2] === "-" ? 2 : 1;
      continue;
    }
    if (/\s|[;&|]/.test(c)) {
      flushWord();
      if (c === "\n" || /[;&|]/.test(c)) {
        if (words.length) commands.push(words);
        words = [];
        if (c === "\n" && heredoc) {
          let end = i + 1;
          while (end < source.length) {
            const next = source.indexOf("\n", end);
            const lineEnd = next < 0 ? source.length : next;
            if (source.slice(end, lineEnd).replace(/^\t+/, "") === heredoc) { i = lineEnd; break; }
            end = lineEnd + 1;
          }
          if (end >= source.length) i = source.length;
          heredoc = "";
        }
      }
    } else word += c;
  }
  flushWord();
  if (words.length) commands.push(words);
  return commands;
}

export function tmuxSpawns(messages: readonly ParsedMessage[]): Array<{ name: string; timestamp: number }> {
  const spawns: Array<{ name: string; timestamp: number }> = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      const outer = { name: call.name, input: JSON.stringify(call.input) };
      const nested = extractNestedActions(outer);
      for (const action of nested.length ? nested : [outer]) {
        if (!isShellTool(action.name)) continue;
        const input = JSON.parse(action.input);
        const source = input.command ?? input.cmd;
        if (typeof source !== "string") continue;
        for (const words of shellCommands(source)) {
          let name: string | undefined;
          if (/^(?:.*\/)?agent-spawn(?:\.sh)?$/.test(words[0])) name = words[2];
          if (words[0] === "tmux" && (words[1] === "new-session" || words[1] === "new")) {
            const at = words.indexOf("-s", 2);
            if (at >= 0) name = words[at + 1];
          }
          if (name && /^[\w.-]+$/.test(name)) spawns.push({ name, timestamp: message.timestamp });
        }
      }
    }
  }
  return spawns;
}

type Spawn = { parent: string; timestamp: number };

export class TmuxSpawnRegistry {
  private entries: Record<string, Spawn> | undefined;
  constructor(private file: string) {}

  private load(): Record<string, Spawn> {
    return this.entries ??= existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
  }

  hasEntries(): boolean {
    return Object.keys(this.load()).length > 0;
  }

  parentForPanes(panes: string, pids: readonly number[], startedAt: number): string | undefined {
    for (const line of panes.trim().split("\n")) {
      const [name, pid] = line.trim().split(/\s+/);
      if (!pids.includes(Number(pid))) continue;
      const parent = this.parent(name, startedAt);
      if (parent) return parent;
    }
    return undefined;
  }

  record(messages: readonly ParsedMessage[], parent: string): string[] {
    const spawns = tmuxSpawns(messages);
    if (!spawns.length) return [];
    const entries = this.load();
    for (const { name, timestamp } of spawns) {
      if ((entries[name]?.timestamp ?? 0) <= timestamp) entries[name] = { parent, timestamp };
    }
    atomicWriteFile(this.file, JSON.stringify(entries));
    return spawns.map(s => s.name);
  }

  parent(name: string, startedAt: number): string | undefined {
    const entry = this.load()[name];
    return entry && startedAt >= entry.timestamp && startedAt - entry.timestamp < 5 * 60_000
      ? entry.parent : undefined;
  }
}
