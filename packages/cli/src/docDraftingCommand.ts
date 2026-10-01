import type { Command } from "commander";
import {
  FLAG_LABELS,
  LAB_FLAGS,
  LAB_TRIMS,
  TRIM_REASON,
  DraftTargetError,
  addAlternatives,
  clearFlags,
  describeDrafts,
  flagText,
  ghostText,
  makeCuts,
  pickAlternative,
  reviveText,
  settleAlternatives,
  stripDrafting,
  wordCount,
  dropAlternative,
  locate,
} from "@codecast/shared/docs";
import { c } from "./colors.js";
import { stdinText } from "./sendBody.js";

// `cast doc` drafting verbs: the same editing aids the doc page has
// (alternatives, ghosts, the Overflow, the Lab), on the doc's stored markdown,
// so an agent drafts the way a writer does and the writer sees it live: every
// write resets the collab snapshot, and open editors reload with the marks.
// The markup and its transforms live in @codecast/shared/docs (drafting).

export interface DocDraftingDeps {
  post: (path: string, body: Record<string, any>) => Promise<any>;
  sessionId: () => string | null | undefined;
}

/**
 * A model wrote it unless a person is at the keyboard. An agent's versions get
 * the bot glyph in the panel; `--human` / `--ai` override.
 */
function byModel(options: { human?: boolean; ai?: boolean }): boolean {
  if (options.ai) return true;
  if (options.human) return false;
  return !process.stdout.isTTY;
}

function nth(options: { nth?: string }): number | undefined {
  return options.nth ? Math.max(1, parseInt(options.nth, 10) || 1) : undefined;
}

async function load(deps: DocDraftingDeps, id: string): Promise<{ content: string; title: string; overflow: string }> {
  const doc = await deps.post("/cli/docs/get", { id });
  if (!doc) fail("Doc not found");
  return { content: doc.content ?? "", title: doc.title ?? "", overflow: doc.overflow ?? "" };
}

async function save(deps: DocDraftingDeps, id: string, fields: { content?: string; overflow?: string }) {
  await deps.post("/cli/docs/update", { id, session_id: deps.sessionId() ?? undefined, ...fields });
}

function fail(message: string): never {
  console.error(`${c.red}error${c.reset} ${message}`);
  process.exit(1);
}

/** Run a markdown transform, turning a target that cannot be found into a clear error. */
function transform(fn: () => string): string {
  try {
    return fn();
  } catch (e) {
    if (e instanceof DraftTargetError) fail(e.message);
    throw e;
  }
}

function printDrafts(drafts: ReturnType<typeof describeDrafts>) {
  if (!drafts.length) {
    console.log(`${c.dim}No drafting marks: no alternatives, ghosts or Lab marks.${c.reset}`);
    return;
  }
  for (const d of drafts) {
    if (d.kind === "alts") {
      console.log(`${c.cyan}alternatives${c.reset} "${d.shown}"${d.at > 0 ? ` ${c.dim}(a variation; the original is 0)${c.reset}` : ""}`);
      d.versions.forEach((v, i) => {
        const mark = i === d.at ? `${c.green}▸${c.reset}` : " ";
        const who = v.ai ? `${c.dim}ai${c.reset} ` : "   ";
        console.log(`   ${mark} ${c.dim}${i}${c.reset} ${who}${v.t}`);
      });
    } else if (d.kind === "ghost") {
      const label = d.reason === TRIM_REASON ? "proposed cut" : d.reason ? `ghost (${d.reason})` : "ghost";
      console.log(`${c.yellow}${label}${c.reset} ${c.dim}"${d.text}"${c.reset}`);
    } else {
      console.log(`${c.magenta}${FLAG_LABELS[d.flag] ?? d.flag}${c.reset} "${d.text}"${d.note ? ` ${c.dim}${d.note}${c.reset}` : ""}`);
    }
  }
}

export function registerDocDraftingCommands(doc: Command, deps: DocDraftingDeps): void {
  doc
    .command("drafts")
    .description(
      "List a document's drafting marks: alternatives (with every version), ghosted text, proposed cuts and Lab marks\n\n" +
        "The marks live in the markdown as <span data-alts|data-ghost|data-flag> and show in the doc page with drafting on.",
    )
    .argument("<id>", "Document ID")
    .option("--json", "Machine-readable output")
    .action(async (id: string, options: any) => {
      const { content } = await load(deps, id);
      if (options.json) {
        console.log(JSON.stringify(describeDrafts(content), null, 2));
        return;
      }
      printDrafts(describeDrafts(content));
    });

  doc
    .command("alt")
    .alias("alts")
    .description(
      "Keep other versions of a word, sentence or paragraph, and choose which one shows\n\n" +
        "The target is the exact text shown now. Versions join its list; the text it had first stays version 0.\n\n" +
        "Examples:\n" +
        '  cast doc alt <id> "tension" "pressure" "struggle"   # add versions\n' +
        '  cast doc alt <id> "tension" --pick 2               # show version 2 in place\n' +
        '  cast doc alt <id> "struggle" --settle              # keep what shows, drop the rest\n' +
        '  cast doc alt <id> "struggle" --drop 1              # drop one version\n' +
        "  cast doc drafts <id>                               # see every set",
    )
    .argument("<id>", "Document ID")
    .argument("<text>", stdinText("The text as it shows now"))
    .argument("[versions...]", "Versions to add")
    .option("--pick <n>", "Show version n (0 is the original)")
    .option("--settle [n]", "Keep the version shown (or version n) as plain text and drop the others")
    .option("--drop <n>", "Drop version n (not the one showing)")
    .option("--nth <n>", "Which occurrence of the text, when it appears more than once")
    .option("--ai", "Mark the added versions as a model's")
    .option("--human", "Mark the added versions as a person's")
    .action(async (id: string, text: string, versions: string[], options: any) => {
      const { content } = await load(deps, id);
      const occurrence = nth(options);
      let next = content;
      if (versions.length) next = transform(() => addAlternatives(next, text, versions, { ai: byModel(options), occurrence }));
      if (options.drop !== undefined) next = transform(() => dropAlternative(next, text, parseInt(options.drop, 10), { occurrence }));
      if (options.pick !== undefined) next = transform(() => pickAlternative(next, text, parseInt(options.pick, 10), { occurrence }));
      if (options.settle !== undefined) {
        const keep = options.settle === true ? undefined : parseInt(options.settle, 10);
        const shown = options.pick !== undefined ? shownAfterPick(next, text) : text;
        next = transform(() => settleAlternatives(next, shown, { occurrence, keep }));
      }
      if (next === content) fail("Nothing to change: give versions to add, or --pick / --settle / --drop");
      await save(deps, id, { content: next });
      const set = describeDrafts(next).find((d) => d.kind === "alts" && d.versions.some((v) => v.t === text || versions.includes(v.t)));
      console.log(`${c.green}ok${c.reset} ${c.cyan}${id}${c.reset}`);
      if (set) printDrafts([set]);
    });

  doc
    .command("ghost")
    .description(
      "Dim text back without deleting it: it stays in the doc, faded, until revived or cut\n\n" +
        "With --reason trim it is a proposed cut the writer keeps (click) or makes (cast doc cuts).",
    )
    .argument("<id>", "Document ID")
    .argument("<text>", stdinText("Exact text to ghost"))
    .option("--reason <reason>", `Why: "${TRIM_REASON}" marks a proposed cut`)
    .option("--nth <n>", "Which occurrence of the text")
    .action(async (id: string, text: string, options: any) => {
      const { content } = await load(deps, id);
      const next = transform(() => ghostText(content, text, { reason: options.reason ?? "", occurrence: nth(options) }));
      if (next === content) fail(`"${text}" is already ghosted`);
      await save(deps, id, { content: next });
      console.log(`${c.green}ok${c.reset} Ghosted ${wordCount(text)} word${wordCount(text) === 1 ? "" : "s"} in ${c.cyan}${id}${c.reset}`);
    });

  doc
    .command("revive")
    .description("Bring ghosted text back (one stretch, or every ghost with --all)")
    .argument("<id>", "Document ID")
    .argument("[text]", stdinText("Ghosted text to revive"))
    .option("--all", "Revive every ghost")
    .option("--reason <reason>", `Only ghosts with this reason (e.g. ${TRIM_REASON})`)
    .option("--nth <n>", "Which occurrence of the text")
    .action(async (id: string, text: string | undefined, options: any) => {
      if (!text && !options.all && !options.reason) fail("Give the ghosted text, or --all");
      const { content } = await load(deps, id);
      const next = transform(() => reviveText(content, text, { reason: options.reason, occurrence: nth(options) }));
      if (next === content) fail("Nothing ghosted matched");
      await save(deps, id, { content: next });
      console.log(`${c.green}ok${c.reset} Revived in ${c.cyan}${id}${c.reset}`);
    });

  doc
    .command("cuts")
    .description("Make the proposed cuts: delete text ghosted as a trim (or every ghost with --all)")
    .argument("<id>", "Document ID")
    .option("--all", "Delete every ghosted stretch, not only proposed cuts")
    .action(async (id: string, options: any) => {
      const { content } = await load(deps, id);
      const before = wordCount(stripDrafting(content));
      const next = makeCuts(content, options.all ? "*" : TRIM_REASON);
      if (next === content) fail(options.all ? "Nothing is ghosted" : "No proposed cuts");
      await save(deps, id, { content: next });
      console.log(`${c.green}ok${c.reset} ${before} → ${wordCount(stripDrafting(next))} words in ${c.cyan}${id}${c.reset}`);
    });

  doc
    .command("flag")
    .description(`Mark text with a finding (${LAB_FLAGS.map((f) => f.flag).join(", ")}); --clear removes marks`)
    .argument("<id>", "Document ID")
    .argument("[text]", stdinText("Exact text to mark"))
    .argument("[kind]", "Kind of finding", "weak")
    .option("--note <text>", "Why, in a few words")
    .option("--nth <n>", "Which occurrence of the text")
    .option("--clear [kind]", "Remove marks (all, or one kind)")
    .action(async (id: string, text: string | undefined, kind: string, options: any) => {
      const { content } = await load(deps, id);
      const next = options.clear !== undefined
        ? clearFlags(content, options.clear === true ? undefined : options.clear)
        : text
          ? transform(() => flagText(content, text, kind, { note: options.note, occurrence: nth(options) }))
          : fail("Give the text to mark, or --clear");
      if (next === content) fail("Nothing to change");
      await save(deps, id, { content: next });
      console.log(`${c.green}ok${c.reset} ${options.clear !== undefined ? "Cleared marks" : `Marked as ${FLAG_LABELS[kind] ?? kind}`} in ${c.cyan}${id}${c.reset}`);
    });

  doc
    .command("overflow")
    .description(
      "The Overflow: writing kept beside a doc rather than in it (cuts, notes, words to use later)\n\n" +
        "Examples:\n" +
        "  cast doc overflow <id>                         # print it\n" +
        '  cast doc overflow <id> --append "an aside"     # add a paragraph\n' +
        '  cast doc overflow <id> --stash "exact text"    # move text out of the doc into it\n' +
        "  cast doc overflow <id> --set - <<'EOF'         # replace it\n" +
        "  cast doc overflow <id> --clear",
    )
    .argument("<id>", "Document ID")
    .option("--set <text>", stdinText("Replace the Overflow"))
    .option("--append <text>", stdinText("Add a paragraph to the Overflow"))
    .option("--stash <text>", stdinText("Move this exact text from the doc into the Overflow"))
    .option("--nth <n>", "Which occurrence of the stashed text")
    .option("--clear", "Empty the Overflow")
    .action(async (id: string, options: any) => {
      const { content, overflow } = await load(deps, id);
      const join = (a: string, b: string) => (a.trim() ? `${a.replace(/\s+$/, "")}\n\n${b.trim()}` : b.trim());
      if (options.set === undefined && options.append === undefined && options.stash === undefined && !options.clear) {
        console.log(overflow.trim() ? overflow : `${c.dim}The Overflow is empty.${c.reset}`);
        return;
      }
      if (options.clear) {
        await save(deps, id, { overflow: "" });
      } else if (options.set !== undefined) {
        await save(deps, id, { overflow: options.set });
      } else if (options.append !== undefined) {
        await save(deps, id, { overflow: join(overflow, options.append) });
      } else {
        const text: string = options.stash;
        const range = transform(() => {
          const r = locate(content, text, nth(options) ?? 1);
          return `${r.start}:${r.end}`;
        });
        const [start, end] = range.split(":").map(Number);
        const rest = (content.slice(0, start) + content.slice(end)).replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n");
        await save(deps, id, { content: rest, overflow: join(overflow, stripDrafting(text)) });
      }
      console.log(`${c.green}ok${c.reset} Overflow updated on ${c.cyan}${id}${c.reset}`);
    });

  doc
    .command("lab")
    .description(
      "Run a Lab tool on a doc with the server's model. Nothing is rewritten: results land as drafting marks\n\n" +
        "Tools:\n" +
        `  trim [--level ${LAB_TRIMS.map((t) => t.level).join("|")}]   ghost what could go (proposed cuts)\n` +
        "  typos                    fixes as versions you can flip back\n" +
        `  flag <${LAB_FLAGS.map((f) => f.flag).join("|")}>   mark findings\n` +
        '  alts "<text>"            suggest versions for one stretch\n\n' +
        "Then: cast doc drafts <id> to read the result, cast doc cuts <id> to make the cuts.",
    )
    .argument("<id>", "Document ID")
    .argument("<tool>", "trim, typos, flag or alts")
    .argument("[arg]", "The flag kind, or the text for alts")
    .option("--level <level>", "Trim level", "slight")
    .option("--nth <n>", "Which occurrence of the text (alts)")
    .action(async (id: string, tool: string, arg: string | undefined, options: any) => {
      const body: Record<string, any> = { id, session_id: deps.sessionId() ?? undefined };
      if (tool === "trim") Object.assign(body, { tool: "trim", level: options.level });
      else if (tool === "typos") body.tool = "typos";
      else if (tool === "flag") Object.assign(body, { tool: "flag", flag: arg ?? fail(`flag needs a kind: ${LAB_FLAGS.map((f) => f.flag).join(", ")}`) });
      else if (tool === "alts" || tool === "alternatives") Object.assign(body, { tool: "alternatives", target: arg ?? fail("alts needs the text"), occurrence: nth(options) });
      else fail(`Unknown tool "${tool}": use trim, typos, flag or alts`);
      const r = await deps.post("/cli/docs/lab", body);
      const missed = r.missed?.length ? ` ${c.dim}(${r.missed.length} not found in the text, skipped)${c.reset}` : "";
      if (tool === "trim") {
        const pct = r.words_before ? Math.round(((r.words_after - r.words_before) / r.words_before) * 100) : 0;
        console.log(`${c.green}ok${c.reset} ${r.applied} proposed cut${r.applied === 1 ? "" : "s"}: ${r.words_before} → ${r.words_after} words (${pct}%)${missed}`);
        console.log(`${c.dim}Review: cast doc drafts ${id} · make them: cast doc cuts ${id} · undo: cast doc revive ${id} --reason trim${c.reset}`);
      } else {
        console.log(`${c.green}ok${c.reset} ${r.applied} landed${missed}. ${c.dim}cast doc drafts ${id}${c.reset}`);
      }
    });
}

/** The text a set shows after --pick moved it: found by the original it still lists. */
function shownAfterPick(md: string, original: string): string {
  const set = describeDrafts(md).find((d) => d.kind === "alts" && d.versions.some((v) => v.t === original));
  return set && set.kind === "alts" ? set.shown : original;
}
