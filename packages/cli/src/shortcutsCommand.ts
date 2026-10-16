// `cast shortcuts`: read and change the person's codecast keyboard bindings from
// any session, so "make Ctrl+H go to the next session" is one command an agent
// can run. The write lands in the same synced preference the app's keyboard
// settings write (convex/keyBindings.ts), so every open window rebinds at once.
//
//   cast shortcuts [query] [--changed] [--json]
//   cast shortcuts find <chord>
//   cast shortcuts set <action> <chord...> [--steal | --keep-both]
//   cast shortcuts add <action> <chord> [--steal | --keep-both]
//   cast shortcuts unbind <action>
//   cast shortcuts reset [<action> | --all]
import type { Command } from "commander";
import { SHORTCUTS } from "@codecast/shared/contracts/shortcutCatalog";
import {
  actionsForChord,
  applyKeyBindings,
  currentChords,
  defaultChords,
  findConflicts,
  formatChord,
  parseChord,
  reservedReason,
  resetAction,
  resolveAction,
  setActionChords,
  type KeyBindingOverride,
} from "@codecast/shared/contracts/keyBindings";
import { apiPost, type PublishDeps } from "./castApi.js";
import { commandGroup } from "./commandGroups.js";

const isMac = process.platform === "darwin";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function readBindings(deps: PublishDeps): Promise<KeyBindingOverride[]> {
  const res = await apiPost(deps, "/cli/keys/get", {}, { read: true });
  return Array.isArray(res?.key_bindings) ? res.key_bindings : [];
}

async function writeBindings(deps: PublishDeps, list: KeyBindingOverride[]): Promise<void> {
  await apiPost(deps, "/cli/keys/set", { key_bindings: list });
}

function describe(action: string): string {
  return SHORTCUTS.find((d) => d.action === action)?.description ?? action;
}

function chordsText(chords: string[]): string {
  return chords.length ? chords.map((c) => formatChord(c, isMac)).join("  ") : "(none)";
}

function actionOrExit(query: string): string {
  const r = resolveAction(query);
  if (r.ok) {
    if (SHORTCUTS.find((d) => d.action === r.action)?.fixed) fail(`${r.action} is read by its page directly and can't be rebound.`);
    return r.action;
  }
  if (r.matches.length === 0) fail(`No action matches "${query}". List them with: cast shortcuts`);
  fail(`"${query}" matches ${r.matches.length} actions; name one:\n${r.matches.slice(0, 15).map((a) => `  ${a.padEnd(26)} ${describe(a)}`).join("\n")}`);
}

function chordOrExit(input: string): string {
  const r = parseChord(input);
  if (!r.ok) fail(`Can't read "${input}" as a chord: ${r.error}. Examples: ctrl+j, cmd+shift+k, alt+enter, ?`);
  return r.chord;
}

/** Refuses a chord another action holds unless told what to do about it. */
function checkConflicts(list: KeyBindingOverride[], action: string, chords: string[], opts: { steal?: boolean; keepBoth?: boolean }): string[] {
  const live = applyKeyBindings(SHORTCUTS, list, isMac);
  const steal: string[] = [];
  for (const chord of chords) {
    const reserved = reservedReason(chord, isMac, true);
    if (reserved) console.error(`Note: ${formatChord(chord, isMac)} may never reach codecast: ${reserved}.`);
    const hits = findConflicts(live, action, chord, isMac);
    if (hits.length === 0) continue;
    if (opts.steal) { steal.push(...hits.map((h) => h.action)); continue; }
    if (opts.keepBoth) continue;
    const names = hits.map((h) => `${h.description} (${h.action}${h.when ? `, in ${h.when}` : ""})`).join(", ");
    fail(`${formatChord(chord, isMac)} is already ${names}.\n  --steal       take it from them\n  --keep-both   bind it anyway; yours fires first`);
  }
  return [...new Set(steal)];
}

function printChange(action: string, before: string[], after: string[]): void {
  console.log(`${action}  ${describe(action)}\n  ${chordsText(before)}  →  ${chordsText(after)}`);
}

export function registerShortcutsCommand(program: Command, deps: PublishDeps): void {
  const shortcuts = program
    .command("shortcuts")
    .alias("hotkeys")
    .description(commandGroup("shortcuts").description)
    .argument("[query]", "Filter by action id or words in its name")
    .option("--changed", "Only the actions you rebound")
    .option("--json", "Every action with its default and current chords")
    .action(async (query: string | undefined, options: { changed?: boolean; json?: boolean }) => {
      const list = await readBindings(deps);
      const rows: { action: string; description: string; when?: string; defaults: string[]; current: string[]; changed: boolean; fixed: boolean }[] = [];
      for (const d of SHORTCUTS) {
        if (rows.some((r) => r.action === d.action)) continue;
        const current = currentChords(list, d.action, isMac);
        rows.push({
          action: d.action,
          description: d.description,
          when: d.when,
          defaults: defaultChords(d.action, isMac),
          current,
          changed: list.some((o) => o.action === d.action),
          fixed: !!d.fixed,
        });
      }
      const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const shown = rows.filter((r) => (!options.changed || r.changed) && words.every((w) => `${r.action} ${r.description}`.toLowerCase().includes(w)));
      if (options.json) {
        console.log(JSON.stringify(shown, null, 2));
        return;
      }
      if (shown.length === 0) {
        console.log(options.changed ? "No rebound actions; everything is on its defaults." : `No action matches "${query}".`);
        return;
      }
      let lastWhen: string | undefined | null = null;
      for (const r of shown) {
        if (r.when !== lastWhen) {
          console.log(`\n${r.when ?? "global"}`);
          lastWhen = r.when;
        }
        const mark = r.changed ? "*" : r.fixed ? "·" : " ";
        console.log(`${mark} ${r.action.padEnd(26)} ${chordsText(r.current).padEnd(16)} ${r.description}`);
      }
      const changed = rows.filter((r) => r.changed).length;
      console.log(`\n* rebound (${changed})   · read by its page, fixed`);
    });

  shortcuts
    .command("find")
    .description("Which actions a chord fires")
    .argument("<chord>")
    .action(async (input: string) => {
      const chord = chordOrExit(input);
      const live = applyKeyBindings(SHORTCUTS, await readBindings(deps), isMac);
      const hits = actionsForChord(live, chord, isMac);
      if (hits.length === 0) {
        console.log(`${formatChord(chord, isMac)} is free.`);
        return;
      }
      for (const d of hits) console.log(`${d.action.padEnd(26)} ${d.when ?? "global"}  ${d.description}`);
    });

  const addConflictOptions = (c: Command) => c
    .option("--steal", "Take the chord from any action that already has it")
    .option("--keep-both", "Bind it even where another action has it; yours fires first");

  addConflictOptions(shortcuts
    .command("set")
    .description("Replace an action's chords")
    .argument("<action>", "Action id or words from its name (\"next session\")")
    .argument("<chords...>", "One or more chords: ctrl+j, cmd+shift+k, alt+enter, ?"))
    .action(async (query: string, inputs: string[], opts: { steal?: boolean; keepBoth?: boolean }) => {
      const action = actionOrExit(query);
      const chords = inputs.map(chordOrExit);
      const list = await readBindings(deps);
      const before = currentChords(list, action, isMac);
      const steal = checkConflicts(list, action, chords, opts);
      const next = setActionChords(list, action, chords, isMac, steal);
      await writeBindings(deps, next);
      printChange(action, before, currentChords(next, action, isMac));
      for (const other of steal) printChange(other, currentChords(list, other, isMac), currentChords(next, other, isMac));
    });

  addConflictOptions(shortcuts
    .command("add")
    .description("Add a chord to an action, keeping its others")
    .argument("<action>")
    .argument("<chord>"))
    .action(async (query: string, input: string, opts: { steal?: boolean; keepBoth?: boolean }) => {
      const action = actionOrExit(query);
      const chord = chordOrExit(input);
      const list = await readBindings(deps);
      const before = currentChords(list, action, isMac);
      const steal = checkConflicts(list, action, [chord], opts);
      const next = setActionChords(list, action, [...before, chord], isMac, steal);
      await writeBindings(deps, next);
      printChange(action, before, currentChords(next, action, isMac));
      for (const other of steal) printChange(other, currentChords(list, other, isMac), currentChords(next, other, isMac));
    });

  shortcuts
    .command("unbind")
    .description("Leave an action with no chord")
    .argument("<action>")
    .action(async (query: string) => {
      const action = actionOrExit(query);
      const list = await readBindings(deps);
      const before = currentChords(list, action, isMac);
      const next = setActionChords(list, action, [], isMac);
      await writeBindings(deps, next);
      printChange(action, before, []);
    });

  shortcuts
    .command("reset")
    .description("Put an action, or everything with --all, back on its defaults")
    .argument("[action]")
    .option("--all", "Every action")
    .action(async (query: string | undefined, opts: { all?: boolean }) => {
      if (!query && !opts.all) fail("Name an action, or pass --all.");
      const list = await readBindings(deps);
      if (opts.all) {
        await writeBindings(deps, []);
        console.log(list.length ? `Reset ${list.length} action${list.length === 1 ? "" : "s"} to defaults.` : "Everything was already on its defaults.");
        return;
      }
      const action = actionOrExit(query!);
      const before = currentChords(list, action, isMac);
      await writeBindings(deps, resetAction(list, action));
      printChange(action, before, defaultChords(action, isMac));
    });
}
