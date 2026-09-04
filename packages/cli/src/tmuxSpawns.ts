import { existsSync, readFileSync } from "node:fs";
import { extractNestedActions, isShellTool } from "@codecast/shared/render";
import { atomicWriteFile } from "./atomicWrite.js";
import type { ParsedMessage } from "./parser.js";
import type { EventEmitter } from "node:events";
import { threadItemToMessage, type ThreadItem } from "./codexAppServer.js";

function shellCommands(source: string, depth = 0): string[][] {
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
    if (c === "'" || c === '"' || c === "`") { if (c === "`") word += c; quote = c; continue; }
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
  return commands.flatMap(words => {
    if (depth >= 4 || !/^(?:.*\/)?(?:ba|z|da|k)?sh$/.test(words[0])) return [words];
    for (let at = 1; at < words.length; at++) {
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(words[at])) {
        return words[at + 1] ? shellCommands(words[at + 1], depth + 1) : [words];
      }
      if (!/^-[a-zA-Z]+$|^--(?:noprofile|norc|login)$/.test(words[at])) break;
    }
    return [words];
  });
}

function agentSpawnName(words: string[]): string | undefined {
  let at = 1;
  for (; at < words.length && words[at].startsWith("-"); at++) {
    const option = words[at];
    if (option === "--") { at++; break; }
    if (option === "--codex" || option === "--claude" || /^--(?:runtime|model)=.+/.test(option)) continue;
    if (option === "--runtime" || option === "--model") {
      if (!words[++at] || words[at].startsWith("--")) return undefined;
      continue;
    }
    return undefined;
  }
  return words[at + 1];
}

export function registerAppServerSpawnTracking(
  server: EventEmitter,
  parentForThread: (threadId: string) => string | undefined,
  track: (messages: ParsedMessage[], parent: string) => Promise<void>,
  onError: (err: unknown) => void,
): void {
  server.on("itemStarted", (threadId: string, _turnId: string, item: ThreadItem) => {
    const parent = parentForThread(threadId);
    if (!parent) return;
    const message = threadItemToMessage(item);
    if (message) void track([message], parent).catch(onError);
  });
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
          if (/^(?:.*\/)?agent-spawn(?:\.sh)?$/.test(words[0])) name = agentSpawnName(words);
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
    return this.entries ??= Object.assign(Object.create(null), existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {});
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
    let changed = false;
    for (const { name, timestamp } of spawns) {
      if ((entries[name]?.timestamp ?? 0) <= timestamp && (entries[name]?.parent !== parent || entries[name]?.timestamp !== timestamp)) {
        entries[name] = { parent, timestamp };
        changed = true;
      }
    }
    if (changed) atomicWriteFile(this.file, JSON.stringify(entries));
    return spawns.map(s => s.name);
  }

  parent(name: string, startedAt: number): string | undefined {
    const entry = this.load()[name];
    return entry && startedAt >= entry.timestamp && startedAt - entry.timestamp < 5 * 60_000
      ? entry.parent : undefined;
  }
}
