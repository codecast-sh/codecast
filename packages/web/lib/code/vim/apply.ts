// Applying a parsed vimrc to the vim engine, and taking it back off.
//
// codemirror-vim keeps maps, options and ex commands global, so a config is
// applied once for every editor. Everything an apply adds is recorded, and
// the next apply removes exactly that first: the engine's defaults and the
// built-in plugins are never touched.

import { Vim } from "@replit/codemirror-vim";
import type { CodeVimrcResponse } from "@codecast/shared/contracts";
import { addMap, getMapTimeout, installKeyLayer, removeMap, setMapTimeout, type LayerMap } from "./keyLayer";
import { installExAdapters, runAdapterNamed } from "./exAdapters";
import { notify } from "./engine";
import { commandKeyName, ensureCommandKeys, installPlugins, DEFAULT_KEYS } from "./plugins";
import { clipboardSyncEnabled, setClipboardSync } from "./clipboard";
import { installRuntimeOptions } from "./editorOptions";
import { parseVimrc, type VimrcSourceInput } from "./parse";
import type { ParsedVimrc, VimConfigReport, VimDirectiveReport, VimReportCounts } from "./types";

let ready = false;

/** Install the engine-wide pieces once: plugins, ex adapters, the key layer. */
export function installVimEngine(): void {
  if (ready) return;
  ready = true;
  installKeyLayer();
  installExAdapters();
  installPlugins();
  installRuntimeOptions();
}

interface Applied {
  maps: LayerMap[];
  aliases: string[];
  engineOptions: Map<string, unknown>;
  timeout?: { previous: number | null };
  clipboard?: { previous: boolean };
}

let applied: Applied | null = null;

const aliasBodies = new Map<string, string>();
const aliasesDefined = new Set<string>();
let aliasDepth = 0;

function defineAlias(name: string): void {
  if (aliasesDefined.has(name)) return;
  aliasesDefined.add(name);
  // The engine keeps one handler per name, so an alias that a later config
  // drops falls back to the adapter it shadowed.
  Vim.defineEx(name, name, (cm, params) => {
    const body = aliasBodies.get(name);
    if (!body) {
      if (!runAdapterNamed(name, cm, params.argString ?? "")) notify(cm, `Not an editor command: ${name}`);
      return;
    }
    if (aliasDepth > 8) return;
    const args = (params.argString ?? "").trim();
    const placeholder = /<(q-|f-)?args>/i.test(body);
    const input = placeholder
      ? body.replace(/<q-args>/gi, JSON.stringify(args)).replace(/<f-args>/gi, args.split(/\s+/).map((a) => JSON.stringify(a)).join(", ")).replace(/<args>/gi, args)
      : `${body}${args ? ` ${args}` : ""}`;
    aliasDepth++;
    try {
      Vim.handleEx(cm, input);
    } finally {
      aliasDepth--;
    }
  });
}

function removeApplied(): void {
  if (!applied) return;
  for (let i = applied.maps.length - 1; i >= 0; i--) removeMap(applied.maps[i]);
  for (const name of applied.aliases) aliasBodies.delete(name);
  for (const [name, previous] of applied.engineOptions) Vim.setOption(name, previous);
  if (applied.timeout) setMapTimeout(applied.timeout.previous);
  if (applied.clipboard) setClipboardSync(applied.clipboard.previous);
  applied = null;
}

function counts(directives: VimDirectiveReport[]): VimReportCounts {
  const c: VimReportCounts = { applied: 0, translated: 0, skipped: 0, total: directives.length };
  for (const d of directives) c[d.status]++;
  return c;
}

/** Apply a parsed config to the vim engine, replacing whatever the last
 *  apply added. Returns the report Settings shows. */
export function applyVimConfig(parsed: ParsedVimrc): VimConfigReport {
  installVimEngine();
  removeApplied();
  const state: Applied = { maps: [], aliases: [], engineOptions: new Map() };
  applied = state;
  const mapped = { normal: new Set<string>(), visual: new Set<string>() };

  const sources = parsed.sources.map((src) => {
    const directives: VimDirectiveReport[] = src.directives.map((d) => {
      let { status, detail } = d;
      for (const e of d.effects) {
        switch (e.kind) {
          case "map":
            try {
              ensureCommandKeys(e.rhs);
              state.maps.push(addMap(e.lhs, e.rhs, e.context, { noremap: e.noremap, nowait: e.nowait }));
              if (e.context === "normal" || e.context === undefined) mapped.normal.add(e.lhs);
              if (e.context === "visual" || e.context === undefined) mapped.visual.add(e.lhs);
            } catch (err) {
              status = "skipped";
              detail = `the vim engine refused it: ${(err as Error).message}`;
            }
            break;
          case "unmap": {
            const i = state.maps.findLastIndex((m) => m.lhs === e.lhs && m.context === e.context);
            if (i >= 0) {
              removeMap(state.maps[i]);
              state.maps.splice(i, 1);
            }
            break;
          }
          case "engineOption":
            if (!state.engineOptions.has(e.name)) state.engineOptions.set(e.name, Vim.getOption(e.name) ?? (e.name === "langmap" ? "" : 0));
            Vim.setOption(e.name, e.value);
            break;
          case "timeout":
            state.timeout ??= { previous: getMapTimeout() };
            setMapTimeout(e.ms);
            break;
          case "clipboard":
            state.clipboard ??= { previous: clipboardSyncEnabled() };
            setClipboardSync(e.on);
            break;
          case "exAlias":
            aliasBodies.set(e.name, e.body);
            defineAlias(e.name);
            state.aliases.push(e.name);
            break;
        }
      }
      return { line: d.line, text: d.text, status, detail };
    });
    return {
      path: src.path,
      ...(src.sourcedFrom ? { sourcedFrom: src.sourcedFrom } : {}),
      ...(src.overlay ? { overlay: true } : {}),
      ...(src.truncated ? { truncated: true } : {}),
      directives,
      counts: counts(directives),
    };
  });

  // Language, hunk and agent keys, unless the vimrc claims them.
  for (const d of DEFAULT_KEYS) {
    const lhs = d.lhs.replace("<leader>", parsed.leader);
    const context = d.context ?? "normal";
    if (mapped[context].has(lhs)) continue;
    const key = commandKeyName(d.command);
    ensureCommandKeys(key);
    state.maps.push(addMap(lhs, key, context));
  }

  const all = sources.flatMap((s) => s.directives);
  return {
    sources,
    counts: counts(all),
    options: parsed.options,
    leader: parsed.leader,
    localLeader: parsed.localLeader,
    empty: all.length === 0,
  };
}

/** The built-in bindings with no vimrc at all, until one is applied. */
export function ensureVimDefaults(): void {
  if (!applied) applyVimConfig({ sources: [], options: { global: {}, byFiletype: {} }, leader: "\\", localLeader: "\\" });
}

/** Parse a daemon response: its sources in order, then the overlay. */
export function parseVimConfig(response: CodeVimrcResponse): ParsedVimrc {
  const inputs: VimrcSourceInput[] = response.sources.map((s) => ({ ...s }));
  if (response.overlay) inputs.push({ ...response.overlay, overlay: true });
  return parseVimrc(inputs);
}

/** Parse and apply a daemon response. */
export function loadVimConfig(response: CodeVimrcResponse): VimConfigReport {
  return applyVimConfig(parseVimConfig(response));
}

